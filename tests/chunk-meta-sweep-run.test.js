/**
 * Dry run — the read-only scan through every registered collection.
 *
 * Ticket 03 of the chunk-meta-store feature: a dry run reports, per collection
 * and in total, how many settings chunk-metadata entries are redundant, need
 * patching, are orphans, or were skipped, and writes nothing. The seam is the
 * dry-run entry point: it takes a fake `listChunks`, a plain entries object and
 * the registered collections, and returns the plan plus the report the Size
 * Inspector shows.
 *
 * What these tests pin beyond the planner table (chunk-meta-sweep-plan.test.js):
 * pagination reads every chunk, one failed collection does not abort the run,
 * the report states that deletion is refused for an untrusted scan, and two
 * runs produce the same report without writing anything.
 */

import { describe, it, expect, vi } from 'vitest';

import { runChunkMetaDryRun } from '../core/chunk-meta-sweep-report.js';
import { createFakeChunkListing } from './fixtures/chunk-listing.js';

function collection(id, registryKey = id) {
    return { registryKey, collectionId: id };
}

/** Compact report projection: the per-collection rows and the totals. */
function reportOf(run) {
    return {
        trusted: run.view.trusted,
        refusal: run.view.refusal,
        coverage: run.view.coverageLabel,
        totals: {
            entries: run.view.totals.entries.count,
            redundant: run.view.totals.redundant.count,
            patch: run.view.totals.patch.count,
            orphan: run.view.totals.orphan.count,
            skipped: run.view.totals.skipped.count,
        },
        collections: run.view.collections.map(row => ({
            collectionId: row.collectionId,
            status: row.status,
            chunks: row.chunkCount.count,
            redundant: row.redundant.count,
            patch: row.patch.count,
            skipped: row.skipped.count,
        })),
    };
}

describe('dry run — pagination reads every chunk of every collection', () => {
    it('walks every page, so an entry on the last page is classified from it', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: {
                A: {
                    h1: { context: 'about dragons' },
                    h2: {},
                    h3: {},
                    h4: {},
                    h5: { context: 'about dragons' },
                },
            },
        });
        const run = await runChunkMetaDryRun({
            entries: { h5: { context: 'about dragons' } },
            collections: [collection('A')],
            listChunks: listing.listChunks,
            pageSize: 2,
        });

        expect(listing.calls.map(call => call.offset)).toEqual([0, 2, 4]);
        expect(listing.calls.map(call => call.limit)).toEqual([2, 2, 2]);
        expect(run.plan.counts).toEqual({ redundant: 1, patch: 0, orphan: 0, skipped: 0 });
        expect(run.view.collections[0].chunkCount.count).toBe(5);
    });

    it('stops on a short first page', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: { A: { h1: { context: 'x' }, h2: {} } },
        });
        await runChunkMetaDryRun({
            entries: {},
            collections: [collection('A')],
            listChunks: listing.listChunks,
            pageSize: 10,
        });

        expect(listing.calls).toHaveLength(1);
    });

    it('stops when a backend ignores offset instead of looping forever', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: { A: { h1: {}, h2: {} } },
            ignoreOffset: true,
        });
        await runChunkMetaDryRun({
            entries: {},
            collections: [collection('A')],
            listChunks: listing.listChunks,
            pageSize: 2,
        });

        // First page: two new hashes. Second page: the same two, adding nothing.
        expect(listing.calls).toHaveLength(2);
    });

    it('reads every registered collection, not only the one that is open', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: {
                A: {},
                B: { shared: { context: 'about elves' } },
            },
        });
        const run = await runChunkMetaDryRun({
            entries: { shared: { context: 'about elves' } },
            collections: [collection('A'), collection('B')],
            listChunks: listing.listChunks,
        });

        expect(listing.calls.map(call => call.collectionId)).toEqual(['A', 'B']);
        expect(run.plan.counts.orphan).toBe(0);
        expect(run.plan.counts.redundant).toBe(1);
        expect(run.view.collections[1].redundant.count).toBe(1);
        expect(run.view.coverageLabel).toBe('2 of 2 collections fully read');
    });
});

describe('dry run — one collection failing does not abort the run', () => {
    it('reads what it can and skips every entry the failure could not verify', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: {
                A: { known: { context: 'about dragons' } },
                B: {},
            },
            failing: ['B'],
        });
        const run = await runChunkMetaDryRun({
            entries: {
                known: { context: 'about dragons' },
                maybeInB: { context: 'unknown' },
            },
            collections: [collection('A'), collection('B')],
            listChunks: listing.listChunks,
        });

        expect(reportOf(run)).toEqual({
            trusted: false,
            refusal: expect.stringMatching(/Deletion is refused.*1 of 2 collections could not be read/),
            coverage: '1 of 2 collections fully read',
            totals: { entries: 2, redundant: 1, patch: 0, orphan: 0, skipped: 1 },
            collections: [
                { collectionId: 'A', status: 'read', chunks: 1, redundant: 1, patch: 0, skipped: 0 },
                { collectionId: 'B', status: 'failed', chunks: 0, redundant: 0, patch: 0, skipped: 0 },
            ],
        });
    });

    it('marks a collection whose payload metadata never arrived, and proposes no deletion', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: { A: { h1: {} } },
        });
        const run = await runChunkMetaDryRun({
            entries: { h1: { context: 'about dragons' } },
            collections: [collection('A')],
            listChunks: listing.listChunks,
        });

        expect(run.view.trusted).toBe(false);
        expect(run.view.refusal).toMatch(/Deletion is refused.*no chunk metadata/);
        expect(run.view.collections[0].status).toBe('no metadata');
        // Patching is still allowed on an untrusted run: the fields are known.
        expect(run.plan.patch).toEqual([
            { hash: 'h1', registryKey: 'A', collectionId: 'A', fields: { context: 'about dragons' } },
        ]);
    });
});

describe('dry run — counts are reported per collection and in total', () => {
    it('shows every category on the collection rows and the totals', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: {
                A: {
                    redundant: { context: 'about dragons', keywords: ['dragon'] },
                    patchMe: { context: 'about elves' },
                },
                B: {
                    redundant: { context: 'about dragons', keywords: ['dragon'] },
                },
            },
        });
        const run = await runChunkMetaDryRun({
            entries: {
                redundant: { context: 'about dragons', keywords: ['dragon'] },
                patchMe: { context: 'about elves', keywords: ['elf'] },
                orphanCandidate: { context: 'gone' },
            },
            collections: [collection('A'), collection('B')],
            listChunks: listing.listChunks,
        });

        expect(reportOf(run)).toEqual({
            trusted: true,
            refusal: null,
            coverage: '2 of 2 collections fully read',
            totals: { entries: 3, redundant: 1, patch: 1, orphan: 1, skipped: 0 },
            collections: [
                { collectionId: 'A', status: 'read', chunks: 2, redundant: 1, patch: 1, skipped: 0 },
                { collectionId: 'B', status: 'read', chunks: 1, redundant: 1, patch: 0, skipped: 0 },
            ],
        });
        expect(run.view.headline).toContain('3 entries');
    });
});

describe('dry run — zero writes and repeatable output', () => {
    it('only lists: no metadata patch is issued and no input is mutated', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: { A: { h1: { context: 'about dragons' } } },
        });
        const entries = { h1: { context: 'about dragons' }, gone: { context: 'x' } };
        const collections = [collection('A')];
        const entriesBefore = JSON.stringify(entries);
        const collectionsBefore = JSON.stringify(collections);

        await runChunkMetaDryRun({
            entries,
            collections,
            listChunks: listing.listChunks,
        });

        expect(listing.calls.length).toBeGreaterThan(0);
        expect(listing.patchCalls).toEqual([]);
        expect(JSON.stringify(entries)).toBe(entriesBefore);
        expect(JSON.stringify(collections)).toBe(collectionsBefore);
    });

    it('produces the same report on a second run, with the same reads', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: {
                A: { h1: { context: 'about dragons' }, h2: {} },
                B: { h1: { context: 'about dragons' } },
            },
        });
        const input = {
            entries: {
                h1: { context: 'about dragons', keywords: ['dragon'] },
                h2: { context: 'about elves' },
                gone: { context: 'x' },
            },
            collections: [collection('A'), collection('B')],
            listChunks: listing.listChunks,
        };

        const first = await runChunkMetaDryRun(input);
        const callsAfterFirst = listing.calls.length;
        const second = await runChunkMetaDryRun(input);

        expect(reportOf(second)).toEqual(reportOf(first));
        expect(listing.calls.length).toBe(callsAfterFirst * 2);
    });

    it('reports scan progress for each collection', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: { A: {}, B: {} },
        });
        const progress = [];

        await runChunkMetaDryRun({
            entries: {},
            collections: [collection('A'), collection('B')],
            listChunks: listing.listChunks,
            onProgress: update => progress.push(update),
        });

        expect(progress.map(update => update.done)).toContain(0);
        expect(progress.map(update => update.done)).toContain(2);
        expect(progress.every(update => update.total === 2)).toBe(true);
    });
});

describe('dry run — pagination trusts the backend total, not page length', () => {
    /** Five chunks as hash -> metadata. */
    const FIVE = { h1: {}, h2: {}, h3: {}, h4: {}, h5: { context: 'about dragons' } };

    it('keeps reading when the server caps the page size below the request', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: { A: FIVE },
            reportTotal: true,
            capLimit: 2,
        });
        const run = await runChunkMetaDryRun({
            entries: { h5: { context: 'about dragons' } },
            collections: [collection('A')],
            listChunks: listing.listChunks,
            pageSize: 5,
        });

        expect(listing.calls.map(call => call.offset)).toEqual([0, 2, 4]);
        expect(run.plan.counts.redundant).toBe(1);
        expect(run.plan.coverage.chunksRead).toBe(5);
    });

    it('refuses a listing that ends before the reported total instead of inventing orphans', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: { A: FIVE },
            ignoreOffset: true,
            reportTotal: true,
            capLimit: 2,
        });
        const run = await runChunkMetaDryRun({
            entries: { h5: { context: 'about dragons' } },
            collections: [collection('A')],
            listChunks: listing.listChunks,
            pageSize: 5,
        });

        expect(run.plan.trusted).toBe(false);
        expect(run.plan.untrustedReason).toBe('failed');
        // h5 was never seen, but that is not proof it is gone.
        expect(run.plan.counts.orphan).toBe(0);
        expect(run.plan.counts.skipped).toBe(1);
        expect(run.view.collections[0].status).toBe('failed');
    });

    it('carries the registry key through to the listing call, so both backends are read', async () => {
        const listing = createFakeChunkListing({
            chunksByCollection: { A: {} },
        });
        await runChunkMetaDryRun({
            entries: {},
            collections: [
                { registryKey: 'qdrant:A', collectionId: 'A' },
                { registryKey: 'standard:A', collectionId: 'A' },
            ],
            listChunks: listing.listChunks,
        });

        expect(listing.calls.map(call => call.registryKey)).toEqual(['qdrant:A', 'standard:A']);
    });
});
