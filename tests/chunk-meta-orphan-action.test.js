/**
 * Orphan-deletion composition — the seam the Size Inspector's Delete orphans
 * button calls.
 *
 * `createStorageOrphanDelete` wires the live settings, the registered
 * collections, the legacy entries and the plugin transport into the dry run's
 * scan and plan, then runs the counted confirmation and the deletion. These
 * tests pin what the production wiring must guarantee: the plugin gate, a
 * refusal whenever a collection could not be read, a confirmation that states
 * the count and the released size, deletion of exactly the orphans, one save,
 * and zero orphans on the next dry run.
 *
 * Seam: `createStorageOrphanDelete(deps)` with fake dependencies and a plain
 * settings object — no SillyTavern host modules are needed.
 */

import { describe, it, expect, vi } from 'vitest';

import {
    createStorageDryRun,
    createStorageOrphanDelete,
} from '../core/chunk-meta-storage-actions.js';
import { createFakeChunkListing } from './fixtures/chunk-listing.js';
import { settingsByteSize } from './fixtures/settings-bytes.js';

const PREFIX = 'vectfox_chunk_meta_';

function collection(id, backend = 'qdrant') {
    return { registryKey: `${backend}:${id}`, collectionId: id };
}

const FIXTURE = {
    collections: [collection('A')],
    chunksByCollection: {
        'qdrant:A': {
            live: { context: 'about dragons', keywords: ['dragon'] },
            patchMe: { context: 'about elves' },
        },
    },
};

/** One redundant entry, one patchable entry, two orphans. */
function fixtureSettings() {
    return {
        chunk_size: 500,
        chunk_meta_store: 'auto',
        [`${PREFIX}live`]: { context: 'about dragons', keywords: ['dragon'] },
        [`${PREFIX}patchMe`]: { context: 'about elves', keywords: ['elf'] },
        [`${PREFIX}gone`]: { context: 'about nothing' },
        [`${PREFIX}gone2`]: { context: 'also about nothing', keywords: ['void'] },
    };
}

/** The production wiring over fakes; `settings` really loses its orphan keys. */
function makeOrphanDelete({
    settings,
    collections = FIXTURE.collections,
    chunksByCollection = FIXTURE.chunksByCollection,
    failing = [],
    available = true,
    deleteEntry,
    persistSettings = vi.fn(),
} = {}) {
    const { listChunks, patchMetadata, calls } = createFakeChunkListing({
        chunksByCollection,
        failing,
        reportTotal: true,
    });
    const createTransport = vi.fn(() => ({
        isAvailable: () => available,
        listChunks,
        patchMetadata,
    }));
    const listCollections = vi.fn(() => collections);
    const listEntries = vi.fn(() => Object.fromEntries(
        Object.entries(settings || {})
            .filter(([key]) => key.startsWith(PREFIX))
            .map(([key, metadata]) => [key.slice(PREFIX.length), metadata]),
    ));
    const remove = vi.fn(deleteEntry || ((hash) => {
        const key = `${PREFIX}${hash}`;
        if (!(key in settings)) return false;
        delete settings[key];
        return true;
    }));

    const runner = createStorageOrphanDelete({
        createTransport,
        listCollections,
        listEntries,
        clientOnlyFields: ['summaries'],
        deleteEntry: remove,
        persistSettings,
    });

    return {
        run: options => runner({ getSettings: () => settings, ...options }),
        createTransport,
        listCollections,
        listEntries,
        deleteEntry: remove,
        persistSettings,
        listCalls: calls,
        patchMetadata,
    };
}

describe('orphan deletion — when it refuses to run', () => {
    it('reports itself unconfigured rather than pretending there is nothing to do', async () => {
        const view = await createStorageOrphanDelete()({});

        expect(view.status).toBe('unavailable');
        expect(view.reason).toMatch(/not configured/);
    });

    it('reports itself unconfigured without the pieces that delete', async () => {
        const { createTransport, listCollections, listEntries } = makeOrphanDelete({
            settings: fixtureSettings(),
        });

        const view = await createStorageOrphanDelete({
            createTransport,
            listCollections,
            listEntries,
        })({ getSettings: () => fixtureSettings() });

        expect(view.status).toBe('unavailable');
        expect(view.reason).toMatch(/not configured/);
    });

    it('reports unavailable while the settings object is missing', async () => {
        const { createTransport, listCollections, listEntries } = makeOrphanDelete({
            settings: fixtureSettings(),
        });
        const runner = createStorageOrphanDelete({
            createTransport,
            listCollections,
            listEntries,
            deleteEntry: vi.fn(() => true),
            persistSettings: vi.fn(),
        });

        const view = await runner({ getSettings: () => null });

        expect(view.status).toBe('unavailable');
        expect(view.reason).toMatch(/not available yet/);
    });

    it('runs nothing without the plugin, because absence cannot be verified', async () => {
        const harness = makeOrphanDelete({ settings: fixtureSettings(), available: false });
        const confirm = vi.fn(() => true);

        const view = await harness.run({ confirm });

        expect(view.status).toBe('unavailable');
        expect(view.reason).toMatch(/Similharity plugin is not available/);
        expect(harness.listCalls).toHaveLength(0);
        expect(confirm).not.toHaveBeenCalled();
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.persistSettings).not.toHaveBeenCalled();
    });

    it('refuses deletion when any registered collection could not be read', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({
            settings,
            collections: [collection('A'), collection('B')],
            failing: ['qdrant:B'],
        });
        const confirm = vi.fn(() => true);

        const view = await harness.run({ confirm });

        expect(view.status).toBe('measured');
        expect(view.outcome).toBe('refused');
        expect(view.refusal).toContain('Deletion is refused');
        expect(view.refusal).toContain('could not be read');
        expect(confirm).not.toHaveBeenCalled();
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.persistSettings).not.toHaveBeenCalled();
        expect(settings[`${PREFIX}gone`]).toBeDefined();
        expect(settings[`${PREFIX}gone2`]).toBeDefined();
    });
});

describe('orphan deletion — the counted confirmation', () => {
    it('states the entry count and the released size before anything is deleted', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({ settings });
        const before = settingsByteSize(settings);
        const expectedRelease = before - settingsByteSize({
            ...settings,
            [`${PREFIX}gone`]: undefined,
            [`${PREFIX}gone2`]: undefined,
        });
        let seen = null;
        const confirm = vi.fn((view) => {
            seen = view;
            // Nothing may be deleted before the dialog resolves.
            expect(settings[`${PREFIX}gone`]).toBeDefined();
            expect(harness.deleteEntry).not.toHaveBeenCalled();
            return true;
        });

        const view = await harness.run({ confirm });

        expect(seen.headline).toContain('2 orphan settings entries');
        expect(seen.entries.count).toBe(2);
        expect(seen.entries.label).toBe('2');
        expect(seen.bytes.bytes).toBe(expectedRelease);
        expect(seen.detail).toContain(seen.bytes.sizeLabel);
        expect(seen.detail).toContain('none of the registered collections this scan read');
        expect(seen.okButton).toContain('2 orphan settings entries');
        expect(view.outcome).toBe('complete');
    });

    it('deletes exactly the orphans, leaves every other entry, and saves once', async () => {
        const settings = fixtureSettings();
        const before = settingsByteSize(settings);
        const harness = makeOrphanDelete({ settings });

        const view = await harness.run({ confirm: () => true });

        expect(harness.deleteEntry.mock.calls.map(([hash]) => hash).sort())
            .toEqual(['gone', 'gone2']);
        expect(settings[`${PREFIX}gone`]).toBeUndefined();
        expect(settings[`${PREFIX}gone2`]).toBeUndefined();
        // A redundant or patchable entry is the sweep's work, never this action's.
        expect(settings[`${PREFIX}live`]).toBeDefined();
        expect(settings[`${PREFIX}patchMe`]).toBeDefined();
        expect(harness.patchMetadata).not.toHaveBeenCalled();
        expect(harness.persistSettings).toHaveBeenCalledTimes(1);

        expect(view.outcome).toBe('complete');
        expect(view.headline).toContain('Deleted 2 orphan settings entries');
        expect(view.counts.deleted.label).toBe('2');
        expect(view.counts.released.bytes).toBe(before - settingsByteSize(settings));
        expect(view.failure).toBeNull();
        expect(view.saveWarning).toBeNull();
    });

    it('deletes nothing when the user cancels, and says so', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({ settings });

        const view = await harness.run({ confirm: () => false });

        expect(view.outcome).toBe('cancelled');
        expect(view.headline).toContain('Nothing was deleted');
        expect(view.counts.released.bytes).toBe(0);
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.persistSettings).not.toHaveBeenCalled();
        expect(settings[`${PREFIX}gone`]).toBeDefined();
        expect(settings[`${PREFIX}gone2`]).toBeDefined();
        // The scan behind the confirmation is handed back, so the panel can
        // show the report that the dialog was built from.
        expect(view.scanView.totals.orphan.label).toBe('2');
    });

    it('fails closed when no confirmation is supplied', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({ settings });

        const view = await harness.run();

        expect(view.outcome).toBe('cancelled');
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.persistSettings).not.toHaveBeenCalled();
    });

    it('states a single orphan in the singular', async () => {
        const settings = fixtureSettings();
        delete settings[`${PREFIX}gone2`];
        const harness = makeOrphanDelete({ settings });
        let seen = null;

        const view = await harness.run({ confirm: (ask) => { seen = ask; return true; } });

        expect(seen.headline).toBe('Delete 1 orphan settings entry?');
        expect(seen.okButton).toBe('Delete 1 orphan settings entry');
        expect(view.headline).toMatch(/^Deleted 1 orphan settings entry — released /);
    });

    it('reports a partial removal and only the size it actually released', async () => {
        const settings = fixtureSettings();
        const before = settingsByteSize(settings);
        const harness = makeOrphanDelete({
            settings,
            deleteEntry: (hash) => {
                const key = `${PREFIX}${hash}`;
                if (hash === 'gone2') return false;
                delete settings[key];
                return true;
            },
        });

        const view = await harness.run({ confirm: () => true });
        const after = settingsByteSize(settings);

        expect(view.outcome).toBe('complete');
        expect(view.counts.deleted.label).toBe('1');
        expect(view.headline).toBe(
            `Deleted 1 of 2 orphan settings entries — released ${view.counts.released.sizeLabel}.`,
        );
        expect(view.counts.released.bytes).toBe(before - after);
        expect(settings[`${PREFIX}gone2`]).toBeDefined();
    });

    it('stops at a failed removal and reports what it removed', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({
            settings,
            deleteEntry: (hash) => {
                if (hash === 'gone2') throw new Error('settings object is frozen');
                delete settings[`${PREFIX}${hash}`];
                return true;
            },
        });

        const view = await harness.run({ confirm: () => true });

        expect(view.outcome).toBe('aborted');
        expect(view.headline)
            .toBe('Deletion stopped — 1 orphan settings entry removed before it stopped.');
        expect(view.failure).toContain('settings object is frozen');
        expect(view.counts.released.bytes).toBeGreaterThan(0);
        expect(settings[`${PREFIX}gone`]).toBeUndefined();
        expect(settings[`${PREFIX}gone2`]).toBeDefined();
    });

    it('reports a failed save beside the deletion instead of throwing', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({
            settings,
            persistSettings: vi.fn(() => { throw new Error('disk full'); }),
        });

        const view = await harness.run({ confirm: () => true });

        expect(view.outcome).toBe('complete');
        expect(view.counts.deleted.label).toBe('2');
        expect(view.saveWarning).toContain('could not be saved');
        expect(view.saveWarning).toContain('disk full');
    });
});

describe('orphan deletion — afterwards', () => {
    it('names the real reason when nothing was registered to scan', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({ settings, collections: [], chunksByCollection: {} });
        const confirm = vi.fn(() => true);

        const view = await harness.run({ confirm });

        expect(view.outcome).toBe('refused');
        expect(view.headline)
            .toBe('No orphans were deleted — no registered collections were available to scan.');
        expect(view.refusal).toContain('no registered collections were available');
        expect(confirm).not.toHaveBeenCalled();
        expect(harness.deleteEntry).not.toHaveBeenCalled();
    });

    it('reports no orphans when there are none, without confirming', async () => {
        const settings = fixtureSettings();
        delete settings[`${PREFIX}gone`];
        delete settings[`${PREFIX}gone2`];
        const harness = makeOrphanDelete({ settings });
        const confirm = vi.fn(() => true);

        const view = await harness.run({ confirm });

        expect(view.outcome).toBe('empty');
        expect(view.headline).toContain('No orphan settings entries');
        expect(confirm).not.toHaveBeenCalled();
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.persistSettings).not.toHaveBeenCalled();
    });

    it('leaves a dry run reporting zero orphans, consistently on every re-run', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({ settings });
        const dryRun = createStorageDryRun({
            createTransport: harness.createTransport,
            listCollections: harness.listCollections,
            listEntries: harness.listEntries,
            clientOnlyFields: ['summaries'],
        });

        const before = await dryRun({ getSettings: () => settings });
        expect(before.totals.orphan.label).toBe('2');

        await harness.run({ confirm: () => true });

        const first = await dryRun({ getSettings: () => settings });
        const second = await dryRun({ getSettings: () => settings });
        expect(first.totals.orphan.label).toBe('0');
        expect(second.totals.orphan.label).toBe('0');
        expect(second.collections.map(row => row.registryKey))
            .toEqual(first.collections.map(row => row.registryKey));
        expect(second.headline).toBe(first.headline);
        // The redundant and patchable entries still stand for the sweep.
        expect(first.totals.redundant.label).toBe('1');
        expect(first.totals.patch.label).toBe('1');
    });

    it('deletes nothing on a second run of its own action', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({ settings });
        await harness.run({ confirm: () => true });
        harness.deleteEntry.mockClear();
        harness.persistSettings.mockClear();
        const confirm = vi.fn(() => true);

        const view = await harness.run({ confirm });

        expect(view.outcome).toBe('empty');
        expect(confirm).not.toHaveBeenCalled();
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.persistSettings).not.toHaveBeenCalled();
    });

    it('reports scan progress while it verifies every collection', async () => {
        const settings = fixtureSettings();
        const harness = makeOrphanDelete({ settings });
        const progress = [];

        await harness.run({ confirm: () => true, onProgress: value => progress.push(value) });

        expect(progress.some(value => value.done === 1 && value.total === 1)).toBe(true);
    });

    it('keeps an entry holding client-only data, even with no collection holding its chunk', async () => {
        const settings = fixtureSettings();
        settings[`${PREFIX}deadWithSummary`] = { summaries: ['the only copy'] };
        const harness = makeOrphanDelete({ settings });
        const dryRun = createStorageDryRun({
            createTransport: harness.createTransport,
            listCollections: harness.listCollections,
            listEntries: harness.listEntries,
            clientOnlyFields: ['summaries'],
        });
        const confirm = vi.fn(() => true);

        const view = await harness.run({ confirm });

        // Only the two true orphans were offered; the summaries entry was not
        // even priced, because no payload can carry that data back.
        expect(confirm.mock.calls[0][0].entries.count).toBe(2);
        expect(view.counts.deleted.label).toBe('2');
        expect(settings[`${PREFIX}deadWithSummary`]).toEqual({ summaries: ['the only copy'] });

        const report = await dryRun({ getSettings: () => settings });
        expect(report.totals.orphan.label).toBe('0');
        expect(report.totals.skipped.label).toBe('1');
        expect(report.skippedNote)
            .toBe('1 skipped entry holds client-only data (no payload can carry it) and is kept.');
    });

    it('refuses the rollback policy before scanning anything', async () => {
        // `settings` declares the settings namespace the source of truth; the
        // sweep refuses it, and a destructive migration action has no business
        // running while the user is rolled back.
        const settings = { ...fixtureSettings(), chunk_meta_store: 'settings' };
        const harness = makeOrphanDelete({ settings });
        const confirm = vi.fn(() => true);

        const view = await harness.run({ confirm });

        expect(view.status).toBe('unavailable');
        expect(view.reason).toContain('set to settings');
        expect(harness.listCalls).toHaveLength(0);
        expect(confirm).not.toHaveBeenCalled();
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.persistSettings).not.toHaveBeenCalled();
        expect(settings[`${PREFIX}gone`]).toBeDefined();
    });
});
