/**
 * Orphan deletion: the counted confirmation between a plan and the settings.
 *
 * Ticket 06. The dry run already reports entries that exist in no registered
 * collection; this module is the only thing allowed to remove them, and only
 * after a confirmation that states how many entries and how many bytes go. The
 * tests are behavioural: they hand the decision the plan and a real settings
 * object, hand the executor spies for the confirmation, the deletion and the
 * save, and assert what the user's data looks like afterwards.
 */

import { describe, it, expect, vi } from 'vitest';

import {
    decideChunkMetaOrphanDelete,
    executeChunkMetaOrphanDelete,
} from '../core/chunk-meta-orphan-delete.js';
import { settingsByteSize } from './fixtures/settings-bytes.js';

/** A trusted plan with two settings entries absent from every collection. */
function orphanPlan({ orphan = ['gone', 'vanished'], trusted = true } = {}) {
    return {
        trusted,
        untrustedReason: trusted ? null : 'failed',
        entries: 3,
        counts: { redundant: 1, patch: 0, orphan: orphan.length, skipped: 0 },
        skippedByReason: { unverified: 0, clientOnly: 0 },
        redundant: [{ hash: 'kept', collections: ['qdrant:A'] }],
        deletable: [{ hash: 'kept', collections: ['qdrant:A'] }],
        patch: [],
        orphan: orphan.map(hash => ({ hash })),
        skipped: [],
        perCollection: [],
        coverage: { registered: 1, scanned: 1, chunksRead: 2 },
    };
}

/** Settings holding one live entry plus the orphans the plan names. */
function orphanSettings() {
    return {
        chunk_size: 500,
        'vectfox_chunk_meta_kept': { context: 'still in a collection' },
        'vectfox_chunk_meta_gone': { context: 'belongs to nothing' },
        'vectfox_chunk_meta_vanished': { context: '也属于空的集合', keywords: ['空'] },
    };
}

describe('orphan deletion — the decision', () => {
    it('names the orphan hashes and the size removing them releases', () => {
        const settings = orphanSettings();
        const before = settingsByteSize(settings);
        const after = settingsByteSize({
            chunk_size: 500,
            'vectfox_chunk_meta_kept': { context: 'still in a collection' },
        });

        const decision = decideChunkMetaOrphanDelete({ plan: orphanPlan(), settings });

        expect(decision.status).toBe('ready');
        expect(decision.trusted).toBe(true);
        expect(decision.hashes).toEqual(['gone', 'vanished']);
        expect(decision.entries).toBe(2);
        // Multibyte values are counted as the bytes that cross the wire.
        expect(decision.bytes).toBe(before - after);
        expect(decision.bytes).toBeGreaterThan(0);
    });

    it('reports nothing to delete when a trusted plan found no orphans', () => {
        const settings = orphanSettings();
        const decision = decideChunkMetaOrphanDelete({
            plan: orphanPlan({ orphan: [] }),
            settings,
        });

        expect(decision.status).toBe('empty');
        expect(decision.hashes).toEqual([]);
        expect(decision.entries).toBe(0);
        expect(decision.bytes).toBe(0);
    });

    it('refuses an untrusted plan even if it carries orphan records', () => {
        // A hand-built plan cannot bypass the scan-completeness rule.
        const decision = decideChunkMetaOrphanDelete({
            plan: orphanPlan({ trusted: false }),
            settings: orphanSettings(),
        });

        expect(decision.status).toBe('refused');
        expect(decision.trusted).toBe(false);
        expect(decision.hashes).toEqual([]);
        expect(decision.bytes).toBe(0);
    });

    it('counts and prices a single orphan exactly', () => {
        const settings = {
            chunk_size: 500,
            'vectfox_chunk_meta_only': { context: 'the only one' },
        };
        const decision = decideChunkMetaOrphanDelete({
            plan: orphanPlan({ orphan: ['only'] }),
            settings,
        });
        const expected = settingsByteSize(settings) - settingsByteSize({ chunk_size: 500 });

        expect(decision.status).toBe('ready');
        expect(decision.entries).toBe(1);
        expect(decision.bytes).toBe(expected);
    });

    it('drops a hash whose settings entry is already gone, so count and size agree', () => {
        const settings = orphanSettings();
        delete settings['vectfox_chunk_meta_vanished'];

        const decision = decideChunkMetaOrphanDelete({ plan: orphanPlan(), settings });

        expect(decision.status).toBe('ready');
        expect(decision.hashes).toEqual(['gone']);
        expect(decision.entries).toBe(1);
        expect(decision.bytes).toBe(
            settingsByteSize(settings)
            - settingsByteSize({
                chunk_size: 500,
                'vectfox_chunk_meta_kept': { context: 'still in a collection' },
                'vectfox_chunk_meta_vanished': undefined,
            }),
        );
    });

    it('reports empty when the plan names entries that are all already gone', () => {
        const settings = orphanSettings();
        delete settings['vectfox_chunk_meta_gone'];
        delete settings['vectfox_chunk_meta_vanished'];

        const decision = decideChunkMetaOrphanDelete({ plan: orphanPlan(), settings });

        expect(decision.status).toBe('empty');
        expect(decision.hashes).toEqual([]);
        expect(decision.bytes).toBe(0);
    });

    it('prices a key JSON never wrote at zero and still counts it as removable', () => {
        // A settings value of undefined is dropped by JSON.stringify, so the
        // key occupies no bytes; deleting it must not claim a release, and it
        // must not earn a separator correction either.
        const settings = { chunk_size: 500, 'vectfox_chunk_meta_ghost': undefined };

        const decision = decideChunkMetaOrphanDelete({
            plan: orphanPlan({ orphan: ['ghost'] }),
            settings,
        });

        expect(decision.status).toBe('ready');
        expect(decision.entries).toBe(1);
        expect(decision.bytes).toBe(0);
        expect(decision.serializableKeys).toBe(1);
        expect(decision.costs).toEqual({ ghost: 0 });
    });

    it('needs the plan from a completed scan', () => {
        expect(() => decideChunkMetaOrphanDelete({ plan: { orphan: [] }, settings: {} }))
            .toThrow(/completed scan/);
    });
});

/** A decision over a real settings object, with deletion wired to it. */
function harness(settings, { confirm = () => true, save } = {}) {
    const decision = decideChunkMetaOrphanDelete({ plan: orphanPlan(), settings });
    const deleted = [];
    const confirmDelete = vi.fn(confirm);
    const deleteEntry = vi.fn((hash) => {
        const key = `vectfox_chunk_meta_${hash}`;
        if (!(key in settings)) return false;
        delete settings[key];
        deleted.push(hash);
        return true;
    });
    const persistSettings = vi.fn(save);
    return { decision, deleted, confirmDelete, deleteEntry, persistSettings };
}

describe('orphan deletion — deleting only after confirmation', () => {
    it('deletes nothing when the user cancels', async () => {
        const settings = orphanSettings();
        const { decision, confirmDelete, deleteEntry, persistSettings } = harness(settings, {
            confirm: () => false,
        });

        const run = await executeChunkMetaOrphanDelete({
            decision,
            confirmDelete,
            deleteEntry,
            persistSettings,
        });

        expect(confirmDelete).toHaveBeenCalledTimes(1);
        expect(deleteEntry).not.toHaveBeenCalled();
        expect(persistSettings).not.toHaveBeenCalled();
        expect(run.status).toBe('cancelled');
        expect(run.counts.deleted).toBe(0);
        expect(run.entries).toBe(2);
        expect(run.bytes).toBeGreaterThan(0);
        // The dialog promised a size; a cancelled run released none of it.
        expect(run.releasedBytes).toBe(0);
        expect(settings['vectfox_chunk_meta_gone']).toBeDefined();
        expect(settings['vectfox_chunk_meta_vanished']).toBeDefined();
    });

    it('treats a missing or failing confirmation as no', async () => {
        const settings = orphanSettings();
        const decision = decideChunkMetaOrphanDelete({ plan: orphanPlan(), settings });
        const deleteEntry = vi.fn(() => true);

        const withoutConfirm = await executeChunkMetaOrphanDelete({ decision, deleteEntry });
        const throwingConfirm = await executeChunkMetaOrphanDelete({
            decision,
            deleteEntry,
            confirmDelete: () => { throw new Error('dialog unavailable'); },
        });

        expect(withoutConfirm.status).toBe('cancelled');
        expect(throwingConfirm.status).toBe('cancelled');
        expect(deleteEntry).not.toHaveBeenCalled();
    });

    it('deletes exactly the orphan entries and saves once after them', async () => {
        const settings = orphanSettings();
        const before = settingsByteSize(settings);
        const { decision, deleted, confirmDelete, deleteEntry, persistSettings } = harness(settings);

        const run = await executeChunkMetaOrphanDelete({
            decision,
            confirmDelete,
            deleteEntry,
            persistSettings,
        });

        expect(deleted).toEqual(['gone', 'vanished']);
        expect(persistSettings).toHaveBeenCalledTimes(1);
        expect(persistSettings.mock.invocationCallOrder[0])
            .toBeGreaterThan(deleteEntry.mock.invocationCallOrder[1]);
        // Everything that is not an orphan stays, including the live entry.
        expect(settings).toEqual({
            chunk_size: 500,
            'vectfox_chunk_meta_kept': { context: 'still in a collection' },
        });
        expect(run.status).toBe('complete');
        expect(run.counts).toEqual({ deleted: 2, skipped: 0 });
        expect(run.entries).toBe(2);
        expect(run.releasedBytes).toBe(decision.bytes);
        expect(run.releasedBytes).toBe(before - settingsByteSize(settings));
        expect(run.error).toBeNull();
        expect(run.saveError).toBeNull();
    });

    it('reveals the count and size to the confirmation before deleting', async () => {
        const settings = orphanSettings();
        const { decision, confirmDelete, deleteEntry, persistSettings } = harness(settings);
        let seen = null;
        confirmDelete.mockImplementation((value) => {
            seen = value;
            return true;
        });

        await executeChunkMetaOrphanDelete({
            decision, confirmDelete, deleteEntry, persistSettings,
        });

        expect(seen.entries).toBe(2);
        expect(seen.bytes).toBe(decision.bytes);
        expect(seen.hashes).toEqual(['gone', 'vanished']);
    });

    it('refuses a hand-built untrusted decision that still names hashes', async () => {
        const settings = orphanSettings();
        const confirmDelete = vi.fn(() => true);
        const deleteEntry = vi.fn(() => true);
        const persistSettings = vi.fn();

        const run = await executeChunkMetaOrphanDelete({
            decision: { ...decideChunkMetaOrphanDelete({ plan: orphanPlan(), settings }), trusted: false },
            confirmDelete,
            deleteEntry,
            persistSettings,
        });

        expect(run.status).toBe('refused');
        expect(confirmDelete).not.toHaveBeenCalled();
        expect(deleteEntry).not.toHaveBeenCalled();
        expect(persistSettings).not.toHaveBeenCalled();
        expect(settings['vectfox_chunk_meta_gone']).toBeDefined();
    });

    it('does not confirm or save when there is nothing to delete', async () => {
        const settings = orphanSettings();
        const decision = decideChunkMetaOrphanDelete({ plan: orphanPlan({ orphan: [] }), settings });
        const confirmDelete = vi.fn(() => true);
        const deleteEntry = vi.fn(() => true);
        const persistSettings = vi.fn();

        const run = await executeChunkMetaOrphanDelete({
            decision, confirmDelete, deleteEntry, persistSettings,
        });

        expect(run.status).toBe('empty');
        expect(confirmDelete).not.toHaveBeenCalled();
        expect(deleteEntry).not.toHaveBeenCalled();
        expect(persistSettings).not.toHaveBeenCalled();
    });

    it('does not count an entry that was already gone, and still saves once', async () => {
        const settings = orphanSettings();
        const before = settingsByteSize(settings);
        const { decision, confirmDelete, deleteEntry, persistSettings } = harness(settings);
        deleteEntry.mockImplementation((hash) => {
            if (hash === 'gone') return false;
            delete settings[`vectfox_chunk_meta_${hash}`];
            return true;
        });

        const run = await executeChunkMetaOrphanDelete({
            decision, confirmDelete, deleteEntry, persistSettings,
        });

        expect(run.status).toBe('complete');
        expect(run.counts).toEqual({ deleted: 1, skipped: 1 });
        // Only the removed entry's bytes; the skipped one released nothing.
        expect(run.releasedBytes).toBe(before - settingsByteSize(settings));
        expect(run.releasedBytes).toBeLessThan(decision.bytes);
        expect(persistSettings).toHaveBeenCalledTimes(1);
    });

    it('reports a failed save beside the deletions instead of throwing', async () => {
        const settings = orphanSettings();
        const { decision, confirmDelete, deleteEntry } = harness(settings);

        const run = await executeChunkMetaOrphanDelete({
            decision,
            confirmDelete,
            deleteEntry,
            persistSettings: () => { throw new Error('disk full'); },
        });

        expect(run.status).toBe('complete');
        expect(run.counts.deleted).toBe(2);
        expect(run.saveError).toBe('disk full');
        expect(run.error).toBeNull();
    });

    it('stops at a failed deletion, keeps what it removed, and saves it', async () => {
        const settings = orphanSettings();
        const { decision, deleted, confirmDelete, deleteEntry, persistSettings } = harness(settings);
        deleteEntry.mockImplementation((hash) => {
            if (hash === 'vanished') throw new Error('settings object is frozen');
            delete settings[`vectfox_chunk_meta_${hash}`];
            deleted.push(hash);
            return true;
        });

        const run = await executeChunkMetaOrphanDelete({
            decision, confirmDelete, deleteEntry, persistSettings,
        });

        expect(run.status).toBe('aborted');
        expect(run.error).toBe('settings object is frozen');
        expect(run.counts.deleted).toBe(1);
        expect(deleted).toEqual(['gone']);
        expect(run.releasedBytes).toBeGreaterThan(0);
        expect(run.releasedBytes).toBeLessThan(decision.bytes);
        expect(persistSettings).toHaveBeenCalledTimes(1);
        expect(settings['vectfox_chunk_meta_vanished']).toBeDefined();
    });

    it('reports an entry that disappears after the decision as skipped', async () => {
        // The decision was built while both keys existed; another writer removed
        // one before the executor reached it.
        const settings = orphanSettings();
        const decision = {
            trusted: true,
            hashes: ['gone', 'vanished'],
            entries: 2,
            bytes: 82,
            costs: { gone: 40, vanished: 40 },
            serializableKeys: 4,
        };
        const confirmDelete = vi.fn(() => true);
        const deleteEntry = vi.fn((hash) => {
            if (hash === 'vanished') return false;
            delete settings[`vectfox_chunk_meta_${hash}`];
            return true;
        });
        const persistSettings = vi.fn();

        const run = await executeChunkMetaOrphanDelete({
            decision, confirmDelete, deleteEntry, persistSettings,
        });

        expect(run.status).toBe('complete');
        expect(run.counts).toEqual({ deleted: 1, skipped: 1 });
        // One entry's cost plus the comma that separated it; the skipped one
        // released nothing and the object still holds other keys.
        expect(run.releasedBytes).toBe(41);
        expect(persistSettings).toHaveBeenCalledTimes(1);
    });

    it('reports no release for a key whose value JSON dropped', async () => {
        const settings = { chunk_size: 500, 'vectfox_chunk_meta_ghost': undefined };
        const decision = decideChunkMetaOrphanDelete({
            plan: orphanPlan({ orphan: ['ghost'] }),
            settings,
        });
        const persistSettings = vi.fn();

        const run = await executeChunkMetaOrphanDelete({
            decision,
            confirmDelete: () => true,
            deleteEntry: (hash) => {
                delete settings[`vectfox_chunk_meta_${hash}`];
                return true;
            },
            persistSettings,
        });

        expect(run.counts.deleted).toBe(1);
        expect(run.releasedBytes).toBe(0);
    });

    it('reports per-entry progress', async () => {
        const settings = orphanSettings();
        const { decision, confirmDelete, deleteEntry, persistSettings } = harness(settings);
        const progress = [];

        await executeChunkMetaOrphanDelete({
            decision,
            confirmDelete,
            deleteEntry,
            persistSettings,
            onProgress: value => progress.push(value),
        });

        expect(progress).toEqual([
            { done: 1, total: 2, deleted: 1 },
            { done: 2, total: 2, deleted: 2 },
        ]);
    });

    it('needs the decision from a completed plan', async () => {
        await expect(executeChunkMetaOrphanDelete({ decision: { entries: 1 } }))
            .rejects.toThrow(/completed plan/);
    });
});
