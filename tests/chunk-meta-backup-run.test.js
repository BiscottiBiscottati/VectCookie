/**
 * Backup composition — the production seam the Size Inspector's backup button
 * actually calls.
 *
 * Ticket 04 requires that the download describe exactly what the sweep sees, so
 * `createStorageBackup` must not grow a scanning path of its own: it shares the
 * dry run's gate, scan and plan, then serializes the same plan. These tests pin
 * that: the same fake transport and entries produce a backup whose counts equal
 * the dry-run report's, the plugin gate answers both the same way, and the read
 * path issues no patch and no settings write.
 *
 * Seam: `createStorageBackup(deps)` with fake dependencies — no SillyTavern host
 * modules are needed.
 */

import { describe, it, expect, vi } from 'vitest';

import { createStorageBackup, createStorageDryRun } from '../core/chunk-meta-dry-run.js';
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

function makeDeps({ transport, collections, entries, clientOnlyFields = [] }) {
    const createTransport = vi.fn(() => transport);
    const listCollections = vi.fn(() => collections);
    const listEntries = vi.fn(() => entries);
    const deps = { createTransport, listCollections, listEntries, clientOnlyFields };
    return { deps, createTransport, listCollections, listEntries };
}

const NOW = new Date('2026-11-12T09:30:00.000Z');

/**
 * One readable collection holding a redundant entry and an entry whose payload
 * lacks keywords, plus a deleted chunk and a client-only entry in settings.
 */
const FIXTURE = {
    collections: [{ registryKey: 'qdrant:A', collectionId: 'A' }],
    chunksByRegistryKey: {
        'qdrant:A': {
            redundant: { context: 'about dragons', keywords: ['dragon'] },
            patchMe: { context: 'about elves' },
            summaryOnly: { context: 'about dwarves' },
        },
    },
    entries: {
        redundant: { context: 'about dragons', keywords: ['dragon'] },
        patchMe: { context: 'about elves', keywords: ['elf'] },
        gone: { context: 'a deleted chunk' },
        summaryOnly: { context: 'about dwarves', summaries: ['a summary'] },
    },
    clientOnlyFields: ['summaries'],
};

function backupOf(fixture, options = {}) {
    const { transport, patchMetadata, listChunks } = createFakeTransport(fixture);
    const { deps, listEntries } = makeDeps({ transport, ...fixture });
    const run = createStorageBackup(deps);
    return {
        run: (overrides = {}) => run({ getSettings: () => ({}), now: NOW, ...options, ...overrides }),
        patchMetadata,
        listChunks,
        listEntries,
    };
}

describe('storage backup — when it refuses to run', () => {
    it('reports itself unconfigured rather than downloading an empty file', async () => {
        const result = await createStorageBackup()({});

        expect(result.status).toBe('unavailable');
        expect(result.reason).toMatch(/not configured/);
    });

    it('reports unavailable while the settings object is missing', async () => {
        const { run, listEntries } = backupOf(FIXTURE);

        const result = await run({ getSettings: () => null });

        expect(result.status).toBe('unavailable');
        expect(result.reason).toMatch(/not available yet/);
        expect(listEntries).not.toHaveBeenCalled();
    });

    it('scans nothing without the plugin, and says so', async () => {
        const { run, listChunks } = backupOf({ ...FIXTURE, available: false });

        const result = await run();

        expect(result.status).toBe('unavailable');
        expect(result.reason).toMatch(/Similharity plugin is not available/);
        expect(listChunks).not.toHaveBeenCalled();
    });
});

describe('storage backup — the same scan the dry run reports on', () => {
    it('classifies and counts exactly like the dry run over the same sources', async () => {
        const { transport, patchMetadata, listChunks } = createFakeTransport(FIXTURE);
        const { deps, listEntries } = makeDeps({ transport, ...FIXTURE });

        const report = await createStorageDryRun(deps)({ getSettings: () => ({}) });
        const result = await createStorageBackup(deps)({
            getSettings: () => ({}),
            now: NOW,
            yieldControl: async () => {},
        });

        expect(listEntries).toHaveBeenCalledTimes(2); // one per action, never per collection
        expect(listChunks).toHaveBeenCalledTimes(2); // one collection listed once per scan
        expect(patchMetadata).not.toHaveBeenCalled();

        const document = JSON.parse(result.text);
        expect(document.counts.redundant).toBe(report.totals.redundant.count);
        expect(document.counts.patch).toBe(report.totals.patch.count);
        expect(document.counts.orphan).toBe(report.totals.orphan.count);
        expect(document.counts.skipped).toBe(report.totals.skipped.count);
        expect(document.counts.entries).toBe(report.totals.entries.count);
        expect(document.counts.chunksRead).toBe(report.totals.chunks.count);

        // The report of the scan the file was built from travels with the file,
        // so the panel can show those counts beside the download.
        expect(result.entries).toEqual({ count: 4, label: '4 entries' });
        expect(result.view).toEqual(report);
    });

    it('contains every considered entry, orphans included, with its hash and fields', async () => {
        const { run } = backupOf(FIXTURE);

        const result = await run({ yieldControl: async () => {} });

        const document = JSON.parse(result.text);
        expect(document.entries.map(entry => entry.hash)).toEqual(Object.keys(FIXTURE.entries));
        const byHash = Object.fromEntries(document.entries.map(entry => [entry.hash, entry]));
        expect(byHash.redundant.kind).toBe('redundant');
        expect(byHash.patchMe.kind).toBe('patch');
        expect(byHash.gone.kind).toBe('orphan');
        expect(byHash.summaryOnly).toMatchObject({ kind: 'skipped', reason: 'client-only' });
        for (const entry of document.entries) {
            expect(entry.fields).toEqual(FIXTURE.entries[entry.hash]);
        }
    });

    it('records the collection index it was built from', async () => {
        const { run } = backupOf(FIXTURE);

        const result = await run({ yieldControl: async () => {} });

        const document = JSON.parse(result.text);
        expect(document.collections).toEqual([{
            registryKey: 'qdrant:A',
            collectionId: 'A',
            status: 'ok',
            chunkCount: 3,
            redundant: 1,
            patch: 1,
            skipped: 1,
        }]);
        expect(document.format).toBe('vectfox-chunk-meta-backup');
        expect(document.version).toBe(1);
    });

    it('still contains every entry when the scan is untrusted, and says why', async () => {
        const { run } = backupOf({ ...FIXTURE, failing: ['qdrant:B'], collections: [
            { registryKey: 'qdrant:A', collectionId: 'A' },
            { registryKey: 'qdrant:B', collectionId: 'B' },
        ] });

        const result = await run({ yieldControl: async () => {} });

        const document = JSON.parse(result.text);
        expect(document.trusted).toBe(false);
        expect(document.untrustedReason).toBe('failed');
        expect(document.entries).toHaveLength(4);
        expect(document.entries.find(entry => entry.hash === 'gone'))
            .toMatchObject({ kind: 'skipped', reason: 'unverified' });
        expect(document.collections.map(row => row.status)).toEqual(['ok', 'failed']);
    });

    it('writes the entries as skipped, not orphans, when nothing is registered', async () => {
        const { run } = backupOf({ ...FIXTURE, collections: [], chunksByRegistryKey: {} });

        const result = await run({ yieldControl: async () => {} });

        const document = JSON.parse(result.text);
        expect(document.trusted).toBe(false);
        expect(document.untrustedReason).toBe('empty-registry');
        expect(document.entries.every(entry => entry.kind === 'skipped')).toBe(true);
        expect(document.collections).toEqual([]);
    });

    it('stamps the file and names it from the stamp', async () => {
        const { run } = backupOf(FIXTURE);

        const result = await run({ yieldControl: async () => {} });

        expect(result.filename).toBe('vectfox-chunk-meta-backup-2026-11-12T09-30-00-000Z.json');
        expect(JSON.parse(result.text).generatedAt).toBe('2026-11-12T09:30:00.000Z');
    });
});

describe('storage backup — progress', () => {
    it('reports the scan, then the file being written', async () => {
        const { run } = backupOf(FIXTURE);
        const scanProgress = vi.fn();
        const encodeProgress = vi.fn();
        const yielded = vi.fn(async () => {});

        await run({ onProgress: scanProgress, onEncode: encodeProgress, chunkSize: 2, yieldControl: yielded });

        expect(scanProgress).toHaveBeenCalledWith(expect.objectContaining({ done: 1, total: 1 }));
        expect(encodeProgress).toHaveBeenCalledWith({ done: 2, total: 4 });
        expect(encodeProgress).toHaveBeenLastCalledWith({ done: 4, total: 4 });
        expect(yielded).toHaveBeenCalledTimes(2);
    });
});
