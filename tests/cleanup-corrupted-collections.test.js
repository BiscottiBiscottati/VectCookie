/**
 * Corrupted / ST-native collection cleanup — the on-disk purge that runs outside
 * the normal delete path (ticket 08).
 *
 * Seam: `cleanupCorruptedCollections()` with a fake plugin HTTP surface and a
 * fake chunk-metadata transport. The cleanup deletes collections VectFox never
 * registered, so it must run the same collection-scoped chunk-metadata GC after
 * the on-disk purge — and a refused cleanup must still purge and must say the
 * metadata was kept.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockSettings = vi.hoisted(() => ({ vectfox: {} }));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: mockSettings,
    getContext: () => ({}),
}));

vi.mock('../../../../../script.js', () => ({
    characters: {},
    getRequestHeaders: () => ({}),
    saveSettingsDebounced: vi.fn(),
    getCurrentChatId: () => null,
}));

vi.mock('../core/core-vector-api.js', () => ({
    getSavedHashes: vi.fn(),
    queryCollection: vi.fn(),
    purgeVectorIndex: vi.fn(),
}));

import { cleanupCorruptedCollections, deleteCollection } from '../core/collection-loader.js';
import { configureChunkMetaStore, resetChunkMetaStore } from '../core/collection-metadata.js';
import { purgeVectorIndex } from '../core/core-vector-api.js';
import { saveSettingsDebounced } from '../../../../../script.js';

const PREFIX = 'vectfox_chunk_meta_';
const CORRUPT_ID = 'qdrantCORRUPTED';
const CORRUPT_KEY = `qdrant:${CORRUPT_ID}`;

function collection(id, backend = 'qdrant') {
    return { registryKey: `${backend}:${id}`, collectionId: id };
}

function fakeTransport(hashesByCollection = {}) {
    const listCalls = [];
    return {
        listCalls,
        transport: {
            isAvailable: () => true,
            listChunks: vi.fn(async (collectionKey) => {
                listCalls.push(collectionKey);
                const items = (hashesByCollection[collectionKey] || []).map(hash => ({
                    hash,
                    metadata: { hash },
                }));
                return { items };
            }),
            patchMetadata: vi.fn(),
        },
    };
}

function fakePluginHttp({ collections }) {
    const calls = [];
    const fetchMock = vi.fn(async (url, options = {}) => {
        calls.push({ url, method: options.method || 'GET', body: options.body });
        if (String(url).endsWith('/collections')) {
            return { ok: true, status: 200, json: async () => ({ success: true, collections }) };
        }
        return { ok: true, status: 200, text: async () => '' };
    });
    vi.stubGlobal('fetch', fetchMock);
    return { fetchMock, calls };
}

beforeEach(() => {
    mockSettings.vectfox = {};
    resetChunkMetaStore();
    saveSettingsDebounced.mockClear();
    purgeVectorIndex.mockReset().mockResolvedValue(true);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('corrupted-collection cleanup — chunk metadata goes with the collection', () => {
    it('removes the purged collection\'s settings entries after the on-disk purge', async () => {
        mockSettings.vectfox = {
            chunk_meta_store: 'auto',
            [`${PREFIX}h1`]: { context: 'belongs to the corrupt collection' },
            [`${PREFIX}kept`]: { context: 'another collection holds this' },
        };
        const http = fakePluginHttp({
            collections: [{ id: CORRUPT_ID, backend: 'qdrant', source: 'transformers' }],
        });
        const fake = fakeTransport({
            [CORRUPT_KEY]: ['h1'],
            'qdrant:vf_other': ['kept'],
        });
        configureChunkMetaStore({
            transport: fake.transport,
            listCollections: () => [collection('vf_other')],
        });

        const result = await cleanupCorruptedCollections();

        expect(result.total).toBe(1);
        expect(result.purged).toEqual([{ key: `qdrant:transformers:${CORRUPT_ID}`, ok: true }]);
        expect(http.calls.map(call => call.url)).toEqual(expect.arrayContaining([
            '/api/plugins/similharity/collections',
            '/api/plugins/similharity/chunks/purge',
        ]));
        // The GC listed the routing form, not the three-part display key.
        expect(fake.listCalls).toContain(CORRUPT_KEY);
        expect(mockSettings.vectfox[`${PREFIX}h1`]).toBeUndefined();
        expect(mockSettings.vectfox[`${PREFIX}kept`]).toEqual({ context: 'another collection holds this' });
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('still purges and reports the kept metadata when the cleanup must refuse', async () => {
        mockSettings.vectfox = {
            chunk_meta_store: 'auto',
            [`${PREFIX}h1`]: { context: 'kept because nothing is registered' },
        };
        const http = fakePluginHttp({
            collections: [{ id: CORRUPT_ID, backend: 'qdrant', source: 'transformers' }],
        });
        const fake = fakeTransport({ [CORRUPT_KEY]: ['h1'] });
        configureChunkMetaStore({
            transport: fake.transport,
            // Discovery has not run: absence elsewhere is not proof.
            listCollections: () => [],
        });

        const result = await cleanupCorruptedCollections();

        // The on-disk deletion is what the action promised; it still happened.
        expect(http.calls.some(call => call.url.endsWith('/chunks/purge'))).toBe(true);
        expect(result.purged).toEqual([{
            key: `qdrant:transformers:${CORRUPT_ID}`,
            ok: true,
            metadataKept: 'registry-empty',
        }]);
        expect(mockSettings.vectfox[`${PREFIX}h1`]).toEqual({ context: 'kept because nothing is registered' });
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('reports a failed on-disk purge and keeps the collection registered', async () => {
        mockSettings.vectfox = {
            chunk_meta_store: 'auto',
            vectfox_collection_registry: [`qdrant:transformers:${CORRUPT_ID}`],
            [`${PREFIX}h1`]: { context: 'nothing was purged' },
        };
        vi.stubGlobal('fetch', vi.fn(async (url) => {
            if (String(url).endsWith('/collections')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({
                        success: true,
                        collections: [{ id: CORRUPT_ID, backend: 'qdrant', source: 'transformers' }],
                    }),
                };
            }
            return { ok: false, status: 500, text: async () => 'disk on fire' };
        }));
        configureChunkMetaStore({
            transport: fakeTransport({ [CORRUPT_KEY]: ['h1'] }).transport,
            listCollections: () => [collection('vf_other')],
        });

        const result = await cleanupCorruptedCollections();

        expect(result.purged[0].ok).toBe(false);
        expect(result.purged[0].error).toContain('disk on fire');
        // Nothing was deleted, so nothing may be forgotten or saved.
        expect(mockSettings.vectfox[`${PREFIX}h1`]).toEqual({ context: 'nothing was purged' });
        expect(mockSettings.vectfox.vectfox_collection_registry)
            .toContain(`qdrant:transformers:${CORRUPT_ID}`);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });
});

describe('collection deletion — a kept metadata copy makes the result partial', () => {
    it('reports the refusal instead of a clean delete', async () => {
        mockSettings.vectfox = {
            chunk_meta_store: 'auto',
            vectfox_collection_registry: ['qdrant:vf_x'],
            [`${PREFIX}h1`]: { context: 'kept' },
        };
        configureChunkMetaStore({
            transport: fakeTransport({ 'qdrant:vf_x': ['h1'] }).transport,
            // Discovery has not run: the cleanup cannot prove the hash is unshared.
            listCollections: () => [],
        });

        const result = await deleteCollection('vf_x', { vector_backend: 'qdrant' }, 'qdrant:vf_x');

        expect(purgeVectorIndex).toHaveBeenCalledTimes(1);
        expect(result.success).toBe(false);
        expect(result.errors.join(' ')).toContain('Chunk metadata: cleanup refused (registry-empty)');
        expect(mockSettings.vectfox[`${PREFIX}h1`]).toEqual({ context: 'kept' });
    });

    it('is a clean delete when the metadata went with the collection', async () => {
        mockSettings.vectfox = {
            chunk_meta_store: 'auto',
            vectfox_collection_registry: ['qdrant:vf_x'],
            [`${PREFIX}h1`]: { context: 'goes' },
        };
        configureChunkMetaStore({
            transport: fakeTransport({ 'qdrant:vf_x': ['h1'] }).transport,
            listCollections: () => [collection('vf_other')],
        });

        const result = await deleteCollection('vf_x', { vector_backend: 'qdrant' }, 'qdrant:vf_x');

        expect(result.success).toBe(true);
        expect(result.errors).toEqual([]);
        expect(mockSettings.vectfox[`${PREFIX}h1`]).toBeUndefined();
        expect(saveSettingsDebounced).toHaveBeenCalled();
    });
});
