/**
 * Chunk-metadata backup — the escape hatch before the irreversible sweep.
 *
 * ADR-0003 decision 6 makes the sweep the only destructive step; ticket 04 gives
 * it a backup whose contents are exactly what the sweep would consider. The
 * document is built from the dry-run plan, so the two can never disagree about
 * which entry is redundant, patchable, an orphan or skipped, and it carries its
 * own counts, timestamp and collection index so the file explains itself long
 * after the session that wrote it is gone.
 *
 * Seams: `buildChunkMetaBackup({ entries, plan, now })` for the document,
 * `serializeChunkMetaBackup()` for the file, and the backup view module for the
 * download labels. Plans come from the real planner, not a hand-shaped stub, so
 * a classification change fails these tests too.
 */

import { describe, it, expect, vi } from 'vitest';

import {
    buildChunkMetaBackup,
    serializeChunkMetaBackup,
} from '../core/chunk-meta-backup.js';
import { buildBackupDownload, backupFilename } from '../core/chunk-meta-backup-view.js';
import { planChunkMetaSweep } from '../core/chunk-meta-sweep.js';

/** One registered collection as the loader's read-only listing returns it. */
function collection(id, registryKey = id) {
    return { registryKey, collectionId: id };
}

/** A completed scan for one collection; chunks is hash -> payload metadata. */
function scan(id, chunks, status = 'ok', registryKey = id) {
    return { registryKey, collectionId: id, status, chunks: new Map(Object.entries(chunks || {})) };
}

const NOW = new Date('2026-11-12T09:30:00.000Z');

/**
 * Four entries covering every classification the sweep can produce, against one
 * readable collection:
 *   - redundant   the payload already holds every field
 *   - patchMe     the payload lacks keywords
 *   - gone        in no collection
 *   - summaryOnly carries `summaries`, which no payload holds
 */
const ENTRIES = {
    redundant: { context: 'about dragons', keywords: ['dragon'], enabled: true },
    patchMe: { context: 'about elves', keywords: ['elf'] },
    gone: { context: 'a deleted chunk', importance: 3 },
    summaryOnly: { context: 'about dwarves', summaries: ['a summary'] },
};

function fixturePlan({ entries = ENTRIES, scans, collections, clientOnlyFields = ['summaries'] } = {}) {
    return planChunkMetaSweep({
        entries,
        collections: collections || [collection('A', 'qdrant:A')],
        scans: scans || [scan('A', {
            redundant: { context: 'about dragons', keywords: ['dragon'], enabled: true },
            patchMe: { context: 'about elves' },
            summaryOnly: { context: 'about dwarves' },
        }, 'ok', 'qdrant:A')],
        clientOnlyFields,
    });
}

describe('chunk-metadata backup — the document', () => {
    it('is self-describing: format, version, timestamp, counts and the collection index', () => {
        const document = buildChunkMetaBackup({ entries: ENTRIES, plan: fixturePlan(), now: NOW });

        expect(document.format).toBe('vectfox-chunk-meta-backup');
        expect(document.version).toBe(1);
        expect(document.generatedAt).toBe('2026-11-12T09:30:00.000Z');
        // A restore needs to know where the fields came from, not just what they are.
        expect(document.source).toEqual({
            store: 'extension_settings.vectfox',
            keyPattern: 'vectfox_chunk_meta_<hash>',
        });
        expect(document.counts).toEqual({
            entries: 4,
            redundant: 1,
            patch: 1,
            orphan: 1,
            skipped: 1,
            skippedByReason: { unverified: 0, clientOnly: 1 },
            collections: 1,
            chunksRead: 3,
        });
        expect(document.collections).toEqual([
            {
                registryKey: 'qdrant:A',
                collectionId: 'A',
                status: 'ok',
                chunkCount: 3,
                redundant: 1,
                patch: 1,
                skipped: 1,
            },
        ]);
    });

    it('contains every considered entry with its hash and its fields, orphans included', () => {
        const document = buildChunkMetaBackup({ entries: ENTRIES, plan: fixturePlan(), now: NOW });

        expect(document.entries).toHaveLength(4);
        expect(document.entries.map(entry => entry.hash)).toEqual(Object.keys(ENTRIES));
        for (const entry of document.entries) {
            expect(entry.fields).toEqual(ENTRIES[entry.hash]);
        }
    });

    it('classifies each entry exactly as the plan did', () => {
        const document = buildChunkMetaBackup({ entries: ENTRIES, plan: fixturePlan(), now: NOW });
        const byHash = Object.fromEntries(document.entries.map(entry => [entry.hash, entry]));

        expect(byHash.redundant).toMatchObject({ kind: 'redundant', collections: ['qdrant:A'] });
        expect(byHash.patchMe).toMatchObject({ kind: 'patch', collections: ['qdrant:A'] });
        expect(byHash.gone).toMatchObject({ kind: 'orphan', collections: [] });
        expect(byHash.summaryOnly).toMatchObject({
            kind: 'skipped',
            reason: 'client-only',
            collections: ['qdrant:A'],
        });
        // Restoring the settings copy must not lose the client-only field.
        expect(byHash.summaryOnly.fields.summaries).toEqual(['a summary']);
    });

    it('records a hash shared by two collections as one entry with both collections', () => {
        const entries = { shared: { context: 'about dragons', keywords: ['dragon'] } };
        const plan = fixturePlan({
            entries,
            collections: [collection('A', 'qdrant:A'), collection('B', 'qdrant:B')],
            scans: [
                scan('A', { shared: { context: 'about dragons', keywords: ['dragon'] } }, 'ok', 'qdrant:A'),
                scan('B', { shared: { context: 'about dragons', keywords: ['dragon'] } }, 'ok', 'qdrant:B'),
            ],
        });

        const document = buildChunkMetaBackup({ entries, plan, now: NOW });

        expect(document.entries).toEqual([
            {
                hash: 'shared',
                kind: 'redundant',
                collections: ['qdrant:A', 'qdrant:B'],
                fields: { context: 'about dragons', keywords: ['dragon'] },
            },
        ]);
    });

    it('keeps an untrusted run\'s classification and states why it is untrusted', () => {
        const entries = { uncertain: { context: 'unknown' } };
        const plan = fixturePlan({
            entries,
            collections: [collection('A', 'qdrant:A'), collection('B', 'qdrant:B')],
            scans: [
                scan('A', {}, 'ok', 'qdrant:A'),
                { registryKey: 'qdrant:B', collectionId: 'B', status: 'failed', chunks: new Map(), error: 'boom' },
            ],
        });

        const document = buildChunkMetaBackup({ entries, plan, now: NOW });

        expect(document.trusted).toBe(false);
        expect(document.untrustedReason).toBe('failed');
        expect(document.entries).toEqual([
            {
                hash: 'uncertain',
                kind: 'skipped',
                reason: 'unverified',
                collections: ['qdrant:B'],
                fields: { context: 'unknown' },
            },
        ]);
        expect(document.collections.map(row => row.status)).toEqual(['ok', 'failed']);
    });

    it('refuses to write a backup that would leave an entry out', () => {
        const plan = fixturePlan();

        expect(() => buildChunkMetaBackup({ entries: { ...ENTRIES, extra: { context: 'new' } }, plan, now: NOW }))
            .toThrow(/extra/);
        expect(() => buildChunkMetaBackup({ plan, now: NOW }))
            .toThrow(/entries/);
    });
});

describe('chunk-metadata backup — the download view', () => {
    it('carries the filename, the file and the entry label the panel shows', () => {
        const document = buildChunkMetaBackup({ entries: ENTRIES, plan: fixturePlan(), now: NOW });

        const download = buildBackupDownload(document, '{"format":"x"}');

        expect(download).toEqual({
            filename: 'vectfox-chunk-meta-backup-2026-11-12T09-30-00-000Z.json',
            text: '{"format":"x"}',
            entries: { count: 4, label: '4 entries' },
        });
    });

    it('labels a single entry in the singular', () => {
        const entries = { only: { context: 'one chunk' } };
        const plan = fixturePlan({
            entries,
            scans: [scan('A', { only: { context: 'one chunk' } }, 'ok', 'qdrant:A')],
        });

        const download = buildBackupDownload(buildChunkMetaBackup({ entries, plan, now: NOW }), '{}');

        expect(download.entries).toEqual({ count: 1, label: '1 entry' });
    });
});

describe('chunk-metadata backup — filename', () => {
    it('names the file after the timestamp so two backups never collide', () => {
        expect(backupFilename('2026-11-12T09:30:00.000Z'))
            .toBe('vectfox-chunk-meta-backup-2026-11-12T09-30-00-000Z.json');
    });
});

describe('chunk-metadata backup — serialization', () => {
    /** A backup document shaped like a real one, over `count` entries. */
    function largeDocument(count) {
        return {
            format: 'vectfox-chunk-meta-backup',
            version: 1,
            generatedAt: '2026-11-12T09:30:00.000Z',
            trusted: true,
            untrustedReason: null,
            counts: { entries: count },
            collections: [{ registryKey: 'qdrant:A', collectionId: 'A', status: 'ok' }],
            entries: Array.from({ length: count }, (_, index) => ({
                hash: `hash-${index}`,
                kind: 'redundant',
                collections: ['qdrant:A'],
                fields: { context: `chunk ${index}`, keywords: [`keyword-${index}`] },
            })),
        };
    }

    it('serializes to JSON that parses back to the same document', async () => {
        const document = buildChunkMetaBackup({ entries: ENTRIES, plan: fixturePlan(), now: NOW });

        const parsed = JSON.parse(await serializeChunkMetaBackup(document, { yieldControl: async () => {} }));

        expect(parsed).toEqual(document);
    });

    it('writes tens of thousands of entries in chunks, yielding between them', async () => {
        const count = 30000;
        const document = largeDocument(count);
        const yieldControl = vi.fn(async () => {});
        const onProgress = vi.fn();

        const text = await serializeChunkMetaBackup(document, {
            chunkSize: 1000,
            yieldControl,
            onProgress,
        });

        // 30 chunks, one yield after each: the main thread is never held across
        // the whole 30k-entry write.
        expect(yieldControl).toHaveBeenCalledTimes(30);
        expect(onProgress.mock.calls.at(-1)[0]).toEqual({ done: count, total: count });

        const parsed = JSON.parse(text);
        expect(parsed.entries).toHaveLength(count);
        expect(parsed.entries[0]).toEqual(document.entries[0]);
        expect(parsed.entries[count - 1]).toEqual(document.entries[count - 1]);
        expect(parsed.collections).toEqual(document.collections);
    });

    it('keeps the JSON valid across a final partial chunk', async () => {
        const yieldControl = vi.fn(async () => {});

        const text = await serializeChunkMetaBackup(largeDocument(5), { chunkSize: 2, yieldControl });

        expect(yieldControl).toHaveBeenCalledTimes(3);
        expect(JSON.parse(text).entries.map(entry => entry.hash))
            .toEqual(['hash-0', 'hash-1', 'hash-2', 'hash-3', 'hash-4']);
    });

    it('writes a document with no entries without inventing one', async () => {
        const document = { ...largeDocument(0), entries: [] };

        const parsed = JSON.parse(await serializeChunkMetaBackup(document, { yieldControl: async () => {} }));

        expect(parsed.entries).toEqual([]);
        expect(parsed.counts).toEqual({ entries: 0 });
    });

    it('uses the default chunk size and host yield when neither is supplied', async () => {
        const document = largeDocument(2001);

        const parsed = JSON.parse(await serializeChunkMetaBackup(document));

        expect(parsed.entries).toHaveLength(2001);
    });
});
