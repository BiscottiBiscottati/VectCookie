/**
 * Tests: collection export/import chunk-metadata parity (ticket 10).
 *
 * Behaviour at the seam: `exportCollection` and `importCollection` are called
 * exactly as the DB browser calls them, with a fake plugin transport standing in
 * for the backend and a fake settings object standing in for the settings store.
 * Tests never reach into the store's mirror or the transfer module's internals —
 * they assert what the export file carries, what was inserted into the payload,
 * what was written to settings, and what was reported.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const host = vi.hoisted(() => {
    /** Content hash, deterministic for the same text. */
    const hash = (text) => {
        let value = 0;
        for (const character of String(text)) {
            value = (value * 31 + character.codePointAt(0)) % 1000000007;
        }
        return value;
    };
    return {
        hash,
        settings: { vectfox: {} },
        pluginAvailable: true,
        collections: new Map(),
        requests: [],
    };
});

vi.mock('../../../../extensions.js', () => ({
    extension_settings: host.settings,
    getContext: () => ({ name1: 'Tester' }),
}));

vi.mock('../../../../../script.js', () => ({
    getRequestHeaders: () => ({}),
    saveSettingsDebounced: vi.fn(),
    getCurrentChatId: () => null,
    chat_metadata: {},
}));

vi.mock('../../../../utils.js', () => ({
    getStringHash: (text) => host.hash(text),
}));

vi.mock('../core/providers.js', () => ({
    getModelFromSettings: () => 'model-x',
}));

vi.mock('../core/collection-loader.js', () => ({
    registerCollection: vi.fn(),
    isPluginAvailableCached: () => host.pluginAvailable,
}));

vi.mock('../core/core-vector-api.js', () => ({
    getSavedHashes: vi.fn(),
    insertVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
}));

vi.mock('../core/sparse-vector-encoder.js', () => ({
    encodeSparseVector: () => ({ indices: [], values: [] }),
}));

vi.mock('../ui/progress-tracker.js', () => ({
    progressTracker: {
        show: vi.fn(),
        updateProgress: vi.fn(),
        updateCurrentItem: vi.fn(),
        updateChunks: vi.fn(),
        updateEmbeddingProgress: vi.fn(),
        complete: vi.fn(),
        addError: vi.fn(),
        setCancelHandler: vi.fn(),
        clearCancelHandler: vi.fn(),
    },
}));

import { exportCollection, importCollection } from '../core/collection-export.js';
import { insertVectorItems, purgeVectorIndex } from '../core/core-vector-api.js';
import {
    configureChunkMetaStore,
    resetChunkMetaStore,
    useChunkMetaCollection,
} from '../core/collection-metadata.js';
import { LEGACY_CHUNK_META_PREFIX } from '../core/chunk-meta-keys.js';

// ---------------------------------------------------------------------------
// Fake backend: `/chunks/list` and both insert endpoints over one in-memory
// collection map, so an import's write is what a later export reads.
// ---------------------------------------------------------------------------

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
    return {
        ok,
        status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    };
}

function fakeFetch(url, init = {}) {
    const body = init.body ? JSON.parse(init.body) : {};
    host.requests.push({ url, body });

    if (url === '/api/plugins/similharity/chunks/list') {
        const chunks = host.collections.get(body.collectionId) || new Map();
        const all = [...chunks.values()];
        const offset = body.offset || 0;
        const limit = body.limit || 100;
        const items = all.slice(offset, offset + limit).map(chunk => ({
            hash: chunk.hash,
            vector: body.includeVectors ? chunk.vector : undefined,
            metadata: {
                hash: chunk.hash,
                text: chunk.text,
                index: chunk.index,
                ...(chunk.metadata || {}),
            },
        }));
        return Promise.resolve(jsonResponse({ success: true, items, total: all.length }));
    }

    if (url === '/api/plugins/similharity/chunks/insert') {
        const chunks = host.collections.get(body.collectionId) || new Map();
        for (const item of body.items) {
            chunks.set(String(item.hash), {
                hash: item.hash,
                text: item.text,
                index: item.index,
                vector: item.vector,
                metadata: { ...(item.metadata || {}) },
            });
        }
        host.collections.set(body.collectionId, chunks);
        return Promise.resolve(jsonResponse({ success: true }));
    }

    if (url === '/api/vector/insert') {
        const chunks = host.collections.get(body.collectionId) || new Map();
        for (const item of body.items) {
            chunks.set(String(item.hash), {
                hash: item.hash,
                text: item.text,
                index: item.index,
                vector: body.embeddings?.[item.text || ''],
                // The native API has no metadata slot; this is the point.
                metadata: {},
            });
        }
        host.collections.set(body.collectionId, chunks);
        return Promise.resolve(jsonResponse({ success: true }));
    }

    return Promise.reject(new Error(`unexpected request ${url}`));
}

function seedCollection(collectionId, chunks) {
    const byHash = new Map();
    for (const chunk of chunks) {
        byHash.set(String(chunk.hash ?? host.hash(chunk.text)), {
            index: chunk.index ?? byHash.size,
            vector: chunk.vector || [0.1, 0.2, 0.3],
            metadata: {},
            ...chunk,
            hash: chunk.hash ?? host.hash(chunk.text),
        });
    }
    host.collections.set(collectionId, byHash);
}

function settingsEntry(hash, metadata) {
    host.settings.vectfox[`${LEGACY_CHUNK_META_PREFIX}${hash}`] = metadata;
}

function chunkMetaOf(exportData) {
    const byHash = {};
    for (const chunk of exportData.chunks || []) {
        if (chunk.chunkMeta) byHash[String(chunk.hash)] = chunk.chunkMeta;
    }
    return byHash;
}

/** The settings store re-stamps `updatedAt`; compare the user fields. */
function withoutBookkeeping(metadata) {
    if (!metadata) return metadata;
    const { updatedAt, ...fields } = metadata;
    return fields;
}

/** VectFox settings object the extension functions receive. */
function vf() {
    return host.settings.vectfox;
}

beforeEach(() => {
    host.settings.vectfox = {
        embedding_provider: 'transformers',
        vector_backend: 'qdrant',
    };
    host.pluginAvailable = true;
    host.collections.clear();
    host.requests = [];
    globalThis.fetch = vi.fn(fakeFetch);
    purgeVectorIndex.mockImplementation(async (collectionId) => {
        host.collections.delete(collectionId);
    });
    // The re-embedding path goes through core-vector-api; keep its write in the
    // same fake backend so a later export reads what it inserted.
    insertVectorItems.mockImplementation(async (collectionId, items) => {
        const chunks = host.collections.get(collectionId) || new Map();
        for (const item of items) {
            chunks.set(String(item.hash), {
                hash: item.hash,
                text: item.text,
                index: item.index,
                vector: item.vector,
                metadata: { ...(item.metadata || {}) },
            });
        }
        host.collections.set(collectionId, chunks);
    });
    configureChunkMetaStore({ transport: null });
    resetChunkMetaStore();
});

// ---------------------------------------------------------------------------
// Export: metadata read from the collection being exported
// ---------------------------------------------------------------------------

describe('export reads chunk metadata from the collection payload', () => {
    it('attaches the payload fields to each chunk and reports them', async () => {
        seedCollection('col-a', [{
            text: 'alpha',
            metadata: { context: 'payload ctx', keywords: [{ text: 'alpha' }] },
        }]);

        const data = await exportCollection('col-a', vf(), { backend: 'qdrant' });

        expect(data.chunks[0].chunkMeta).toEqual({
            context: 'payload ctx',
            keywords: [{ text: 'alpha' }],
        });
        expect(data.chunkMetaReport).toEqual({
            chunks: 1,
            attached: 1,
            unmatchedSettingsEntries: { count: 0 },
        });
    });

    it('fills a field the payload lacks from settings, and carries only real values', async () => {
        const hash = host.hash('alpha');
        seedCollection('col-a', [{ text: 'alpha', metadata: { context: 'payload ctx' } }]);
        settingsEntry(hash, { context: 'stale', xmlTag: 'tag-from-settings', chunkLinks: [] });

        const data = await exportCollection('col-a', vf(), { backend: 'qdrant' });

        expect(data.chunks[0].chunkMeta).toEqual({
            context: 'payload ctx',
            xmlTag: 'tag-from-settings',
        });
        expect(data.chunkMetaReport.attached).toBe(1);
    });

    it('reads settings alone when the listing returned no payload metadata', async () => {
        const hash = host.hash('alpha');
        seedCollection('col-a', [{ text: 'alpha' }]);
        settingsEntry(hash, { context: 'settings only', summaries: [{ text: 'sum' }] });

        const data = await exportCollection('col-a', vf(), { backend: 'qdrant' });

        expect(data.chunks[0].chunkMeta).toEqual({
            context: 'settings only',
            summaries: [{ text: 'sum' }],
        });
        expect(data.chunkMetaReport.attached).toBe(1);
    });

    it('never borrows the payload of the collection a visualizer has open', async () => {
        const hash = host.hash('alpha');
        seedCollection('col-a', [{ text: 'alpha', metadata: { context: 'col-a ctx' } }]);
        // The same content hash sits in another collection, whose metadata is
        // hydrated because that collection is the current one.
        configureChunkMetaStore({
            transport: {
                isAvailable: () => true,
                listChunks: async () => ({
                    items: [{ hash, metadata: { hash, text: 'alpha', context: 'other col ctx' } }],
                    total: 1,
                }),
                patchMetadata: async () => {},
            },
        });
        await useChunkMetaCollection('col-other');

        const data = await exportCollection('col-a', vf(), { backend: 'qdrant' });

        expect(data.chunks[0].chunkMeta.context).toBe('col-a ctx');
    });

    it('reports settings entries whose chunk the collection no longer has', async () => {
        seedCollection('col-a', [{ text: 'alpha' }]);
        settingsEntry(host.hash('alpha'), { context: 'kept' });
        settingsEntry(host.hash('deleted text'), { context: 'gone' });

        const data = await exportCollection('col-a', vf(), { backend: 'qdrant' });

        // The file carries the count only; the hash list stays in the
        // console warning (asserted through the report's shape).
        expect(data.chunkMetaReport.unmatchedSettingsEntries).toEqual({ count: 1 });
    });

    it('leaves a chunk with no metadata without a chunkMeta key', async () => {
        seedCollection('col-a', [{ text: 'alpha' }]);

        const data = await exportCollection('col-a', vf(), { backend: 'qdrant' });

        expect(data.chunks[0]).not.toHaveProperty('chunkMeta');
        expect(data.chunkMetaReport.attached).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Import: written to the best store available
// ---------------------------------------------------------------------------

describe('import writes chunk metadata to the best store available', () => {
    it('on the payload path rides the insert and mints no settings key for payload fields', async () => {
        configureChunkMetaStore({
            transport: { isAvailable: () => true, listChunks: async () => ({ items: [], total: 0 }), patchMetadata: async () => {} },
        });
        const hash = host.hash('alpha text');
        const exportData = {
            version: '1.0.0',
            collection: { id: 'vf_eventbase_qdrant_tester_col', name: 'Col' },
            embedding: { source: 'transformers', model: 'model-x', backend: 'qdrant' },
            chunks: [{
                hash,
                text: 'alpha text',
                index: 0,
                vector: [0.1, 0.2],
                metadata: { keywords: [{ text: 'alpha' }] },
                chunkMeta: {
                    keywords: [{ text: 'alpha' }],
                    context: 'ctx alpha',
                    chunkLinks: [{ targetHash: '2', mode: 'soft' }],
                    summaries: [{ text: 'sum' }],
                },
            }],
        };

        const result = await importCollection(exportData, vf(), { overwrite: true });

        expect(result.success).toBe(true);
        expect(result.chunkMeta).toEqual({ payloadChunks: 1, settingsChunks: 1 });
        const insert = host.requests.find(request => request.url === '/api/plugins/similharity/chunks/insert');
        expect(insert.body.items[0].metadata).toEqual({
            keywords: [{ text: 'alpha' }],
            context: 'ctx alpha',
            chunkLinks: [{ targetHash: '2', mode: 'soft' }],
        });
        // Only the field no payload can carry reaches settings.
        const keys = Object.keys(vf()).filter(key => key.startsWith(LEGACY_CHUNK_META_PREFIX));
        expect(keys).toEqual([`${LEGACY_CHUNK_META_PREFIX}${hash}`]);
        expect(vf()[`${LEGACY_CHUNK_META_PREFIX}${hash}`].summaries).toEqual([{ text: 'sum' }]);
        expect(vf()[`${LEGACY_CHUNK_META_PREFIX}${hash}`].context).toBeUndefined();
    });

    it('without the plugin writes every field to settings and takes the native insert', async () => {
        host.pluginAvailable = false;
        host.settings.vectfox.vector_backend = 'standard';
        const hash = host.hash('alpha text');
        const exportData = {
            version: '1.0.0',
            collection: { id: 'vf_eventbase_standard_tester_col', name: 'Col' },
            embedding: { source: 'transformers', model: 'model-x', backend: 'standard' },
            chunks: [{
                hash,
                text: 'alpha text',
                index: 0,
                vector: [0.1, 0.2],
                metadata: {},
                chunkMeta: { context: 'ctx alpha', xmlTag: 'tag' },
            }],
        };

        const result = await importCollection(exportData, vf(), { overwrite: true });

        expect(result.chunkMeta).toEqual({ payloadChunks: 0, settingsChunks: 1 });
        expect(host.requests.some(request => request.url === '/api/plugins/similharity/chunks/insert')).toBe(false);
        const native = host.requests.find(request => request.url === '/api/vector/insert');
        expect(native.body.items[0]).toEqual({ hash, text: 'alpha text', index: 0 });
        expect(vf()[`${LEGACY_CHUNK_META_PREFIX}${hash}`]).toMatchObject({
            context: 'ctx alpha',
            xmlTag: 'tag',
        });
    });

    it('on the standard backend uses the plugin insert when the plugin is available', async () => {
        configureChunkMetaStore({
            transport: { isAvailable: () => true, listChunks: async () => ({ items: [], total: 0 }), patchMetadata: async () => {} },
        });
        host.settings.vectfox.vector_backend = 'standard';
        const hash = host.hash('alpha text');
        const exportData = {
            version: '1.0.0',
            collection: { id: 'vf_eventbase_standard_tester_col', name: 'Col' },
            embedding: { source: 'transformers', model: 'model-x', backend: 'standard' },
            chunks: [{
                hash,
                text: 'alpha text',
                index: 0,
                vector: [0.1, 0.2],
                metadata: {},
                chunkMeta: { context: 'ctx alpha' },
            }],
        };

        await importCollection(exportData, vf(), { overwrite: true });

        expect(host.requests.some(request => request.url === '/api/vector/insert')).toBe(false);
        const insert = host.requests.find(request => request.url === '/api/plugins/similharity/chunks/insert');
        expect(insert.body.backend).toBe('vectra');
        expect(insert.body.items[0].metadata).toEqual({ context: 'ctx alpha' });
        const keys = Object.keys(vf()).filter(key => key.startsWith(LEGACY_CHUNK_META_PREFIX));
        expect(keys).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Round trip: export -> wipe -> import -> export
// ---------------------------------------------------------------------------

describe('a round trip through a file preserves every per-chunk field', () => {
    it('reproduces the export exactly, payload fields and client-only fields alike', async () => {
        configureChunkMetaStore({
            transport: { isAvailable: () => true, listChunks: async () => ({ items: [], total: 0 }), patchMetadata: async () => {} },
        });
        const collectionId = 'vf_eventbase_qdrant_tester_col';
        const alpha = host.hash('alpha text');
        const beta = host.hash('beta text');
        const gone = host.hash('a chunk that is gone');
        seedCollection(collectionId, [
            {
                text: 'alpha text',
                metadata: {
                    keywords: [{ text: 'alpha', weight: 1.5 }],
                    context: 'Ctx alpha',
                    conditions: { enabled: true, logic: 'AND', rules: [] },
                    chunkLinks: [{ targetHash: '9', mode: 'soft' }],
                    parentHash: 'parent-1',
                },
                vector: [0.1, 0.2, 0.3],
            },
            {
                text: 'beta text',
                metadata: {},
                vector: [0.4, 0.5, 0.6],
            },
            {
                text: 'gamma text',
                metadata: { enabled: false, depth: 0 },
                vector: [0.7, 0.8, 0.9],
            },
        ]);
        // Client-only summaries live in settings; so does a field the payload lacks.
        settingsEntry(alpha, { summaries: [{ text: 'summary alpha' }] });
        settingsEntry(beta, { xmlTag: 'tag-beta', context: 'context from settings' });
        // An entry the collection does not contain.
        settingsEntry(gone, { context: 'orphaned-looking' });

        const first = await exportCollection(collectionId, vf(), { backend: 'qdrant' });
        expect(first.chunkMetaReport.unmatchedSettingsEntries.count).toBe(1);
        const firstMeta = chunkMetaOf(first);

        // Wipe both stores, then import the file into the empty install.
        host.settings.vectfox = { embedding_provider: 'transformers', vector_backend: 'qdrant' };
        host.collections.clear();

        const imported = await importCollection(first, vf(), { overwrite: true });
        expect(imported.success).toBe(true);

        // The payload holds what the file carried; settings holds only the
        // client-only field that no payload can carry.
        const settingsKeys = Object.keys(vf()).filter(key => key.startsWith(LEGACY_CHUNK_META_PREFIX));
        expect(settingsKeys).toEqual([`${LEGACY_CHUNK_META_PREFIX}${alpha}`]);

        const second = await exportCollection(collectionId, vf(), { backend: 'qdrant' });
        const secondMeta = chunkMetaOf(second);

        const normalized = (byHash) => Object.fromEntries(
            Object.entries(byHash).map(([hash, metadata]) => [hash, withoutBookkeeping(metadata)]),
        );
        expect(normalized(secondMeta)).toEqual(normalized(firstMeta));
        expect(second.chunkMetaReport.unmatchedSettingsEntries.count).toBe(0);
    });

    it('keeps the fields when the import has to re-embed', async () => {
        configureChunkMetaStore({
            transport: { isAvailable: () => true, listChunks: async () => ({ items: [], total: 0 }), patchMetadata: async () => {} },
        });
        const collectionId = 'vf_eventbase_qdrant_tester_col';
        const alpha = host.hash('alpha text');
        seedCollection(collectionId, [{
            text: 'alpha text',
            metadata: {
                keywords: [{ text: 'alpha' }],
                context: 'Ctx alpha',
                conditions: { enabled: true, logic: 'OR', rules: [] },
                parentHash: 'parent-alpha',
            },
            vector: [0.1, 0.2, 0.3],
        }]);
        settingsEntry(alpha, { summaries: [{ text: 'summary alpha' }] });

        const first = await exportCollection(collectionId, vf(), { backend: 'qdrant' });
        host.settings.vectfox = { embedding_provider: 'transformers', vector_backend: 'qdrant' };
        host.collections.clear();

        await importCollection(first, vf(), { overwrite: true, forceReembed: true });

        expect(insertVectorItems).toHaveBeenCalled();
        const second = await exportCollection(collectionId, vf(), { backend: 'qdrant' });

        expect(withoutBookkeeping(chunkMetaOf(second)[String(alpha)]))
            .toEqual(withoutBookkeeping(chunkMetaOf(first)[String(alpha)]));
    });
});
