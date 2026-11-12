/**
 * Tests: chunk metadata in the payload store (ADR-0003, feature chunk-meta-store).
 *
 * Behaviour at the seam: the four public functions in core/collection-metadata.js
 * are called exactly as every existing call site calls them, with a fake plugin
 * transport and a fake settings object standing in for the two stores. Tests never
 * reach into the mirror — they observe what was read, what was written where, and
 * which requests were issued.
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
    getChunkMetadata,
    saveChunkMetadata,
    deleteChunkMetadata,
    getAllChunkMetadata,
    useChunkMetaCollection,
    flushChunkMetaWrites,
    configureChunkMetaStore,
    resetChunkMetaStore,
    isChunkMetaPayloadStore,
} from '../core/collection-metadata.js';
import { createChunkMetaStore } from '../core/chunk-meta-store.js';
import { saveSettingsDebounced } from '../../../../../script.js';

// ---------------------------------------------------------------------------
// Fake plugin: a transport plus the server-side chunk payloads it reads/writes.
// Patching mutates the fake server so a simulated reload hydrates the edit.
// ---------------------------------------------------------------------------

function createFakePlugin({ available = true, chunksByCollection = {} } = {}) {
    const server = new Map();
    for (const [collectionId, chunks] of Object.entries(chunksByCollection)) {
        const byHash = new Map();
        for (const chunk of chunks) byHash.set(String(chunk.hash), { ...(chunk.metadata || {}) });
        server.set(collectionId, byHash);
    }

    const calls = { list: [], patch: [] };
    let isAvailable = available;

    const transport = {
        isAvailable: () => isAvailable,
        async listChunks(collectionId, { offset = 0, limit = 100 } = {}) {
            calls.list.push({ collectionId, offset, limit });
            if (!isAvailable) throw new Error('plugin unavailable');
            const entries = [...(server.get(collectionId) || new Map()).entries()];
            const items = entries.slice(offset, offset + limit).map(([hash, metadata]) => ({
                hash,
                // Payloads also carry text/hash; the store must keep only metadata.
                metadata: { ...metadata, hash, text: `text-${hash}` },
            }));
            return { items };
        },
        async patchMetadata(collectionId, hash, metadata) {
            calls.patch.push({ collectionId, hash, metadata: { ...metadata } });
            if (!isAvailable) throw new Error('plugin unavailable');
            const byHash = server.get(collectionId) || new Map();
            byHash.set(String(hash), { ...(byHash.get(String(hash)) || {}), ...metadata });
            server.set(collectionId, byHash);
        },
    };

    return {
        transport,
        calls,
        server,
        setAvailable: (value) => { isAvailable = value; },
    };
}

beforeEach(() => {
    mockSettings.vectfox = {};
    resetChunkMetaStore();
});

// ---------------------------------------------------------------------------
// Ticket 01, first acceptance bullet: with the plugin present, editing a
// chunk's context writes it to the payload. (Ticket 07 removed the settings
// copy this save used to leave behind.)
// ---------------------------------------------------------------------------

describe('plugin present — write goes to the chunk payload', () => {
    it('stores an edited context in the collection\'s payload on save', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '1', metadata: { context: 'before' } }] },
        });
        configureChunkMetaStore({ transport: plugin.transport });

        await useChunkMetaCollection('col-a');
        saveChunkMetadata('1', { context: 'after' });
        await flushChunkMetaWrites();

        expect(plugin.calls.patch).toEqual([
            {
                collectionId: 'col-a',
                hash: '1',
                metadata: { context: 'after', updatedAt: expect.any(Number) },
            },
        ]);
        expect(getChunkMetadata('1').context).toBe('after');
    });
});

// ---------------------------------------------------------------------------
// Acceptance: the edit survives a reload even when the legacy settings entry is
// removed by hand, because the payload — not settings — is the source of truth.
// ---------------------------------------------------------------------------

describe('plugin present — reload renders from the payload', () => {
    it('reads the edit from the payload after the settings copy is deleted', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '42', metadata: { context: 'before' } }] },
        });
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');
        saveChunkMetadata('42', { context: 'edited' });
        await flushChunkMetaWrites();

        // Simulate a hand-deleted legacy entry plus a page reload: the mirror is
        // gone, and settings no longer holds the chunk.
        delete mockSettings.vectfox.vectfox_chunk_meta_42;
        resetChunkMetaStore();
        configureChunkMetaStore({ transport: plugin.transport });

        await useChunkMetaCollection('col-a');

        expect(mockSettings.vectfox.vectfox_chunk_meta_42).toBeUndefined();
        expect(getChunkMetadata('42').context).toBe('edited');
    });
});

// ---------------------------------------------------------------------------
// Acceptance: field-level merge. Payload wins where both stores hold a value;
// settings fills only the fields the payload lacks.
// ---------------------------------------------------------------------------

describe('merged read — payload first, settings fills gaps per field', () => {
    it('takes each field from the payload when present and settings otherwise', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: {
                'col-a': [{
                    hash: '7',
                    metadata: { context: 'payload-context', name: 'payload-name' },
                }],
            },
        });
        mockSettings.vectfox.vectfox_chunk_meta_7 = {
            context: 'settings-context',
            xmlTag: 'settings-tag',
            keywords: [{ text: 'from-settings', weight: 1 }],
        };
        configureChunkMetaStore({ transport: plugin.transport });

        await useChunkMetaCollection('col-a');

        const merged = getChunkMetadata('7');
        expect(merged.context).toBe('payload-context');
        expect(merged.name).toBe('payload-name');
        expect(merged.xmlTag).toBe('settings-tag');
        expect(merged.keywords).toEqual([{ text: 'from-settings', weight: 1 }]);
    });
});

// ---------------------------------------------------------------------------
// Acceptance: without the plugin an edit writes only to settings and behaves
// exactly as before — no plugin request is issued.
// ---------------------------------------------------------------------------

describe('no plugin — settings only, previous behaviour', () => {
    it('writes the settings entry and issues no plugin request', async () => {
        const plugin = createFakePlugin({ available: false });
        configureChunkMetaStore({ transport: plugin.transport });

        saveChunkMetadata('9', { context: 'settings-only' });
        await flushChunkMetaWrites();

        expect(plugin.calls.patch).toEqual([]);
        expect(plugin.calls.list).toEqual([]);
        expect(mockSettings.vectfox.vectfox_chunk_meta_9).toMatchObject({ context: 'settings-only' });
        expect(getChunkMetadata('9').context).toBe('settings-only');
    });

    it('keeps the settings write when no transport is configured at all', () => {
        configureChunkMetaStore({ transport: null });

        saveChunkMetadata('11', { keywords: [{ text: 'legacy', weight: 1 }] });

        expect(mockSettings.vectfox.vectfox_chunk_meta_11).toMatchObject({
            keywords: [{ text: 'legacy', weight: 1 }],
        });
        expect(getChunkMetadata('11').keywords).toEqual([{ text: 'legacy', weight: 1 }]);
    });
});

// ---------------------------------------------------------------------------
// Acceptance: a collection hydrates on first use, not at startup.
// ---------------------------------------------------------------------------

describe('lazy hydration', () => {
    it('fetches a collection once on first use and never on configuration or reads', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '1', metadata: { context: 'payload' } }] },
        });
        configureChunkMetaStore({ transport: plugin.transport });

        expect(plugin.calls.list).toEqual([]);
        expect(getChunkMetadata('1')).toBeNull();
        expect(plugin.calls.list).toEqual([]);

        await useChunkMetaCollection('col-a');
        expect(plugin.calls.list).toHaveLength(1);

        await useChunkMetaCollection('col-a');
        expect(plugin.calls.list).toHaveLength(1);
    });

    it('keeps the settings fallback when hydration fails and never marks it hydrated', async () => {
        const plugin = createFakePlugin({ chunksByCollection: { 'col-a': [] } });
        let failList = true;
        const flakyTransport = {
            ...plugin.transport,
            async listChunks(...args) {
                if (failList) throw new Error('backend down');
                return plugin.transport.listChunks(...args);
            },
        };
        mockSettings.vectfox.vectfox_chunk_meta_1 = { context: 'settings-copy' };
        configureChunkMetaStore({ transport: flakyTransport });

        const first = await useChunkMetaCollection('col-a');
        expect(first).toBe(false);
        expect(getChunkMetadata('1').context).toBe('settings-copy');

        failList = false;
        const second = await useChunkMetaCollection('col-a');
        expect(second).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Acceptance: the public functions stay synchronous. Callers get values back,
// never promises, so the existing call sites stay untouched.
// ---------------------------------------------------------------------------

describe('synchronous public functions', () => {
    it('returns values synchronously from save, get and delete', async () => {
        const plugin = createFakePlugin({ chunksByCollection: { 'col-a': [] } });
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');

        const saved = saveChunkMetadata('5', { context: 'sync' });
        const fetched = getChunkMetadata('5');
        const removed = deleteChunkMetadata('5');

        expect(saved).toBeUndefined();
        expect(fetched).not.toBeInstanceOf(Promise);
        expect(fetched.context).toBe('sync');
        expect(removed).toBeUndefined();
        expect(getChunkMetadata('5')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Per-collection mirror: the same text hash in two collections no longer
// shares one metadata entry (ADR-0003 decision 4), and getAll sees the mirror.
// ---------------------------------------------------------------------------

describe('per-collection mirror', () => {
    it('reads each collection\'s own payload value for the same hash', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: {
                'col-a': [{ hash: 'same', metadata: { context: 'context-a' } }],
                'col-b': [{ hash: 'same', metadata: { context: 'context-b' } }],
            },
        });
        configureChunkMetaStore({ transport: plugin.transport });

        await useChunkMetaCollection('col-a');
        expect(getChunkMetadata('same').context).toBe('context-a');

        await useChunkMetaCollection('col-b');
        expect(getChunkMetadata('same').context).toBe('context-b');

        await useChunkMetaCollection('col-a');
        expect(getChunkMetadata('same').context).toBe('context-a');
    });

    it('includes hydrated payload entries in getAllChunkMetadata', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: {
                'col-a': [
                    { hash: '1', metadata: { context: 'payload-one' } },
                    { hash: '2', metadata: { context: 'payload-two' } },
                ],
            },
        });
        mockSettings.vectfox.vectfox_chunk_meta_1 = { xmlTag: 'legacy-tag' };
        configureChunkMetaStore({ transport: plugin.transport });

        await useChunkMetaCollection('col-a');

        const all = getAllChunkMetadata();
        expect(all['1']).toMatchObject({ context: 'payload-one', xmlTag: 'legacy-tag' });
        expect(all['2']).toMatchObject({ context: 'payload-two' });
    });

    it('keeps client-only summaries out of the payload', async () => {
        const plugin = createFakePlugin({ chunksByCollection: { 'col-a': [] } });
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');

        saveChunkMetadata('3', { summaries: ['a dual-vector summary'] });
        await flushChunkMetaWrites();

        expect(plugin.calls.patch).toEqual([]);
        expect(mockSettings.vectfox.vectfox_chunk_meta_3.summaries).toEqual(['a dual-vector summary']);
        expect(getChunkMetadata('3').summaries).toEqual(['a dual-vector summary']);
    });

    it('does not re-send unchanged payload fields for a client-only save', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '3', metadata: { context: 'payload-context' } }] },
        });
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');

        // Mirrors the visualizer's client-only save: the load-time read merged
        // into `existing`, then only summaries change.
        const existing = getChunkMetadata('3');
        saveChunkMetadata('3', { ...existing, summaries: ['a dual-vector summary'] });
        await flushChunkMetaWrites();

        expect(plugin.calls.patch).toEqual([]);
        expect(mockSettings.vectfox.vectfox_chunk_meta_3.summaries).toEqual(['a dual-vector summary']);
    });

    it('clearing the active collection scopes reads and writes back to settings', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '1', metadata: { context: 'payload' } }] },
        });
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');
        expect(getChunkMetadata('1').context).toBe('payload');

        await useChunkMetaCollection(null);
        // No collection in use: the hash-only API must not borrow another
        // hydrated collection's payload entry, so there is nothing to read.
        expect(getChunkMetadata('1')).toBeNull();

        saveChunkMetadata('999', { context: 'no-collection' });
        await flushChunkMetaWrites();

        expect(plugin.calls.patch).toEqual([]);
        expect(mockSettings.vectfox.vectfox_chunk_meta_999).toMatchObject({ context: 'no-collection' });
    });

    it('deleting a chunk is collection-scoped and repeatable', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: {
                'col-a': [{ hash: 'same', metadata: { context: 'context-a' } }],
                'col-b': [{ hash: 'same', metadata: { context: 'context-b' } }],
            },
        });
        configureChunkMetaStore({ transport: plugin.transport });

        await useChunkMetaCollection('col-a');
        saveSettingsDebounced.mockClear();
        deleteChunkMetadata('same');
        deleteChunkMetadata('same'); // a second delete must be a no-op

        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(getChunkMetadata('same')).toBeNull();

        // The same hash in another collection is untouched.
        await useChunkMetaCollection('col-b');
        expect(getChunkMetadata('same').context).toBe('context-b');
    });
});

// ---------------------------------------------------------------------------
// Hydration paging: the transport's list operation is paginated; a collection
// larger than one page must hydrate completely.
// ---------------------------------------------------------------------------

describe('hydration paging', () => {
    it('walks every page until the transport returns a short one', async () => {
        const chunks = Array.from({ length: 5 }, (_, index) => ({
            hash: String(index),
            metadata: { context: `context-${index}` },
        }));
        const plugin = createFakePlugin({ chunksByCollection: { 'col-a': chunks } });
        const store = createChunkMetaStore({
            getSettings: () => ({ chunk_meta_store: 'auto' }),
            transport: plugin.transport,
            pageSize: 2,
        });

        await store.useCollection('col-a');

        expect(plugin.calls.list.map((call) => call.offset)).toEqual([0, 2, 4]);
        expect(store.getMetadata('4').context).toBe('context-4');
    });

    it('stops when a page adds nothing new and does not trust a metadata-less listing', async () => {
        // The native standard-backend fallback ignores offset and returns the
        // whole hash list, with no metadata, on every call. Hydration must not
        // spin forever, and must not mark the collection hydrated from it.
        const items = Array.from({ length: 5 }, (_, index) => ({
            hash: String(index),
            metadata: { hash: String(index), text: 'only data fields' },
        }));
        let listCalls = 0;
        const transport = {
            isAvailable: () => true,
            async listChunks() {
                listCalls += 1;
                return { items };
            },
            async patchMetadata() {},
        };
        const store = createChunkMetaStore({
            getSettings: () => ({ chunk_meta_store: 'auto' }),
            transport,
            pageSize: 2,
        });

        const trusted = await store.useCollection('col-a');

        expect(trusted).toBe(false);
        expect(listCalls).toBe(2);
        expect(store.getMetadata('1')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Ticket 07: on the payload path a save writes no settings copy. The chunk
// payload is the source of truth, an edit costs one payload write, and the
// settings object is neither extended nor re-uploaded.
// ---------------------------------------------------------------------------

describe('payload path — a save writes no settings copy', () => {
    const withContext = () => createFakePlugin({
        chunksByCollection: { 'col-a': [{ hash: '12', metadata: { context: 'before' } }] },
    });

    it('mints no settings key and saves nothing for a chunk with no settings entry', async () => {
        const plugin = withContext();
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');
        saveSettingsDebounced.mockClear();

        saveChunkMetadata('12', { context: 'after' });
        await flushChunkMetaWrites();

        expect(plugin.calls.patch).toEqual([
            { collectionId: 'col-a', hash: '12', metadata: { context: 'after', updatedAt: expect.any(Number) } },
        ]);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(mockSettings.vectfox.vectfox_chunk_meta_12).toBeUndefined();
        expect(getChunkMetadata('12').context).toBe('after');
    });

    it('leaves an entry the sweep has not moved yet untouched rather than refreshing it', async () => {
        // Pre-sweep the settings entry is the sweep's work item. Rewriting it on
        // every edit is exactly the full-blob upload this ticket removes.
        const plugin = withContext();
        mockSettings.vectfox.vectfox_chunk_meta_12 = { context: 'settings-copy' };
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');
        saveSettingsDebounced.mockClear();

        saveChunkMetadata('12', { context: 'after' });
        await flushChunkMetaWrites();

        expect(plugin.calls.patch).toHaveLength(1);
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(mockSettings.vectfox.vectfox_chunk_meta_12).toEqual({ context: 'settings-copy' });
        expect(getChunkMetadata('12').context).toBe('after');
    });
});

// ---------------------------------------------------------------------------
// Ticket 07: the one exception. Client-only fields (summaries) have no payload
// representation, so they still go to settings — and nothing else does, so a
// summary edit cannot re-inflate the settings object with payload metadata.
// ---------------------------------------------------------------------------

describe('client-only fields — settings holds only what a payload cannot', () => {
    it('writes the summaries and no payload field to a new settings entry', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '3', metadata: { context: 'payload-context' } }] },
        });
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');
        const existing = getChunkMetadata('3');
        saveSettingsDebounced.mockClear();

        saveChunkMetadata('3', { ...existing, summaries: ['a dual-vector summary'] });

        expect(mockSettings.vectfox.vectfox_chunk_meta_3).toMatchObject({
            summaries: ['a dual-vector summary'],
        });
        expect(mockSettings.vectfox.vectfox_chunk_meta_3).not.toHaveProperty('context');
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
        expect(getChunkMetadata('3').context).toBe('payload-context');
        expect(getChunkMetadata('3').summaries).toEqual(['a dual-vector summary']);
    });

    it('keeps the fields an existing entry already holds', async () => {
        const plugin = createFakePlugin({ chunksByCollection: { 'col-a': [] } });
        mockSettings.vectfox.vectfox_chunk_meta_4 = { xmlTag: 'legacy-tag' };
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');

        saveChunkMetadata('4', { summaries: ['summary'] });

        expect(mockSettings.vectfox.vectfox_chunk_meta_4).toMatchObject({
            xmlTag: 'legacy-tag',
            summaries: ['summary'],
        });
    });
});

// ---------------------------------------------------------------------------
// Ticket 07: a failed payload write falls back to a settings write, so an edit
// is never left only in memory. Reading it back merges payload-first per field,
// and it survives a reload. The bounded retry is ticket 09.
// ---------------------------------------------------------------------------

describe('failed payload write — falls back to settings instead of losing the edit', () => {
    it('persists the refused fields to settings so a reload still resolves them', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '21', metadata: { context: 'before' } }] },
        });
        const failingTransport = {
            ...plugin.transport,
            async patchMetadata() { throw new Error('plugin restarted'); },
        };
        configureChunkMetaStore({ transport: failingTransport });
        await useChunkMetaCollection('col-a');
        saveSettingsDebounced.mockClear();

        saveChunkMetadata('21', { xmlTag: 'edited-tag' });
        await flushChunkMetaWrites();

        expect(mockSettings.vectfox.vectfox_chunk_meta_21).toMatchObject({ xmlTag: 'edited-tag' });
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);

        // Reload: the mirror is gone and the payload never took the edit. The
        // payload still serves the fields it holds; the refused field comes from
        // the settings copy, so nothing is lost.
        resetChunkMetaStore();
        configureChunkMetaStore({ transport: failingTransport });
        await useChunkMetaCollection('col-a');

        expect(getChunkMetadata('21')).toMatchObject({ context: 'before', xmlTag: 'edited-tag' });
    });

    it('keeps the refused edit in settings even when the payload still masks it', async () => {
        // The merge rule is payload-first per field, so a field the old payload
        // still holds keeps showing the old value until the payload is repaired.
        // The edit is therefore held in settings — the disagreement between the
        // two stores that ticket 09's queue replays — and never only in memory.
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '23', metadata: { context: 'before' } }] },
        });
        const failingTransport = {
            ...plugin.transport,
            async patchMetadata() { throw new Error('plugin restarted'); },
        };
        configureChunkMetaStore({ transport: failingTransport });
        await useChunkMetaCollection('col-a');

        saveChunkMetadata('23', { context: 'after' });
        await flushChunkMetaWrites();

        expect(mockSettings.vectfox.vectfox_chunk_meta_23).toMatchObject({ context: 'after' });
    });

    it('mints no settings entry for a chunk deleted while its write was in flight', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '22', metadata: { context: 'before' } }] },
        });
        let rejectPatch;
        const transport = {
            ...plugin.transport,
            patchMetadata: () => new Promise((_, reject) => { rejectPatch = reject; }),
        };
        configureChunkMetaStore({ transport });
        await useChunkMetaCollection('col-a');
        saveSettingsDebounced.mockClear();

        saveChunkMetadata('22', { context: 'gone' });
        const flushing = flushChunkMetaWrites();
        deleteChunkMetadata('22');
        rejectPatch(new Error('plugin restarted'));
        await flushing;

        expect(mockSettings.vectfox.vectfox_chunk_meta_22).toBeUndefined();
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Ticket 07: the rollback. The `settings` policy restores the previous write
// behaviour without a redeploy — settings entry plus one settings save, and no
// payload request.
// ---------------------------------------------------------------------------

describe('store policy settings — the rollback restores the previous write behaviour', () => {
    it('writes the settings entry and issues no payload request', async () => {
        const plugin = createFakePlugin({
            chunksByCollection: { 'col-a': [{ hash: '31', metadata: { context: 'before' } }] },
        });
        mockSettings.vectfox.chunk_meta_store = 'settings';
        configureChunkMetaStore({ transport: plugin.transport });
        await useChunkMetaCollection('col-a');
        saveSettingsDebounced.mockClear();

        saveChunkMetadata('31', { context: 'after' });
        await flushChunkMetaWrites();

        expect(plugin.calls.patch).toEqual([]);
        expect(mockSettings.vectfox.vectfox_chunk_meta_31).toMatchObject({ context: 'after' });
        expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    it('reports the store it resolves to', () => {
        const plugin = createFakePlugin();
        configureChunkMetaStore({ transport: plugin.transport });
        expect(isChunkMetaPayloadStore()).toBe(true);

        mockSettings.vectfox.chunk_meta_store = 'settings';
        expect(isChunkMetaPayloadStore()).toBe(false);

        resetChunkMetaStore();
        configureChunkMetaStore({ transport: null });
        expect(isChunkMetaPayloadStore()).toBe(false);
    });
});
