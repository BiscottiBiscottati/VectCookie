/**
 * Sweep execution — the one action that mutates.
 *
 * Ticket 05 of the chunk-meta-store feature: for every trusted-scanned collection
 * the sweep copies the fields a payload lacks and removes the settings copies the
 * payload supersedes, leaving orphans alone. Work runs in batches; a failure
 * aborts without deleting from the batch that failed, one settings save follows
 * the run, and a stamp records what happened so an interrupted run resumes.
 *
 * Seam: `executeChunkMetaSweep()` with fake write callbacks and a plain settings
 * object — the planner and scan that feed it are the production ones, driven by
 * the shared fake `/chunks/list`. No SillyTavern host modules are needed.
 */

import { describe, it, expect, vi } from 'vitest';

import {
    CHUNK_META_SWEEP_STAMP_KEY,
    executeChunkMetaSweep,
    getSweepStamp,
    setSweepStamp,
} from '../core/chunk-meta-sweep-execute.js';
import { planChunkMetaSweep } from '../core/chunk-meta-sweep.js';
import { runChunkMetaDryRun } from '../core/chunk-meta-sweep-report.js';
import { createFakeChunkListing } from './fixtures/chunk-listing.js';

const NOW = new Date('2026-11-12T09:30:00.000Z');
const PREFIX = 'vectfox_chunk_meta_';

function collection(id) {
    return { registryKey: `qdrant:${id}`, collectionId: id };
}

/** The production scan and planner over a fake listing, as the dry run builds it. */
async function planFor({
    entries,
    collections,
    chunksByCollection,
    failing = [],
    clientOnlyFields = ['summaries'],
}) {
    const { listChunks } = createFakeChunkListing({
        chunksByCollection,
        failing,
        reportTotal: true,
    });
    const run = await runChunkMetaDryRun({ entries, collections, listChunks, clientOnlyFields });
    return run.plan;
}

/**
 * Settings-backed executor: `deleteEntry` removes the real settings key, so a
 * test can observe what is left behind — and how much smaller the payload got.
 */
function makeHarness({
    plan,
    settings = {},
    failPatch = null,
    batchSize,
    previousStamp = null,
} = {}) {
    const patches = [];
    const deletes = [];
    const calls = [];
    const patchMetadata = vi.fn(async (registryKey, hash, fields) => {
        calls.push(`patch ${registryKey}/${hash}`);
        if (failPatch && failPatch({ registryKey, hash, fields })) {
            throw new Error(`patch failed for ${hash}`);
        }
        patches.push({ registryKey, hash, fields });
    });
    const deleteEntry = vi.fn((hash) => {
        calls.push(`delete ${hash}`);
        deletes.push(hash);
        delete settings[`${PREFIX}${hash}`];
        return true;
    });
    const writeStamp = vi.fn((stamp) => setSweepStamp(settings, stamp));
    const persistSettings = vi.fn();
    // Like the production wiring: an explicit previous stamp for a resume test,
    // otherwise whatever the settings object holds.
    const readStamp = vi.fn(() => previousStamp ?? getSweepStamp(settings));

    const run = (overrides = {}) => executeChunkMetaSweep({
        plan,
        mode: 'payload',
        patchMetadata,
        deleteEntry,
        readStamp,
        writeStamp,
        persistSettings,
        now: NOW,
        batchSize,
        ...overrides,
    });

    return { run, patches, deletes, calls, patchMetadata, deleteEntry, writeStamp, persistSettings };
}

describe('sweep execution — what it moves', () => {
    it('patches the fields a payload lacks, then removes the settings copy', async () => {
        const entries = { h1: { context: 'about dragons', keywords: ['dragon'] } };
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: { 'qdrant:A': { h1: { context: 'about dragons' } } },
        });
        const settings = {
            [`${PREFIX}h1`]: entries.h1,
            [`${PREFIX}orphan`]: { context: 'gone' },
        };
        const harness = makeHarness({ plan, settings });

        const result = await harness.run();

        expect(result.status).toBe('complete');
        expect(harness.patches).toEqual([
            { registryKey: 'qdrant:A', hash: 'h1', fields: { keywords: ['dragon'] } },
        ]);
        // The payload write precedes the deletion: a settings copy is never
        // removed before the value it held exists in the payload.
        expect(harness.calls).toEqual(['patch qdrant:A/h1', 'delete h1']);
        expect(settings[`${PREFIX}h1`]).toBeUndefined();
        expect(settings[`${PREFIX}orphan`]).toEqual({ context: 'gone' });
        expect(result.counts).toMatchObject({ entries: 1, patched: 1, deleted: 1, failed: 0 });
    });

    it('removes a redundant settings copy without writing to the payload', async () => {
        const entries = { h1: { context: 'about dragons', keywords: ['dragon'] } };
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': { h1: { context: 'about dragons', keywords: ['dragon'] } },
            },
        });
        const settings = { [`${PREFIX}h1`]: entries.h1 };
        const harness = makeHarness({ plan, settings });

        await harness.run();

        expect(harness.patchMetadata).not.toHaveBeenCalled();
        expect(harness.deletes).toEqual(['h1']);
        expect(settings[`${PREFIX}h1`]).toBeUndefined();
    });

    it('leaves an orphan and a client-only entry in settings', async () => {
        const entries = {
            gone: { context: 'about nothing' },
            kept: { context: 'about dragons', summaries: ['a summary'] },
        };
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': { kept: { context: 'about dragons', keywords: ['dragon'] } },
            },
        });
        const settings = {
            [`${PREFIX}gone`]: entries.gone,
            [`${PREFIX}kept`]: entries.kept,
        };
        const harness = makeHarness({ plan, settings });

        await harness.run();

        expect(harness.patchMetadata).not.toHaveBeenCalled();
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(settings[`${PREFIX}gone`]).toEqual(entries.gone);
        expect(settings[`${PREFIX}kept`]).toEqual(entries.kept);
    });

    it('patches an entry missing fields in two collections before deleting it once', async () => {
        const entries = { shared: { context: 'about elves', keywords: ['elf'] } };
        const plan = await planFor({
            entries,
            collections: [collection('A'), collection('B')],
            chunksByCollection: {
                'qdrant:A': { shared: { context: 'about elves' } },
                'qdrant:B': { shared: { context: 'about elves' } },
            },
        });
        const settings = { [`${PREFIX}shared`]: entries.shared };
        const harness = makeHarness({ plan, settings });

        await harness.run();

        expect(harness.patches.map(record => record.registryKey)).toEqual(['qdrant:A', 'qdrant:B']);
        expect(harness.deletes).toEqual(['shared']);
        expect(settings[`${PREFIX}shared`]).toBeUndefined();
    });
});

describe('sweep execution — an untrusted scan refuses deletion for the whole run', () => {
    it('patches what it can but removes nothing when one collection failed', async () => {
        const entries = {
            h1: { context: 'about dragons', keywords: ['dragon'] },
            h2: { context: 'about elves', keywords: ['elf'] },
        };
        const plan = await planFor({
            entries,
            collections: [collection('A'), collection('B')],
            chunksByCollection: {
                'qdrant:A': {
                    h1: { context: 'about dragons', keywords: ['dragon'] },
                    h2: { context: 'about elves' },
                },
            },
            failing: ['B'],
        });
        const settings = {
            [`${PREFIX}h1`]: entries.h1,
            [`${PREFIX}h2`]: entries.h2,
        };
        const harness = makeHarness({ plan, settings });

        const result = await harness.run();

        expect(plan.trusted).toBe(false);
        expect(result.deletionRefused).toBe(true);
        // Both entries would have been removable on a trusted run: h1 is
        // redundant, h2 becomes so once this run patches it.
        expect(result.counts.refused).toBe(2);
        expect(harness.patches).toEqual([
            { registryKey: 'qdrant:A', hash: 'h2', fields: { keywords: ['elf'] } },
        ]);
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(settings[`${PREFIX}h1`]).toEqual(entries.h1);
        expect(settings[`${PREFIX}h2`]).toEqual(entries.h2);
    });

    it('never deletes from a plan that carries a delete list while marked untrusted', async () => {
        // Defence in depth: the planner already empties the delete list of an
        // untrusted run, but the executor must not trust a plan that does not.
        const plan = {
            trusted: false,
            counts: { redundant: 1, patch: 0, orphan: 0, skipped: 0 },
            redundant: [{ hash: 'h1', collections: ['qdrant:A'] }],
            deletable: [{ hash: 'h1', collections: ['qdrant:A'] }],
            patch: [],
            orphan: [],
            skipped: [],
            perCollection: [],
            coverage: { registered: 1, scanned: 1, chunksRead: 1 },
        };
        const harness = makeHarness({ plan, settings: { [`${PREFIX}h1`]: { context: 'x' } } });

        const result = await harness.run();

        expect(result.deletionRefused).toBe(true);
        expect(harness.deleteEntry).not.toHaveBeenCalled();
    });
});

describe('sweep execution — batches and failures', () => {
    /** Four removable entries: three patchable then one redundant. */
    async function fourEntries() {
        const entries = {
            p1: { context: 'about elves', keywords: ['elf'] },
            p2: { context: 'about orcs', keywords: ['orc'] },
            p3: { context: 'about halflings', keywords: ['hobbit'] },
            r1: { context: 'about dragons', keywords: ['dragon'] },
        };
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': {
                    p1: { context: 'about elves' },
                    p2: { context: 'about orcs' },
                    p3: { context: 'about halflings' },
                    r1: { context: 'about dragons', keywords: ['dragon'] },
                },
            },
        });
        const settings = Object.fromEntries(
            Object.entries(entries).map(([hash, metadata]) => [`${PREFIX}${hash}`, metadata]),
        );
        // The plan lists one delete candidate per removable entry, in the order
        // the settings entries were classified; the sweep executes patch work
        // first, then delete-only work.
        expect(plan.patch.map(record => record.hash)).toEqual(['p1', 'p2', 'p3']);
        expect(plan.deletable.map(record => record.hash)).toEqual(['p1', 'p2', 'p3', 'r1']);
        return { plan, settings };
    }

    it('aborts the batch without deleting anything from it when a patch fails', async () => {
        const { plan, settings } = await fourEntries();
        const harness = makeHarness({
            plan,
            settings,
            batchSize: 2,
            failPatch: ({ hash }) => hash === 'p3',
        });

        const result = await harness.run();

        expect(result.status).toBe('aborted');
        expect(result.error).toContain('patch failed for p3');
        // Batch one (p1, p2) patched and removed; batch two stopped at p3.
        expect(harness.calls).toEqual([
            'patch qdrant:A/p1',
            'patch qdrant:A/p2',
            'delete p1',
            'delete p2',
            'patch qdrant:A/p3',
        ]);
        // Nothing from the failed batch was deleted: p3 kept its settings copy
        // and the redundant r1 was never reached.
        expect(settings[`${PREFIX}p3`]).toBeDefined();
        expect(settings[`${PREFIX}r1`]).toBeDefined();
        expect(harness.deleteEntry).not.toHaveBeenCalledWith('p3');
        expect(harness.deleteEntry).not.toHaveBeenCalledWith('r1');
        expect(result.counts.failed).toBe(1);
        expect(result.counts.deleted).toBe(2);
    });

    it('saves the settings once for a run that removes many entries', async () => {
        const entries = Object.fromEntries(
            Array.from({ length: 10 }, (_, index) => [
                `h${index}`,
                { context: `about ${index}` },
            ]),
        );
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': Object.fromEntries(
                    Object.entries(entries).map(([hash, metadata]) => [hash, metadata]),
                ),
            },
        });
        const settings = Object.fromEntries(
            Object.keys(entries).map(hash => [`${PREFIX}${hash}`, entries[hash]]),
        );
        const harness = makeHarness({ plan, settings });

        await harness.run();

        expect(harness.deletes).toHaveLength(10);
        expect(harness.persistSettings).toHaveBeenCalledTimes(1);
    });

    it('reports progress per completed batch', async () => {
        const { plan, settings } = await fourEntries();
        const harness = makeHarness({ plan, settings, batchSize: 2 });
        const progress = [];

        await harness.run({ onProgress: record => progress.push(record) });

        expect(progress).toEqual([
            { phase: 'patch', done: 2, total: 4, patched: 2, deleted: 2 },
            { phase: 'patch', done: 4, total: 4, patched: 3, deleted: 4 },
        ]);
    });
});

describe('sweep execution — the stamp', () => {
    it('records mode, counts and timestamps, and is saved with the run', async () => {
        const entries = { h1: { context: 'about dragons', keywords: ['dragon'] } };
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': { h1: { context: 'about dragons', keywords: ['dragon'] } },
            },
        });
        const harness = makeHarness({
            plan,
            settings: { [`${PREFIX}h1`]: entries.h1 },
        });

        const result = await harness.run();

        expect(harness.writeStamp).toHaveBeenCalledTimes(1);
        expect(harness.writeStamp).toHaveBeenCalledWith(result.stamp);
        expect(result.stamp).toEqual({
            version: 1,
            mode: 'payload',
            status: 'complete',
            startedAt: NOW.toISOString(),
            finishedAt: NOW.toISOString(),
            trusted: true,
            persisted: true,
            counts: { entries: 1, patched: 0, deleted: 1, refused: 0, failed: 0 },
        });
        expect(harness.persistSettings).toHaveBeenCalledTimes(1);
        // The stamp is what settings hold afterwards, in a shape a later build reads.
        expect(getSweepStamp({ [CHUNK_META_SWEEP_STAMP_KEY]: result.stamp })).toEqual(result.stamp);
    });

    it('writes an aborted stamp a later run can resume from', async () => {
        const entries = { p1: { context: 'about elves', keywords: ['elf'] } };
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: { 'qdrant:A': { p1: { context: 'about elves' } } },
        });
        const harness = makeHarness({
            plan,
            settings: { [`${PREFIX}p1`]: entries.p1 },
            failPatch: () => true,
        });

        const result = await harness.run();

        expect(result.stamp.status).toBe('aborted');
        expect(result.stamp.counts.patched).toBe(0);
        expect(harness.persistSettings).toHaveBeenCalledTimes(1);
        expect(getSweepStamp({ [CHUNK_META_SWEEP_STAMP_KEY]: result.stamp }).status).toBe('aborted');
    });

    it('reads back only a stamp it recognises', () => {
        expect(getSweepStamp({})).toBeNull();
        expect(getSweepStamp({ [CHUNK_META_SWEEP_STAMP_KEY]: 'nonsense' })).toBeNull();
        // Only a finished attempt is a stamp; nothing writes an in-progress state.
        expect(getSweepStamp({
            [CHUNK_META_SWEEP_STAMP_KEY]: { status: 'running', counts: {} },
        })).toBeNull();
        expect(getSweepStamp({
            [CHUNK_META_SWEEP_STAMP_KEY]: { status: 'complete', counts: { deleted: 2 } },
        })).toEqual({
            version: 1,
            mode: 'payload',
            status: 'complete',
            startedAt: null,
            finishedAt: null,
            trusted: true,
            persisted: true,
            counts: { entries: 0, patched: 0, deleted: 2, refused: 0, failed: 0 },
        });
        expect(getSweepStamp({
            [CHUNK_META_SWEEP_STAMP_KEY]: { version: 2, status: 'complete', counts: {} },
        })).toBeNull();
    });
});

describe('sweep execution — resumption and repeat runs', () => {
    const ABORTED_STAMP = {
        version: 1,
        mode: 'payload',
        status: 'aborted',
        startedAt: '2026-11-12T08:00:00.000Z',
        finishedAt: '2026-11-12T08:10:00.000Z',
        trusted: true,
        counts: { entries: 2, patched: 2, deleted: 2, refused: 0, failed: 1 },
    };

    it('continues an interrupted run, keeping its start time and counting this attempt', async () => {
        const entries = {
            done1: { context: 'about dragons', keywords: ['dragon'] },
            done2: { context: 'about elves' },
            left: { context: 'about orcs', keywords: ['orc'] },
        };
        // The interrupted run left two entries patched and unremoved: their
        // payloads are now complete, so this scan classifies them redundant.
        // Only `left` still needs a payload write.
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': {
                    done1: { context: 'about dragons', keywords: ['dragon'] },
                    done2: { context: 'about elves' },
                    left: { context: 'about orcs' },
                },
            },
        });
        const settings = Object.fromEntries(
            Object.keys(entries).map(hash => [`${PREFIX}${hash}`, entries[hash]]),
        );
        const harness = makeHarness({ plan, settings, previousStamp: ABORTED_STAMP });

        const result = await harness.run();

        expect(result.resumed).toBe(true);
        expect(result.status).toBe('complete');
        // No duplicate payload write for the entries the earlier attempt patched.
        expect(harness.patches).toEqual([
            { registryKey: 'qdrant:A', hash: 'left', fields: { keywords: ['orc'] } },
        ]);
        expect(harness.deletes.sort()).toEqual(['done1', 'done2', 'left']);
        expect(result.stamp.startedAt).toBe(ABORTED_STAMP.startedAt);
        // The stamp describes this run, not a running total carried from the
        // interrupted attempt: 3 entries, 1 patched, 3 removed.
        expect(result.stamp.counts).toEqual({
            entries: 3,
            patched: 1,
            deleted: 3,
            refused: 0,
            failed: 0,
        });
        expect(result.counts).toEqual(result.stamp.counts);
    });

    it('is a no-op once a complete stamp exists and nothing is left to move', async () => {
        const completeStamp = {
            ...ABORTED_STAMP,
            status: 'complete',
            counts: { entries: 1, patched: 0, deleted: 1, refused: 0, failed: 0 },
        };
        const plan = await planFor({
            entries: {},
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': { live: { context: 'about dragons', keywords: ['dragon'] } },
            },
        });
        const harness = makeHarness({ plan, settings: {}, previousStamp: completeStamp });

        const result = await harness.run();

        expect(result.status).toBe('noop');
        expect(result.stamp).toEqual(completeStamp);
        // A no-op moved nothing: its counts are zero, not the previous run's.
        expect(result.counts).toEqual({
            entries: 0, patched: 0, deleted: 0, refused: 0, failed: 0,
        });
        expect(harness.patchMetadata).not.toHaveBeenCalled();
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.writeStamp).not.toHaveBeenCalled();
        expect(harness.persistSettings).not.toHaveBeenCalled();
    });

    it('does not call an untrusted run a no-op, even with a complete stamp on file', async () => {
        const entries = { h1: { context: 'about dragons', keywords: ['dragon'] } };
        const completeStamp = {
            ...ABORTED_STAMP,
            status: 'complete',
            trusted: false,
            counts: { entries: 0, patched: 0, deleted: 0, refused: 1, failed: 0 },
        };
        // One readable collection proves h1 redundant; the other failed, so the
        // entry may live there too and nothing may be removed. The earlier
        // complete stamp must not turn this into "nothing left to sweep".
        const plan = await planFor({
            entries,
            collections: [collection('A'), collection('B')],
            chunksByCollection: {
                'qdrant:A': { h1: { context: 'about dragons', keywords: ['dragon'] } },
            },
            failing: ['B'],
        });
        const harness = makeHarness({
            plan,
            settings: { [`${PREFIX}h1`]: entries.h1 },
            previousStamp: completeStamp,
        });

        const result = await harness.run();

        expect(plan.trusted).toBe(false);
        expect(result.status).toBe('complete');
        expect(result.deletionRefused).toBe(true);
        expect(result.counts.refused).toBe(1);
        expect(harness.deleteEntry).not.toHaveBeenCalled();
        expect(harness.writeStamp).toHaveBeenCalledTimes(1);
        expect(harness.persistSettings).toHaveBeenCalledTimes(1);
    });

    it('reports a failed settings save without losing the run', async () => {
        const entries = { h1: { context: 'about dragons', keywords: ['dragon'] } };
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': { h1: { context: 'about dragons', keywords: ['dragon'] } },
            },
        });
        const harness = makeHarness({
            plan,
            settings: { [`${PREFIX}h1`]: entries.h1 },
        });
        harness.persistSettings.mockImplementation(() => {
            throw new Error('settings save unavailable');
        });

        const result = await harness.run();

        expect(result.status).toBe('complete');
        expect(result.saveError).toContain('settings save unavailable');
        expect(result.counts.deleted).toBe(1);
        // The completion is in memory only, and the stamp says so, so the next
        // run cannot call it a finished migration.
        expect(getSweepStamp({ [CHUNK_META_SWEEP_STAMP_KEY]: result.stamp }).persisted).toBe(false);
        expect(harness.writeStamp).toHaveBeenCalled();
    });

    it('does not turn an unsaved completion into a no-op on the next run', async () => {
        const entries = { h1: { context: 'about dragons', keywords: ['dragon'] } };
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': { h1: { context: 'about dragons', keywords: ['dragon'] } },
            },
        });
        const harness = makeHarness({
            plan,
            settings: { [`${PREFIX}h1`]: entries.h1 },
        });
        harness.persistSettings.mockImplementationOnce(() => {
            throw new Error('settings save unavailable');
        });

        const first = await harness.run();
        expect(first.saveError).toContain('settings save unavailable');

        // A production run re-scans; the fresh plan of the now-empty settings
        // has no work either, so only the durability guard can keep it going.
        const secondPlan = await planFor({
            entries: {},
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': { h1: { context: 'about dragons', keywords: ['dragon'] } },
            },
        });
        const second = await harness.run({ plan: secondPlan });
        expect(second.status).toBe('complete');
        // A new attempt (not a resumption): the earlier one finished its work,
        // it just never became durable.
        expect(second.resumed).toBe(false);
        expect(second.counts.patched).toBe(0);
        expect(second.counts.deleted).toBe(0);
        expect(second.saveError).toBeNull();
        expect(getSweepStamp({ [CHUNK_META_SWEEP_STAMP_KEY]: second.stamp }).persisted).toBe(true);
    });

    it('does not count a settings copy that was already gone', async () => {
        const entries = { h1: { context: 'about dragons', keywords: ['dragon'] } };
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': { h1: { context: 'about dragons', keywords: ['dragon'] } },
            },
        });
        const harness = makeHarness({ plan, settings: {} });
        harness.deleteEntry.mockImplementation(() => false);

        const result = await harness.run();

        expect(result.status).toBe('complete');
        expect(result.counts.deleted).toBe(0);
    });

    it('stamps a run that had nothing to move, so support can tell it ran', async () => {
        const plan = await planFor({
            entries: {},
            collections: [collection('A')],
            chunksByCollection: { 'qdrant:A': {} },
        });
        const harness = makeHarness({ plan, settings: {} });

        const result = await harness.run();

        expect(result.status).toBe('complete');
        expect(result.stamp.counts).toEqual({
            entries: 0, patched: 0, deleted: 0, refused: 0, failed: 0,
        });
        expect(harness.persistSettings).toHaveBeenCalledTimes(1);
    });
});

describe('sweep execution — the settings payload shrinks', () => {
    it('serializes measurably smaller after a run', async () => {
        const entries = Object.fromEntries(
            Array.from({ length: 200 }, (_, index) => [
                `h${index}`,
                { context: `chunk ${index}`, keywords: [`keyword ${index}`] },
            ]),
        );
        const plan = await planFor({
            entries,
            collections: [collection('A')],
            chunksByCollection: {
                'qdrant:A': Object.fromEntries(
                    Object.entries(entries).map(([hash, metadata]) => [hash, metadata]),
                ),
            },
        });
        const settings = {
            chunk_size: 500,
            ...Object.fromEntries(
                Object.entries(entries).map(([hash, metadata]) => [`${PREFIX}${hash}`, metadata]),
            ),
        };
        const before = Buffer.byteLength(JSON.stringify(settings), 'utf8');
        const harness = makeHarness({ plan, settings });

        await harness.run();

        const after = Buffer.byteLength(JSON.stringify(settings), 'utf8');
        expect(after).toBeLessThan(before);
        expect(Object.keys(settings).filter(key => key.startsWith(PREFIX))).toHaveLength(0);
    });
});

describe('sweep execution — a plan it cannot act on', () => {
    it('refuses to run without a plan', async () => {
        await expect(executeChunkMetaSweep({})).rejects.toThrow(/plan/);
    });

    it('refuses a patch the caller did not ask for', async () => {
        const plan = {
            trusted: true,
            counts: { redundant: 0, patch: 1, orphan: 0, skipped: 0 },
            redundant: [],
            deletable: [],
            patch: [{ hash: 'h1', registryKey: 'qdrant:A', collectionId: 'A', fields: { context: 'x' } }],
            orphan: [],
            skipped: [],
            perCollection: [],
            coverage: { registered: 1, scanned: 1, chunksRead: 1 },
        };

        await expect(executeChunkMetaSweep({ plan, patchMetadata: undefined }))
            .rejects.toThrow(/patchMetadata/);
    });
});
