/**
 * Chunk-metadata garbage collection — the facade the deletion paths call
 * (ticket 08).
 *
 * Seam: `deleteChunkMetadataForCollection` in core/collection-metadata.js, called
 * with a fake plugin transport and a plain settings object, exactly as the
 * collection-loader delete path, the EventBase cleanup path and the chunk
 * visualizer call it. The tests assert what the two stores observe:
 *
 *   - the deleted collection's settings entries go, in one save,
 *   - a hash another collection still holds keeps its entry,
 *   - nothing is deleted when a collection could not be read,
 *   - a refused backend deletion deletes nothing,
 *   - the payload mirror is dropped, and a pending payload write is cancelled,
 *   - no settings save is issued when there is nothing to delete.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockSettings = vi.hoisted(() => ({ vectfox: {} }));

vi.mock('../../../../extensions.js', () => ({
    extension_settings: mockSettings,
    getContext: () => ({}),
}));

vi.mock('../../../../../script.js', () => ({
    saveSettingsDebounced: vi.fn(),
}));

import {
    configureChunkMetaStore,
    deleteChunkMetadataForCollection,
    flushChunkMetaWrites,
    getChunkMetadata,
    resetChunkMetaStore,
    saveChunkMetadata,
    useChunkMetaCollection,
} from '../core/collection-metadata.js';
import { saveSettingsDebounced } from '../../../../../script.js';

const PREFIX = 'vectfox_chunk_meta_';

/** One registered collection, in the shape the loader's listing returns. */
function collection(id, backend = 'qdrant') {
    return { registryKey: `${backend}:${id}`, collectionId: id };
}

function bare(key) {
    const text = String(key);
    return text.includes(':') ? text.slice(text.indexOf(':') + 1) : text;
}

/**
 * The fake plugin/backends: a paginated chunk listing plus the payload writes the
 * store issues. `available` false keeps the listing working — a standard-backend
 * install has no plugin and still lists its hashes, which is exactly why the GC
 * must not gate on `isAvailable`.
 */
function createFakeBackend({
    chunksByCollection = {},
    failing = [],
    truncated = [],
    available = true,
} = {}) {
    const listCalls = [];
    const patchCalls = [];

    function chunksOf(key) {
        return chunksByCollection[key] ?? chunksByCollection[bare(key)] ?? {};
    }

    const listChunks = vi.fn(async (collectionKey, { offset = 0, limit = 100 } = {}) => {
        listCalls.push({ collectionKey, offset, limit });
        if (failing.includes(bare(collectionKey))) {
            throw new Error(`collection ${bare(collectionKey)} is unreachable`);
        }
        const entries = Object.entries(chunksOf(collectionKey));
        const items = entries.slice(offset, offset + limit).map(([hash, metadata]) => ({
            hash,
            metadata: { ...metadata },
        }));
        if (truncated.includes(bare(collectionKey))) {
            return { items, total: entries.length + 10, hasMore: true };
        }
        return { items };
    });

    const patchMetadata = vi.fn(async (collectionKey, hash, metadata) => {
        patchCalls.push({ collectionKey, hash, metadata: { ...metadata } });
        if (!available) throw new Error('plugin unavailable');
    });

    return {
        transport: { isAvailable: () => available, listChunks, patchMetadata },
        listCalls,
        listChunks,
        patchMetadata,
        patchCalls,
    };
}

let backend;
let collections;

function setup({
    settings = {},
    chunksByCollection = {},
    otherCollections = [],
    failing = [],
    truncated = [],
    available = true,
} = {}) {
    mockSettings.vectfox = settings;
    // Production keeps the deleted collection registered until the delete removes
    // it, so the fake registry does too. Tests that need an empty registry
    // reconfigure the provider explicitly.
    collections = [collection('col-a'), ...otherCollections];
    backend = createFakeBackend({ chunksByCollection, failing, truncated, available });
    configureChunkMetaStore({
        transport: backend.transport,
        listCollections: () => collections,
    });
    return backend;
}

function settingsWith(entries = {}) {
    const settings = { chunk_meta_store: 'auto' };
    for (const [hash, metadata] of Object.entries(entries)) {
        settings[`${PREFIX}${hash}`] = metadata;
    }
    return settings;
}

beforeEach(() => {
    mockSettings.vectfox = {};
    resetChunkMetaStore();
    saveSettingsDebounced.mockClear();
    configureChunkMetaStore({ transport: null, listCollections: null });
});

// ---------------------------------------------------------------------------
// A whole collection is deleted (or purged) — the loader's delete path.
// ---------------------------------------------------------------------------

describe('collection deletion — the settings copy goes', () => {
    it('removes that collection\'s settings entries, saves once, and leaves the rest', async () => {
        const settings = settingsWith({
            onlyA: { context: 'about dragons' },
            onlyA2: { context: 'about elves' },
            onlyB: { context: 'kept' },
        });
        const fake = setup({
            settings,
            chunksByCollection: { 'col-a': { onlyA: {}, onlyA2: {} }, 'col-b': { onlyB: {} } },
            otherCollections: [collection('col-b')],
        });
        const purge = vi.fn(async () => true);

        const result = await deleteChunkMetadataForCollection('qdrant:col-a', { purge });

        expect(purge).toHaveBeenCalledTimes(1);
        expect(settings[`${PREFIX}onlyA`]).toBeUndefined();
        expect(settings[`${PREFIX}onlyA2`]).toBeUndefined();
        expect(settings[`${PREFIX}onlyB`]).toEqual({ context: 'kept' });
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('complete');
        expect(result.purged).toBe(true);
        expect(result.counts.deleted).toBe(2);
        // The other collection was read to prove the hashes are not shared.
        expect(fake.listCalls.map(call => bare(call.collectionKey)))
            .toEqual(expect.arrayContaining(['col-a', 'col-b']));
    });

    it('reads the collection before it purges, and deletes only after', async () => {
        const settings = settingsWith({ onlyA: {} });
        const fake = setup({
            settings,
            chunksByCollection: { 'col-a': { onlyA: {} } },
        });
        const purge = vi.fn(async () => {
            // Nothing may have been deleted before the backend deletion.
            expect(settings[`${PREFIX}onlyA`]).toEqual({});
            return true;
        });

        const result = await deleteChunkMetadataForCollection('col-a', { purge });

        expect(result.status).toBe('complete');
        expect(settings[`${PREFIX}onlyA`]).toBeUndefined();
        // The listing that proves what the collection held came before the purge.
        expect(fake.listCalls.length).toBeGreaterThan(0);
        expect(fake.listChunks.mock.invocationCallOrder[0])
            .toBeLessThan(purge.mock.invocationCallOrder[0]);
    });

    it('keeps a shared hash when the same text lives in two collections', async () => {
        const settings = settingsWith({ shared: { context: 'about dragons' } });
        setup({
            settings,
            chunksByCollection: { 'col-a': { shared: {} }, 'col-b': { shared: {} } },
            otherCollections: [collection('col-b')],
        });

        const result = await deleteChunkMetadataForCollection('col-a', {
            purge: async () => true,
        });

        expect(settings[`${PREFIX}shared`]).toEqual({ context: 'about dragons' });
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(result.status).toBe('empty');
        expect(result.counts.shared).toBe(1);
    });

    it('drops the payload mirror, and cancels a pending payload write', async () => {
        const settings = settingsWith({ onlyA: { context: 'stored' } });
        const fake = setup({
            settings,
            chunksByCollection: { 'col-a': { onlyA: { context: 'from payload' } } },
        });
        await useChunkMetaCollection('col-a');
        saveChunkMetadata('onlyA', { context: 'edited just before the delete' });

        await deleteChunkMetadataForCollection('col-a', { purge: async () => true });
        await flushChunkMetaWrites();

        // The queued patch belonged to a collection that no longer exists.
        expect(fake.patchCalls).toEqual([]);
        expect(getChunkMetadata('onlyA')).toBeNull();
    });

    it('does not refill the mirror from a hydration that lands after the deletion', async () => {
        // The visualizer hydrates fire-and-forget, so a delete can overtake a
        // listing of the collection it is deleting. That listing must not put the
        // deleted collection's payload back into the mirror.
        const settings = settingsWith({ onlyA: { context: 'stored' } });
        const fake = setup({
            settings,
            chunksByCollection: { 'col-a': { onlyA: { context: 'from payload' } } },
        });
        let releaseHydration;
        const hydrationGate = new Promise(resolve => { releaseHydration = resolve; });
        const realListChunks = fake.transport.listChunks;
        let suspended = false;
        fake.transport.listChunks = vi.fn(async (collectionKey, options) => {
            const page = await realListChunks(collectionKey, options);
            if (!suspended) {
                suspended = true;
                await hydrationGate;
            }
            return page;
        });

        const hydrating = useChunkMetaCollection('col-a');
        const result = await deleteChunkMetadataForCollection('col-a', {
            purge: async () => true,
        });
        releaseHydration();

        expect(result.status).toBe('complete');
        expect(await hydrating).toBe(false);
        expect(getChunkMetadata('onlyA')).toBeNull();
    });
});

describe('collection deletion — when it must not delete', () => {
    it('deletes nothing when the deleted collection could not be listed', async () => {
        const settings = settingsWith({ onlyA: {} });
        setup({
            settings,
            chunksByCollection: { 'col-a': { onlyA: {} } },
            failing: ['col-a'],
        });
        const purge = vi.fn(async () => true);

        const result = await deleteChunkMetadataForCollection('col-a', { purge });

        expect(settings[`${PREFIX}onlyA`]).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(result.status).toBe('refused');
        expect(result.reason).toBe('collection-unlisted');
        // The deletion itself still happened; only the metadata cleanup declined.
        expect(purge).toHaveBeenCalledTimes(1);
    });

    it('deletes nothing when the listing of the deleted collection was truncated', async () => {
        const settings = settingsWith({ onlyA: {}, onlyA2: {} });
        setup({
            settings,
            chunksByCollection: { 'col-a': { onlyA: {}, onlyA2: {} } },
            truncated: ['col-a'],
        });

        const result = await deleteChunkMetadataForCollection('col-a', {
            purge: async () => true,
        });

        expect(result.status).toBe('refused');
        expect(settings[`${PREFIX}onlyA`]).toEqual({});
        expect(settings[`${PREFIX}onlyA2`]).toEqual({});
    });

    it('deletes nothing when another collection could not be read', async () => {
        const settings = settingsWith({ onlyA: {} });
        const purge = vi.fn(async () => true);
        setup({
            settings,
            chunksByCollection: { 'col-a': { onlyA: {} }, 'col-b': {} },
            otherCollections: [collection('col-b')],
            failing: ['col-b'],
        });

        const result = await deleteChunkMetadataForCollection('col-a', { purge });

        expect(result.status).toBe('refused');
        expect(result.reason).toBe('collections-unverified');
        expect(settings[`${PREFIX}onlyA`]).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        // The unreadable collection blocked the cleanup, not the deletion.
        expect(purge).toHaveBeenCalledTimes(1);
    });

    it('deletes nothing when the backend refused the purge, and keeps the mirror', async () => {
        const settings = settingsWith({ onlyA: { context: 'stored' } });
        setup({
            settings,
            chunksByCollection: { 'col-a': { onlyA: { context: 'from payload' } } },
        });
        await useChunkMetaCollection('col-a');

        const result = await deleteChunkMetadataForCollection('col-a', {
            purge: async () => false,
        });

        expect(result.status).toBe('refused');
        expect(result.reason).toBe('purge-failed');
        expect(result.purged).toBe(false);
        expect(settings[`${PREFIX}onlyA`]).toEqual({ context: 'stored' });
        expect(getChunkMetadata('onlyA').context).toBe('from payload');
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });

    it('deletes nothing when no collections are registered at all', async () => {
        // An empty registry is the "discovery has not run" state, not proof that
        // no other collection holds the deleted text.
        const settings = settingsWith({ onlyA: {} });
        setup({ settings, chunksByCollection: { 'col-a': { onlyA: {} } } });
        configureChunkMetaStore({ listCollections: () => [] });
        const purge = vi.fn(async () => true);

        const result = await deleteChunkMetadataForCollection('col-a', { purge });

        expect(result.status).toBe('refused');
        expect(result.reason).toBe('registry-empty');
        expect(settings[`${PREFIX}onlyA`]).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        // The deletion itself still happened.
        expect(purge).toHaveBeenCalledTimes(1);
    });

    it('deletes nothing when the registry cannot be read at all', async () => {
        const settings = settingsWith({ onlyA: {} });
        setup({ settings, chunksByCollection: { 'col-a': { onlyA: {} } } });
        configureChunkMetaStore({ listCollections: null });
        const purge = vi.fn(async () => true);

        const result = await deleteChunkMetadataForCollection('col-a', { purge });

        expect(result.status).toBe('refused');
        expect(result.reason).toBe('registry-unavailable');
        expect(settings[`${PREFIX}onlyA`]).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(purge).toHaveBeenCalledTimes(1);
    });

    it('does not collapse a same-id collection on another backend', async () => {
        const settings = settingsWith({
            shared: { context: 'live' },
            onlyQdrant: { context: 'gone' },
        });
        setup({
            settings,
            chunksByCollection: {
                'qdrant:col-a': { shared: {}, onlyQdrant: {} },
                'vectra:col-a': { shared: {} },
            },
            otherCollections: [collection('col-a', 'vectra')],
        });

        const result = await deleteChunkMetadataForCollection('qdrant:col-a', {
            purge: async () => true,
        });

        // `vectra:col-a` still holds the same text: its settings copy stays.
        expect(settings[`${PREFIX}shared`]).toEqual({ context: 'live' });
        expect(settings[`${PREFIX}onlyQdrant`]).toBeUndefined();
        expect(result.counts.shared).toBe(1);
        expect(result.counts.deleted).toBe(1);
    });

    it('treats a throwing purge as a refusal', async () => {
        const settings = settingsWith({ onlyA: {} });
        setup({ settings, chunksByCollection: { 'col-a': { onlyA: {} } } });

        const result = await deleteChunkMetadataForCollection('col-a', {
            purge: async () => { throw new Error('connection reset'); },
        });

        expect(result.status).toBe('refused');
        expect(result.purged).toBe(false);
        expect(settings[`${PREFIX}onlyA`]).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });
});

describe('collection deletion — when there is nothing to delete', () => {
    it('issues no listing, no settings save and still purges', async () => {
        const settings = settingsWith({});
        mockSettings.vectfox = settings;
        const fake = setup({ settings, chunksByCollection: { 'col-a': { a: {} } } });
        const purge = vi.fn(async () => true);

        const result = await deleteChunkMetadataForCollection('col-a', { purge });

        expect(fake.listCalls).toEqual([]);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(purge).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('empty');
        expect(result.purged).toBe(true);
    });

    it('issues no settings save when no entry belongs to the deleted collection', async () => {
        const settings = settingsWith({ onlyB: { context: 'kept' } });
        setup({
            settings,
            chunksByCollection: { 'col-a': { a: {} }, 'col-b': { onlyB: {} } },
            otherCollections: [collection('col-b')],
        });

        const result = await deleteChunkMetadataForCollection('col-a', {
            purge: async () => true,
        });

        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(settings[`${PREFIX}onlyB`]).toEqual({ context: 'kept' });
        expect(result.status).toBe('empty');
    });

    it('reports a failed save beside the deletion instead of throwing', async () => {
        const settings = settingsWith({ onlyA: {} });
        setup({ settings, chunksByCollection: { 'col-a': { onlyA: {} } } });
        saveSettingsDebounced.mockImplementationOnce(() => { throw new Error('disk full'); });

        const result = await deleteChunkMetadataForCollection('col-a', {
            purge: async () => true,
        });

        expect(result.status).toBe('complete');
        expect(result.counts.deleted).toBe(1);
        expect(result.saveError).toContain('disk full');
    });

    it('does nothing on a second run of its own deletion', async () => {
        const settings = settingsWith({ onlyA: {} });
        setup({ settings, chunksByCollection: { 'col-a': { onlyA: {} } } });
        await deleteChunkMetadataForCollection('col-a', { purge: async () => true });
        saveSettingsDebounced.mockClear();
        const purge = vi.fn(async () => true);

        const result = await deleteChunkMetadataForCollection('col-a', { purge });

        expect(result.status).toBe('empty');
        expect(purge).toHaveBeenCalledTimes(1);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// One chunk (or a few) is deleted in the chunk visualizer.
// ---------------------------------------------------------------------------

describe('chunk deletion in the visualizer', () => {
    it('removes the chunk metadata from both stores', async () => {
        const settings = settingsWith({ h1: { context: 'old copy' }, h2: { context: 'still here' } });
        setup({
            settings,
            chunksByCollection: { 'col-a': { h1: { context: 'payload copy' }, h2: { context: 'payload too' } } },
        });
        await useChunkMetaCollection('col-a');

        const result = await deleteChunkMetadataForCollection('col-a', { hashes: ['h1'] });

        expect(settings[`${PREFIX}h1`]).toBeUndefined();
        expect(settings[`${PREFIX}h2`]).toEqual({ context: 'still here' });
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('complete');
        expect(result.counts.deleted).toBe(1);
        // The payload mirror entry is gone, so the value cannot resurface.
        expect(getChunkMetadata('h1')).toBeNull();
        expect(getChunkMetadata('h2').context).toBe('payload too');
    });

    it('keeps a chunk\'s settings entry while another collection holds that text', async () => {
        const settings = settingsWith({ shared: { context: 'about dragons' } });
        setup({
            settings,
            chunksByCollection: { 'col-a': { shared: {} }, 'col-b': { shared: {} } },
            otherCollections: [collection('col-b')],
        });
        await useChunkMetaCollection('col-a');

        const result = await deleteChunkMetadataForCollection('col-a', { hashes: ['shared'] });

        expect(settings[`${PREFIX}shared`]).toEqual({ context: 'about dragons' });
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(result.status).toBe('empty');
        expect(result.counts.shared).toBe(1);
        // Collection B's copy of the same text is untouched and still readable.
        await useChunkMetaCollection('col-b');
        expect(getChunkMetadata('shared')).toEqual({ context: 'about dragons' });
    });

    it('does no scanning and no save when the deleted chunk had no settings entry', async () => {
        const settings = settingsWith({ other: { context: 'elsewhere' } });
        const fake = setup({
            settings,
            chunksByCollection: { 'col-a': { h1: { context: 'payload only' } } },
            otherCollections: [collection('col-b')],
        });
        await useChunkMetaCollection('col-a');
        // The hydration read above is not part of the deletion.
        fake.listCalls.length = 0;

        const result = await deleteChunkMetadataForCollection('col-a', { hashes: ['h1'] });

        expect(fake.listCalls).toEqual([]);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(result.status).toBe('empty');
        // The mirror entry still goes: the chunk is not in this collection any more.
        expect(getChunkMetadata('h1')).toBeNull();
    });

    it('works on a plugin-less install using the native hash listing', async () => {
        const settings = settingsWith({ h1: { keywords: ['dragon'] } });
        setup({
            settings,
            chunksByCollection: { 'col-a': { h1: {} } },
            available: false,
        });

        const result = await deleteChunkMetadataForCollection('col-a', {
            purge: async () => true,
        });

        expect(result.status).toBe('complete');
        expect(settings[`${PREFIX}h1`]).toBeUndefined();
    });

    it('accepts any iterable of hashes', async () => {
        const settings = settingsWith({ h1: { context: 'a' }, h2: { context: 'b' } });
        setup({
            settings,
            chunksByCollection: { 'col-a': { h1: {}, h2: {} } },
        });

        const result = await deleteChunkMetadataForCollection('col-a', {
            hashes: new Set(['h1', 'h2']),
        });

        expect(settings[`${PREFIX}h1`]).toBeUndefined();
        expect(settings[`${PREFIX}h2`]).toBeUndefined();
        expect(result.counts.deleted).toBe(2);
    });

    it('collects an entry written while the membership scan runs', async () => {
        const settings = settingsWith({ onlyA: {} });
        const fake = setup({
            settings,
            chunksByCollection: { 'col-a': { onlyA: {}, late: {} }, 'col-b': {} },
            otherCollections: [collection('col-b')],
        });
        const realListChunks = fake.transport.listChunks;
        let injected = false;
        fake.transport.listChunks = vi.fn(async (collectionKey, options) => {
            const page = await realListChunks(collectionKey, options);
            if (!injected && bare(collectionKey) === 'col-b') {
                injected = true;
                // A debounced save lands in settings while the scan is running.
                settings[`${PREFIX}late`] = { context: 'edited mid-scan' };
            }
            return page;
        });

        const result = await deleteChunkMetadataForCollection('col-a', {
            purge: async () => true,
        });

        // Both entries belong to the deleted collection, so neither may be left
        // behind as a fresh orphan.
        expect(settings[`${PREFIX}onlyA`]).toBeUndefined();
        expect(settings[`${PREFIX}late`]).toBeUndefined();
        expect(result.counts.deleted).toBe(2);
    });

    it('keeps the entry when another collection could not be read', async () => {
        const settings = settingsWith({ h1: {} });
        setup({
            settings,
            chunksByCollection: { 'col-a': { h1: {} }, 'col-b': {} },
            otherCollections: [collection('col-b')],
            failing: ['col-b'],
        });

        const result = await deleteChunkMetadataForCollection('col-a', { hashes: ['h1'] });

        expect(result.status).toBe('refused');
        expect(settings[`${PREFIX}h1`]).toEqual({});
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });
});
