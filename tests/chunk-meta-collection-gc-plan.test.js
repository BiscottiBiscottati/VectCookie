/**
 * Chunk-metadata garbage collection — the planner and the executor (ticket 08).
 *
 * Pure seam: `planCollectionChunkMetaGc` takes the legacy settings entries, the
 * hashes a deletion provably covers, and one scan per *other* registered
 * collection; `executeCollectionChunkMetaGc` applies the plan. Nothing here
 * touches a backend, so every safety rule can be stated without a fake
 * transport:
 *
 *   - an entry is collectable only when the deletion covers its chunk,
 *   - a content-derived hash shared with another collection keeps its entry,
 *   - a collection that could not be read blocks every deletion,
 *   - other collections' entries are never candidates,
 *   - nothing is saved when nothing is removed.
 */

import { describe, it, expect, vi } from 'vitest';

import {
    executeCollectionChunkMetaGc,
    planCollectionChunkMetaGc,
} from '../core/chunk-meta-collection-gc.js';

function collection(id, backend = 'qdrant') {
    return { registryKey: `${backend}:${id}`, collectionId: id };
}

function scan(entry, hashes = [], status = 'ok') {
    const target = entry.registryKey ? entry : collection(entry);
    return {
        registryKey: target.registryKey,
        collectionId: target.collectionId,
        status,
        hashes: new Set(hashes),
        error: status === 'failed' ? 'collection is unreachable' : null,
    };
}

const A = collection('A');
const B = collection('B');

describe('collection GC plan — which entries a deletion may collect', () => {
    it('collects an entry the deletion covers and no other collection holds', () => {
        const plan = planCollectionChunkMetaGc({
            entries: ({ onlyA: { context: 'only here' } }),
            deletedHashes: ['onlyA'],
            collections: [B],
            scans: [scan(B, ['other'])],
        });

        expect(plan.trusted).toBe(true);
        expect(plan.counts.candidates).toBe(1);
        expect(plan.deletable).toEqual(['onlyA']);
        expect(plan.kept).toEqual([]);
    });

    it('keeps a shared hash when the same text lives in another collection', () => {
        const plan = planCollectionChunkMetaGc({
            entries: ({ shared: { context: 'about dragons' }, onlyA: {} }),
            // Content-derived hashes: the same text in A and B is one hash.
            deletedHashes: ['shared', 'onlyA'],
            collections: [B],
            scans: [scan(B, ['shared'])],
        });

        expect(plan.deletable).toEqual(['onlyA']);
        expect(plan.kept).toEqual([{ hash: 'shared', reason: 'shared' }]);
        expect(plan.counts).toMatchObject({ candidates: 2, deletable: 1, shared: 1 });
    });

    it('never touches an entry no deletion covers', () => {
        const plan = planCollectionChunkMetaGc({
            entries: ({ onlyA: {}, onlyB: { context: 'kept' } }),
            deletedHashes: ['onlyA'],
            collections: [B],
            scans: [scan(B, ['onlyB'])],
        });

        expect(plan.deletable).toEqual(['onlyA']);
        // `onlyB` is not even a candidate: its collection was never deleted.
        expect(plan.counts.candidates).toBe(1);
        expect(plan.kept).toEqual([]);
    });

    it('keeps every candidate when any other collection could not be read', () => {
        const plan = planCollectionChunkMetaGc({
            entries: ({ onlyA: {}, shared: {} }),
            deletedHashes: ['onlyA', 'shared'],
            collections: [B, collection('C')],
            scans: [scan(B, [], 'failed'), scan(collection('C'), [])],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.untrustedReason).toBe('failed');
        expect(plan.deletable).toEqual([]);
        expect(plan.kept.map(record => record.reason).sort())
            .toEqual(['unverified', 'unverified']);
        expect(plan.counts.unverified).toBe(2);
    });

    it('keeps every candidate when a registered collection was never scanned', () => {
        const plan = planCollectionChunkMetaGc({
            entries: ({ onlyA: {} }),
            deletedHashes: ['onlyA'],
            collections: [B, collection('C')],
            scans: [scan(B, [])],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.untrustedReason).toBe('unscanned');
        expect(plan.deletable).toEqual([]);
    });

    it('reports nothing to collect when no entry belongs to the deleted collection', () => {
        const plan = planCollectionChunkMetaGc({
            entries: ({ onlyB: {} }),
            deletedHashes: ['onlyA'],
            collections: [B],
            scans: [scan(B, ['onlyB'])],
        });

        expect(plan.trusted).toBe(true);
        expect(plan.counts.candidates).toBe(0);
        expect(plan.deletable).toEqual([]);
    });

    it('collects an entry that holds client-only data, because its chunk is gone', () => {
        // The sweep keeps `summaries` entries: the chunk is alive and no payload
        // can carry that field. Here the chunk was deleted, so the data is dead
        // and nothing could ever read it again.
        const plan = planCollectionChunkMetaGc({
            entries: ({ onlyA: { summaries: ['the only copy'] } }),
            deletedHashes: ['onlyA'],
            collections: [B],
            scans: [scan(B, [])],
        });

        expect(plan.deletable).toEqual(['onlyA']);
    });

    it('keeps a client-only entry whose hash another collection still holds', () => {
        const plan = planCollectionChunkMetaGc({
            entries: ({ shared: { summaries: ['still readable'] } }),
            deletedHashes: ['shared'],
            collections: [B],
            scans: [scan(B, ['shared'])],
        });

        expect(plan.deletable).toEqual([]);
        expect(plan.kept).toEqual([{ hash: 'shared', reason: 'shared' }]);
    });

    it('is trusted with no other collections, and names them in the report', () => {
        const plan = planCollectionChunkMetaGc({
            entries: ({ onlyA: {} }),
            deletedHashes: ['onlyA'],
            collections: [],
            scans: [],
        });

        expect(plan.trusted).toBe(true);
        expect(plan.deletable).toEqual(['onlyA']);
        expect(plan.collections).toEqual([]);
    });

    it('is not trusted when an empty scan serves a registered collection', () => {
        // Absence in an empty *scan* is proof, but absence in an empty *scan
        // list* for a registered collection is not a scan at all.
        const plan = planCollectionChunkMetaGc({
            entries: ({ onlyA: {} }),
            deletedHashes: ['onlyA'],
            collections: [B],
            scans: [],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.deletable).toEqual([]);
    });

    it('does not mutate its inputs', () => {
        const entryMap = { shared: {}, onlyA: {} };
        const hashes = ['shared', 'onlyA'];
        const scans = [scan(B, ['shared'])];

        planCollectionChunkMetaGc({
            entries: entryMap,
            deletedHashes: hashes,
            collections: [B],
            scans,
        });

        expect(entryMap).toEqual({ shared: {}, onlyA: {} });
        expect(hashes).toEqual(['shared', 'onlyA']);
        expect([...scans[0].hashes]).toEqual(['shared']);
    });
});

describe('collection GC executor', () => {
    function plan(overrides = {}) {
        return planCollectionChunkMetaGc({
            entries: ({ onlyA: {}, onlyA2: {} }),
            deletedHashes: ['onlyA', 'onlyA2'],
            collections: [],
            scans: [],
            ...overrides,
        });
    }

    function settingsWith(map) {
        const settings = {};
        for (const [hash, metadata] of Object.entries(map)) {
            settings[`vectfox_chunk_meta_${hash}`] = metadata;
        }
        return settings;
    }

    function deleteEntryFrom(settings) {
        return vi.fn((hash) => {
            const key = `vectfox_chunk_meta_${hash}`;
            if (!(key in settings)) return false;
            delete settings[key];
            return true;
        });
    }

    it('removes exactly the planned entries and saves once', async () => {
        const settings = settingsWith({ onlyA: {}, onlyA2: {}, onlyB: {} });
        const deleteEntry = deleteEntryFrom(settings);
        const persistSettings = vi.fn();

        const run = await executeCollectionChunkMetaGc({
            plan: plan(),
            deleteEntry,
            persistSettings,
        });

        expect(deleteEntry.mock.calls.map(([hash]) => hash).sort())
            .toEqual(['onlyA', 'onlyA2']);
        expect(run.status).toBe('complete');
        expect(run.counts).toEqual({ deleted: 2, skipped: 0 });
        expect(persistSettings).toHaveBeenCalledTimes(1);
        expect(settings.vectfox_chunk_meta_onlyB).toEqual({});
    });

    it('deletes nothing and saves nothing when the plan is empty', async () => {
        const deleteEntry = vi.fn();
        const persistSettings = vi.fn();

        const run = await executeCollectionChunkMetaGc({
            plan: plan({ deletedHashes: [] }),
            deleteEntry,
            persistSettings,
        });

        expect(run.status).toBe('empty');
        expect(deleteEntry).not.toHaveBeenCalled();
        expect(persistSettings).not.toHaveBeenCalled();
    });

    it('refuses an untrusted plan even when it names entries', async () => {
        const deleteEntry = vi.fn();
        const persistSettings = vi.fn();
        const untrusted = {
            trusted: false,
            untrustedReason: 'failed',
            deletable: ['onlyA'],
            kept: [],
            counts: { candidates: 1, deletable: 1, shared: 0, unverified: 0 },
            collections: [],
        };

        const run = await executeCollectionChunkMetaGc({
            plan: untrusted,
            deleteEntry,
            persistSettings,
        });

        expect(run.status).toBe('refused');
        expect(deleteEntry).not.toHaveBeenCalled();
        expect(persistSettings).not.toHaveBeenCalled();
    });

    it('counts an entry that was already gone as skipped, and saves nothing', async () => {
        const settings = settingsWith({});
        const deleteEntry = deleteEntryFrom(settings);
        const persistSettings = vi.fn();

        const run = await executeCollectionChunkMetaGc({
            plan: plan(),
            deleteEntry,
            persistSettings,
        });

        expect(run.status).toBe('complete');
        expect(run.counts).toEqual({ deleted: 0, skipped: 2 });
        expect(persistSettings).not.toHaveBeenCalled();
    });

    it('stops at a failed removal and reports what it removed', async () => {
        const settings = settingsWith({ onlyA: {}, onlyA2: {} });
        const persistSettings = vi.fn();
        const deleteEntry = vi.fn((hash) => {
            if (hash === 'onlyA2') throw new Error('settings object is frozen');
            delete settings[`vectfox_chunk_meta_${hash}`];
            return true;
        });

        const run = await executeCollectionChunkMetaGc({
            plan: plan(),
            deleteEntry,
            persistSettings,
        });

        expect(run.status).toBe('aborted');
        expect(run.error).toContain('settings object is frozen');
        expect(run.counts.deleted).toBe(1);
        expect(persistSettings).toHaveBeenCalledTimes(1);
        expect(settings.vectfox_chunk_meta_onlyA).toBeUndefined();
        expect(settings.vectfox_chunk_meta_onlyA2).toEqual({});
    });

    it('reports a failed save beside the deletion instead of throwing', async () => {
        const settings = settingsWith({ onlyA: {}, onlyA2: {} });

        const run = await executeCollectionChunkMetaGc({
            plan: plan(),
            deleteEntry: deleteEntryFrom(settings),
            persistSettings: () => { throw new Error('disk full'); },
        });

        expect(run.status).toBe('complete');
        expect(run.counts.deleted).toBe(2);
        expect(run.saveError).toContain('disk full');
    });

    it('deletes nothing a second time and saves nothing', async () => {
        const settings = settingsWith({ onlyA: {}, onlyA2: {} });
        const deleteEntry = deleteEntryFrom(settings);
        const persistSettings = vi.fn();

        await executeCollectionChunkMetaGc({ plan: plan(), deleteEntry, persistSettings });
        persistSettings.mockClear();
        const second = await executeCollectionChunkMetaGc({
            plan: plan(),
            deleteEntry,
            persistSettings,
        });

        expect(second.counts).toEqual({ deleted: 0, skipped: 2 });
        expect(persistSettings).not.toHaveBeenCalled();
    });
});
