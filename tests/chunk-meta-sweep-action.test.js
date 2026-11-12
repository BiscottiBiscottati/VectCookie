/**
 * Sweep composition — the seam the Size Inspector's Run sweep button calls.
 *
 * `createStorageSweep` wires the live settings, the registered collections, the
 * legacy entries and the plugin transport into the scan, the plan and the
 * executor. These tests pin what the production wiring must guarantee: the
 * plugin gate, the settings-policy refusal, routing each patch by registry key,
 * one settings save, the stamp written to settings, and a report the panel can
 * render without knowing any of it.
 *
 * Seam: `createStorageSweep(deps)` with fake dependencies and a plain settings
 * object — no SillyTavern host modules are needed.
 */

import { describe, it, expect, vi } from 'vitest';

import { createStorageSweep } from '../core/chunk-meta-storage-actions.js';
import { getSweepStamp, setSweepStamp } from '../core/chunk-meta-sweep-execute.js';
import { createFakeChunkListing } from './fixtures/chunk-listing.js';

const PREFIX = 'vectfox_chunk_meta_';
const NOW = new Date('2026-11-12T09:30:00.000Z');

function collection(id, backend = 'qdrant') {
    return { registryKey: `${backend}:${id}`, collectionId: id };
}

/**
 * The production wiring over fakes: a settings object that really loses its
 * legacy keys, a fake plugin transport, and the real stamp accessors.
 */
function makeSweep({
    settings,
    collections,
    chunksByCollection,
    failing = [],
    available = true,
    deleteEntry,
    persistSettings = vi.fn(),
} = {}) {
    const { listChunks, patchMetadata, patchCalls, calls } = createFakeChunkListing({
        chunksByCollection,
        failing,
        reportTotal: true,
    });
    const transport = { isAvailable: () => available, listChunks, patchMetadata };
    const createTransport = vi.fn(() => transport);
    const listCollections = vi.fn(() => collections);
    const listEntries = vi.fn(() => Object.fromEntries(
        Object.entries(settings || {})
            .filter(([key]) => key.startsWith(PREFIX))
            .map(([key, metadata]) => [key.slice(PREFIX.length), metadata]),
    ));
    const remove = vi.fn(deleteEntry || ((hash) => {
        delete settings[`${PREFIX}${hash}`];
        return true;
    }));
    const persist = persistSettings;

    const run = createStorageSweep({
        createTransport,
        listCollections,
        listEntries,
        clientOnlyFields: ['summaries'],
        deleteEntry: remove,
        readStamp: () => getSweepStamp(settings),
        writeStamp: stamp => setSweepStamp(settings, stamp),
        persistSettings: persist,
    });

    return {
        run,
        createTransport,
        listCollections,
        listEntries,
        deleteEntry: remove,
        persistSettings: persist,
        patchMetadata,
        patchCalls,
        listCalls: calls,
    };
}

/** One collection holding a patchable entry, a redundant one and an orphan. */
const FIXTURE = {
    collections: [collection('A')],
    chunksByCollection: {
        'qdrant:A': {
            patchMe: { context: 'about elves' },
            already: { context: 'about dragons', keywords: ['dragon'] },
        },
    },
};

function fixtureSettings() {
    return {
        chunk_size: 500,
        chunk_meta_store: 'auto',
        [`${PREFIX}patchMe`]: { context: 'about elves', keywords: ['elf'] },
        [`${PREFIX}already`]: { context: 'about dragons', keywords: ['dragon'] },
        [`${PREFIX}gone`]: { context: 'about nothing' },
    };
}

describe('storage sweep — when it refuses to run', () => {
    it('reports itself unconfigured rather than pretending there is nothing to do', async () => {
        const view = await createStorageSweep()({});

        expect(view.status).toBe('unavailable');
        expect(view.reason).toMatch(/not configured/);
    });

    it('reports itself unconfigured without the pieces that write', async () => {
        const { createTransport, listCollections, listEntries } = makeSweep({
            settings: fixtureSettings(),
            ...FIXTURE,
        });

        const view = await createStorageSweep({
            createTransport,
            listCollections,
            listEntries,
        })({ getSettings: () => fixtureSettings() });

        expect(view.status).toBe('unavailable');
        expect(view.reason).toMatch(/not configured/);
    });

    it('reports unavailable while the settings object is missing', async () => {
        const { run } = makeSweep({ settings: fixtureSettings(), ...FIXTURE });

        const view = await run({ getSettings: () => null });

        expect(view.status).toBe('unavailable');
        expect(view.reason).toMatch(/not available yet/);
    });

    it('runs nothing without the plugin, and says so', async () => {
        const { run, listCalls, patchMetadata, deleteEntry, persistSettings } = makeSweep({
            settings: fixtureSettings(),
            available: false,
            ...FIXTURE,
        });

        const view = await run({ getSettings: () => fixtureSettings() });

        expect(view.status).toBe('unavailable');
        expect(view.reason).toMatch(/Similharity plugin is not available/);
        expect(listCalls).toHaveLength(0);
        expect(patchMetadata).not.toHaveBeenCalled();
        expect(deleteEntry).not.toHaveBeenCalled();
        expect(persistSettings).not.toHaveBeenCalled();
    });

    it('refuses to sweep when the store policy is settings, which is the rollback state', async () => {
        const settings = { ...fixtureSettings(), chunk_meta_store: 'settings' };
        const { run, listCalls, deleteEntry, persistSettings } = makeSweep({
            settings,
            ...FIXTURE,
        });

        const view = await run({ getSettings: () => settings });

        expect(view.status).toBe('unavailable');
        expect(view.reason).toMatch(/set to settings/);
        expect(listCalls).toHaveLength(0);
        expect(deleteEntry).not.toHaveBeenCalled();
        expect(persistSettings).not.toHaveBeenCalled();
    });
});

describe('storage sweep — the production seam', () => {
    it('patches the gaps, removes the settings copies and leaves orphans alone', async () => {
        const settings = fixtureSettings();
        const harness = makeSweep({ settings, ...FIXTURE });

        const view = await harness.run({
            getSettings: () => settings,
            now: NOW,
        });

        expect(view.status).toBe('measured');
        expect(view.outcome).toBe('complete');
        expect(harness.patchCalls).toEqual([
            ['qdrant:A', 'patchMe', { keywords: ['elf'] }],
        ]);
        expect(settings[`${PREFIX}patchMe`]).toBeUndefined();
        expect(settings[`${PREFIX}already`]).toBeUndefined();
        expect(settings[`${PREFIX}gone`]).toEqual({ context: 'about nothing' });
        expect(harness.persistSettings).toHaveBeenCalledTimes(1);

        const stamp = getSweepStamp(settings);
        expect(stamp).toMatchObject({
            mode: 'payload',
            status: 'complete',
            trusted: true,
            counts: { entries: 2, patched: 1, deleted: 2, refused: 0, failed: 0 },
        });
        expect(stamp.startedAt).toBe(NOW.toISOString());

        expect(view.headline).toBe('Sweep complete — 1 entry patched, 2 settings entries removed.');
        expect(view.counts.patched.label).toBe('1');
        expect(view.counts.deleted.label).toBe('2');
        expect(view.failure).toBeNull();
        expect(view.refusal).toBeNull();
        expect(view.stampNote).toContain('payload');
    });

    it('routes each patch by registry key, so two backends stay apart', async () => {
        const settings = {
            [`${PREFIX}shared`]: { context: 'about elves', keywords: ['elf'] },
        };
        const harness = makeSweep({
            settings,
            collections: [collection('same', 'qdrant'), collection('same', 'standard')],
            chunksByCollection: {
                'qdrant:same': { shared: { context: 'about elves' } },
                'standard:same': { shared: { context: 'about elves' } },
            },
        });

        await harness.run({ getSettings: () => settings, now: NOW });

        expect(harness.patchCalls.map(([registryKey]) => registryKey))
            .toEqual(['qdrant:same', 'standard:same']);
        expect(harness.deleteEntry).toHaveBeenCalledTimes(1);
    });

    it('refuses deletion for the whole run when one collection failed, but patches', async () => {
        const settings = {
            [`${PREFIX}patchMe`]: { context: 'about elves', keywords: ['elf'] },
            [`${PREFIX}already`]: { context: 'about dragons', keywords: ['dragon'] },
        };
        const harness = makeSweep({
            settings,
            collections: [collection('A'), collection('B')],
            chunksByCollection: {
                'qdrant:A': {
                    patchMe: { context: 'about elves' },
                    already: { context: 'about dragons', keywords: ['dragon'] },
                },
            },
            // The transport is called with registry keys, which is what the
            // fake matches after the first backend is resolved.
            failing: ['qdrant:B'],
        });

        const view = await harness.run({ getSettings: () => settings, now: NOW });

        expect(view.outcome).toBe('complete');
        expect(view.refusal).toContain('Deletion is refused');
        expect(view.counts.patched.label).toBe('1');
        expect(view.counts.deleted.label).toBe('0');
        expect(harness.patchCalls).toHaveLength(1);
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(settings[`${PREFIX}already`]).toBeDefined();
        expect(getSweepStamp(settings)).toMatchObject({
            status: 'complete',
            trusted: false,
            counts: { patched: 1, deleted: 0, refused: 2 },
        });
    });

    it('completes an interrupted run from its stamp without redoing finished work', async () => {
        const settings = fixtureSettings();
        setSweepStamp(settings, {
            version: 1,
            mode: 'payload',
            status: 'aborted',
            startedAt: '2026-11-12T08:00:00.000Z',
            finishedAt: '2026-11-12T08:05:00.000Z',
            trusted: true,
            counts: { entries: 1, patched: 1, deleted: 0, refused: 0, failed: 1 },
        });
        // The earlier attempt patched `patchMe`'s payload but stopped before
        // removing anything: this scan sees it as redundant, not patchable.
        const harness = makeSweep({
            settings,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': {
                    patchMe: { context: 'about elves', keywords: ['elf'] },
                    already: { context: 'about dragons', keywords: ['dragon'] },
                },
            },
        });

        const view = await harness.run({ getSettings: () => settings, now: NOW });

        expect(view.outcome).toBe('complete');
        expect(view.resumedNote).toContain('2026-11-12 08:00 UTC');
        expect(harness.patchMetadata).not.toHaveBeenCalled();
        expect(harness.deleteEntry.mock.calls.map(([hash]) => hash).sort())
            .toEqual(['already', 'patchMe']);
        expect(view.counts.deleted.label).toBe('2');
        expect(getSweepStamp(settings)).toMatchObject({
            status: 'complete',
            // The interrupted attempt's start time identifies the attempt; the
            // counts describe what this continuation did, not a running total.
            startedAt: '2026-11-12T08:00:00.000Z',
            counts: { entries: 2, patched: 0, deleted: 2, refused: 0, failed: 0 },
        });
    });

    it('is a no-op on a second run once the sweep completed', async () => {
        const settings = fixtureSettings();
        const harness = makeSweep({ settings, ...FIXTURE });
        await harness.run({ getSettings: () => settings, now: NOW });

        const stamp = getSweepStamp(settings);
        harness.patchMetadata.mockClear();
        harness.deleteEntry.mockClear();
        harness.persistSettings.mockClear();
        const listCallsBefore = harness.listCalls.length;

        const view = await harness.run({ getSettings: () => settings, now: NOW });

        expect(view.outcome).toBe('noop');
        expect(view.headline).toContain('Nothing to sweep');
        // The no-op moved nothing, so its counts are zero, not the prior totals.
        expect(view.counts.patched.label).toBe('0');
        expect(view.counts.deleted.label).toBe('0');
        expect(harness.patchMetadata).not.toHaveBeenCalled();
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.persistSettings).not.toHaveBeenCalled();
        // A second run still has to scan to know there is nothing left.
        expect(harness.listCalls.length).toBeGreaterThan(listCallsBefore);
        expect(getSweepStamp(settings)).toEqual(stamp);
    });
});
