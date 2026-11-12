/**
 * Dry-run composition — the seam the Size Inspector button actually calls.
 *
 * `createStorageDryRun` is the host-free composition of live settings, registry
 * collections, legacy entries and the plugin transport. These tests pin what the
 * production wiring must guarantee: the plugin gate, routing each collection by
 * its registry key, no patch calls, and the report shape the panel renders.
 *
 * Seam: `createStorageDryRun(deps)` with fake dependencies — no SillyTavern host
 * modules are needed.
 */

import { describe, it, expect, vi } from 'vitest';

import { createStorageDryRun } from '../core/chunk-meta-storage-actions.js';
import { createFakeChunkListing } from './fixtures/chunk-listing.js';

/** A fake plugin transport; only `isAvailable` and `listChunks` may be called. */
function createFakeTransport({ available = true, chunksByRegistryKey = {}, failing = [] } = {}) {
    const { listChunks, patchMetadata } = createFakeChunkListing({
        chunksByCollection: chunksByRegistryKey,
        failing,
        reportTotal: true,
    });
    return {
        transport: { isAvailable: () => available, listChunks, patchMetadata },
        listChunks,
        patchMetadata,
    };
}

function makeRun({ transport, collections, entries, clientOnlyFields = [] }) {
    const createTransport = vi.fn(() => transport);
    const listCollections = vi.fn(() => collections);
    const listEntries = vi.fn(() => entries);
    const run = createStorageDryRun({ createTransport, listCollections, listEntries, clientOnlyFields });
    return { run, createTransport, listCollections, listEntries };
}

describe('storage dry run — when it refuses to run', () => {
    it('reports itself unconfigured rather than pretending there is nothing to do', async () => {
        const report = await createStorageDryRun()({});

        expect(report.status).toBe('unavailable');
        expect(report.reason).toMatch(/not configured/);
    });

    it('reports unavailable while the settings object is missing', async () => {
        const { run } = makeRun({
            transport: createFakeTransport().transport,
            collections: [],
            entries: {},
        });

        const report = await run({ getSettings: () => null });

        expect(report.status).toBe('unavailable');
        expect(report.reason).toMatch(/not available yet/);
    });

    it('scans nothing without the plugin, and says so', async () => {
        const { transport } = createFakeTransport({ available: false });
        const { run, listCollections } = makeRun({ transport, collections: [], entries: { h1: {} } });

        const report = await run({ getSettings: () => ({}) });

        expect(report.status).toBe('unavailable');
        expect(report.reason).toMatch(/Similharity plugin is not available/);
        expect(listCollections).not.toHaveBeenCalled();
    });
});

describe('storage dry run — the production seam', () => {
    it('passes the live settings getter to the transport factory', async () => {
        const settings = { chunk_size: 500 };
        const { transport } = createFakeTransport();
        const { run, createTransport } = makeRun({ transport, collections: [], entries: {} });

        await run({ getSettings: () => settings });

        const passed = createTransport.mock.calls[0][0];
        expect(passed.getSettings()).toBe(settings);
    });

    it('lists every registered collection by registry key and reports them by id', async () => {
        const { transport, listChunks } = createFakeTransport({
            chunksByRegistryKey: {
                'qdrant:A': { h1: { context: 'about dragons' } },
                'standard:A': {},
            },
        });
        const { run, listEntries } = makeRun({
            transport,
            collections: [
                { registryKey: 'qdrant:A', collectionId: 'A' },
                { registryKey: 'standard:A', collectionId: 'A' },
            ],
            entries: {
                h1: { context: 'about dragons' },
                gone: { context: 'deleted chunk' },
            },
        });

        const report = await run({ getSettings: () => ({}) });

        expect(listEntries).toHaveBeenCalledTimes(1);
        expect(listChunks.mock.calls.map(call => call[0])).toEqual(['qdrant:A', 'standard:A']);
        expect(report.status).toBe('measured');
        expect(report.trusted).toBe(true);
        expect(report.collections.map(row => row.collectionId)).toEqual(['A', 'A']);
        expect(report.collections.map(row => row.registryKey)).toEqual(['qdrant:A', 'standard:A']);
        expect(report.totals.redundant.count).toBe(1);
        expect(report.totals.orphan.count).toBe(1);
    });

    it('never patches: the run only lists', async () => {
        const { transport, patchMetadata } = createFakeTransport({
            chunksByRegistryKey: { 'qdrant:A': { h1: { context: 'about dragons' } } },
        });
        const { run } = makeRun({
            transport,
            collections: [{ registryKey: 'qdrant:A', collectionId: 'A' }],
            entries: { h1: { context: 'about dragons' } },
        });

        await run({ getSettings: () => ({}) });

        expect(patchMetadata).not.toHaveBeenCalled();
    });

    it('keeps an untrusted report untrusted, with deletion refused', async () => {
        const { transport } = createFakeTransport({
            chunksByRegistryKey: { 'qdrant:A': {} },
            failing: ['qdrant:B'],
        });
        const { run } = makeRun({
            transport,
            collections: [
                { registryKey: 'qdrant:A', collectionId: 'A' },
                { registryKey: 'qdrant:B', collectionId: 'B' },
            ],
            entries: { h1: { context: 'unknown' } },
        });

        const report = await run({ getSettings: () => ({}) });

        expect(report.trusted).toBe(false);
        expect(report.refusal).toMatch(/Deletion is refused/);
        expect(report.totals.skipped.count).toBe(1);
        expect(report.skippedNote).toMatch(/could not be attributed/);
    });

    it('passes the client-only field list through, so summaries are never proposed for deletion', async () => {
        const { transport } = createFakeTransport({
            chunksByRegistryKey: { 'qdrant:A': { h1: { context: 'about dragons' } } },
        });
        const { run } = makeRun({
            transport,
            collections: [{ registryKey: 'qdrant:A', collectionId: 'A' }],
            entries: { h1: { context: 'about dragons', summaries: ['a summary'] } },
            clientOnlyFields: ['summaries'],
        });

        const report = await run({ getSettings: () => ({}) });

        expect(report.totals.skipped.count).toBe(1);
        expect(report.totals.redundant.count).toBe(0);
    });
});
