/**
 * VECTFOX CHUNK METADATA STORE
 *
 * Owns where per-chunk metadata lives. On a plugin install the chunk payload is
 * the source of truth (ADR-0003); extension_settings remains the legacy store
 * and the only store for installs without the plugin.
 *
 * The public functions behind this module stay synchronous. A per-collection
 * in-memory mirror, hydrated lazily from the transport on first use, backs them;
 * persistence is asynchronous, coalesced per chunk and debounced.
 *
 * The legacy settings shape (`vectfox_chunk_meta_<hash>`) is owned by
 * core/collection-metadata.js and reached through the injected readLegacy /
 * writeLegacy / deleteLegacy / listLegacy callbacks, so this module never
 * touches the settings object's shape.
 */

import { log } from './log.js';

/** Payload keys that are chunk data, not chunk metadata; not copied into the mirror. */
const PAYLOAD_NON_METADATA_KEYS = new Set(['hash', 'text', 'index', 'vector']);

/** Chunk hash as used by the public functions (numeric or string). */
function hashKey(hash) {
    return String(hash);
}

/** Preserve the caller's hash type for the transport, drop payload data keys. */
function payloadMetadata(rawMetadata) {
    const metadata = {};
    for (const [field, value] of Object.entries(rawMetadata || {})) {
        if (PAYLOAD_NON_METADATA_KEYS.has(field)) continue;
        metadata[field] = value;
    }
    return metadata;
}

/**
 * The fields of a save that belong in the payload. Returns null when the save
 * carries only client-only bookkeeping (e.g. a summaries edit), so that edit
 * does not produce a pointless payload request.
 */
function payloadPatch(metadata, clientOnlyFields) {
    const patch = payloadMetadata(metadata);
    for (const field of clientOnlyFields) delete patch[field];
    const persistable = Object.keys(patch).some((field) => field !== 'updatedAt');
    return persistable ? patch : null;
}

function queueKey(collectionId, hash) {
    return `${collectionId}\u0000${hash}`;
}

/**
 * "Holds a value" for merge purposes. Empty strings, empty arrays and empty
 * objects are absences, not values — matching the read-source contract the
 * visualizer already applies (an explicitly blanked field falls back). `false`
 * and `0` are values.
 */
function hasValue(value) {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

/**
 * Resolves one chunk's metadata per field: the payload wins where it holds a
 * value, the legacy settings entry fills the fields it lacks. A field present in
 * neither store is simply absent. Returns null when neither store has the chunk.
 */
function mergeChunkMetadata(payload, legacy) {
    if (!payload) return legacy ? { ...legacy } : null;
    if (!legacy) return { ...payload };
    const merged = { ...legacy };
    for (const [field, value] of Object.entries(payload)) {
        if (hasValue(value) || !(field in merged)) merged[field] = value;
    }
    return merged;
}

/**
 * @param {object} [deps]
 * @param {() => object|null} [deps.getSettings] - VectFox settings (policy + shadow flags)
 * @param {(hash: string) => object|null} [deps.readLegacy] - settings entry for a chunk
 * @param {(hash: string, metadata: object) => void} [deps.writeLegacy] - replace settings entry
 * @param {(hash: string) => boolean} [deps.deleteLegacy] - remove settings entry; true when it existed
 * @param {() => object} [deps.listLegacy] - hash -> metadata map from settings
 * @param {() => void} [deps.persistSettings] - persist extension_settings
 * @param {string[]} [deps.clientOnlyFields] - fields that never travel to the payload
 * @param {{ isAvailable: () => boolean, listChunks: Function, patchMetadata: Function }} [deps.transport]
 * @param {number} [deps.debounceMs] - payload write debounce
 * @param {number} [deps.pageSize] - chunks/list page size while hydrating
 */
export function createChunkMetaStore({
    getSettings = () => null,
    readLegacy = () => null,
    writeLegacy = () => {},
    deleteLegacy = () => false,
    listLegacy = () => ({}),
    persistSettings = () => {},
    clientOnlyFields = [],
    transport = null,
    debounceMs = 2000,
    pageSize = 500,
} = {}) {
    const clientOnly = new Set(clientOnlyFields);

    /** collectionId -> Map(hash -> payload metadata) */
    const mirror = new Map();
    const hydrated = new Set();
    /** collectionId -> Promise<boolean> for a hydration in progress */
    const hydrating = new Map();
    /** queueKey -> { collectionId, hash, metadata, timer } */
    const pending = new Map();
    /** queueKey -> Promise for an in-flight payload write */
    const inFlight = new Map();
    /** queueKeys whose local value is newer than the hydrated snapshot */
    const locallyWritten = new Set();

    let activeCollectionId = null;

    function payloadAvailable() {
        try {
            return Boolean(transport?.isAvailable?.());
        } catch (_) {
            return false;
        }
    }

    /**
     * `auto` (default) uses the payload when the plugin transport is reachable and
     * settings otherwise. An explicit `settings` always wins; an explicit `payload`
     * still degrades to settings when no transport is reachable, so an outage
     * cannot lose an edit.
     */
    function mode() {
        const configured = getSettings?.()?.chunk_meta_store;
        if (configured === 'settings') return 'settings';
        return payloadAvailable() ? 'payload' : 'settings';
    }

    function shadowEnabled() {
        return getSettings?.()?.chunk_meta_shadow !== false;
    }

    /**
     * Payload reads are collection-scoped (ADR-0003 decision 4): only the
     * collection currently in use is consulted. Without an active collection the
     * hash-only public API cannot know which collection's entry is meant, so it
     * falls back to settings rather than guessing across hydrated collections.
     */
    function findPayload(hash) {
        if (!activeCollectionId) return null;
        return mirror.get(activeCollectionId)?.get(hashKey(hash)) || null;
    }

    function getMetadata(hash) {
        return mergeChunkMetadata(findPayload(hash), readLegacy(hash));
    }

    async function fetchCollection(collectionId) {
        const items = [];
        const seen = new Set();
        let offset = 0;
        for (;;) {
            const page = await transport.listChunks(collectionId, { offset, limit: pageSize });
            const pageItems = Array.isArray(page?.items) ? page.items : [];
            let added = 0;
            for (const item of pageItems) {
                const hash = item?.hash ?? item?.metadata?.hash;
                if (hash === undefined || hash === null) continue;
                const key = hashKey(hash);
                if (seen.has(key)) continue;
                seen.add(key);
                items.push(item);
                added += 1;
            }
            // Stop on a short/empty page, and also when a page adds nothing new:
            // the native standard-backend fallback ignores offset and returns the
            // whole hash list every time, which would otherwise loop forever.
            if (pageItems.length < pageSize || added === 0) break;
            offset += pageItems.length;
        }
        return items;
    }

    /** Drops the write guards for one collection once its snapshot is applied. */
    function clearLocalWrites(collectionId) {
        const prefix = `${collectionId}\u0000`;
        for (const key of [...locallyWritten]) {
            if (key.startsWith(prefix)) locallyWritten.delete(key);
        }
    }

    /**
     * Hydrates one collection's payload metadata into the mirror. Idempotent and
     * concurrent-safe; a failure leaves the collection unhydrated so reads keep
     * falling back to settings.
     */
    function hydrate(collectionId) {
        const id = String(collectionId);
        if (hydrated.has(id)) return Promise.resolve(true);
        const running = hydrating.get(id);
        if (running) return running;
        if (mode() !== 'payload' || !transport) return Promise.resolve(false);

        let trusted = false;
        const job = (async () => {
            try {
                const items = await fetchCollection(id);
                const byHash = new Map();
                const existing = mirror.get(id);
                if (existing) {
                    // Keep edits made while the hydration was in flight.
                    for (const [key, value] of existing) {
                        if (locallyWritten.has(queueKey(id, key))) byHash.set(key, value);
                    }
                }
                let withMetadata = 0;
                for (const item of items) {
                    const hash = item?.hash ?? item?.metadata?.hash;
                    if (hash === undefined || hash === null) continue;
                    const key = hashKey(hash);
                    if (locallyWritten.has(queueKey(id, key))) continue;
                    const metadata = payloadMetadata(item?.metadata);
                    // A payload with no metadata of its own is not an entry; reads
                    // keep falling back to settings for that chunk.
                    if (Object.keys(metadata).length === 0) continue;
                    withMetadata += 1;
                    byHash.set(key, metadata);
                }
                mirror.set(id, byHash);
                // A listing that returned chunks but no metadata at all is the
                // native hashes-only fallback, not a hydrated collection. Marking
                // it hydrated would leave payload reads dead for the session.
                trusted = items.length === 0 || withMetadata > 0;
                if (trusted) hydrated.add(id);
                return trusted;
            } catch (err) {
                log.warn(`VectFox: chunk metadata hydration failed for ${id} — keeping the settings fallback: ${err?.message || err}`);
                return false;
            } finally {
                hydrating.delete(id);
                // The snapshot has been applied, so the write guard it needed is
                // no longer required. A failed/untrusted hydration keeps its guard.
                if (trusted) clearLocalWrites(id);
            }
        })();

        hydrating.set(id, job);
        return job;
    }

    /**
     * Marks a collection as the one in use and begins its lazy hydration. This is
     * the only entry point that starts a fetch; construction and startup do not.
     * Passing null clears the active collection.
     */
    function useCollection(collectionId) {
        if (!collectionId) {
            // Leaving a collection (e.g. closing the visualizer) stops later
            // unqualified writes from landing in a collection no longer in use.
            activeCollectionId = null;
            return Promise.resolve(false);
        }
        activeCollectionId = String(collectionId);
        return hydrate(activeCollectionId);
    }

    function queuePayloadWrite(collectionId, hash, metadata) {
        const key = queueKey(collectionId, hashKey(hash));
        locallyWritten.add(key);
        const existing = pending.get(key);
        if (existing?.timer) clearTimeout(existing.timer);
        const merged = { ...(existing?.metadata || {}), ...metadata };
        // unref keeps a Node/vitest process from being pinned by the timer; the
        // browser ignores it.
        const timer = setTimeout(() => { void flushOne(key); }, debounceMs);
        if (typeof timer?.unref === 'function') timer.unref();
        pending.set(key, { collectionId, hash, metadata: merged, timer });
    }

    function flushOne(key) {
        const running = inFlight.get(key);
        if (running) {
            // A newer save landed while this write was in flight: run it after,
            // rather than returning the older promise and silently dropping it.
            return running.then(() => flushOne(key));
        }
        const entry = pending.get(key);
        if (!entry) return Promise.resolve();
        pending.delete(key);
        if (entry.timer) clearTimeout(entry.timer);

        const job = (async () => {
            try {
                await transport.patchMetadata(entry.collectionId, entry.hash, entry.metadata);
                // Keep the guard while a hydration snapshot is in flight so the
                // newer local value is not overwritten by an older listing.
                if (!hydrating.has(entry.collectionId)) locallyWritten.delete(key);
            } catch (err) {
                // The shadow settings copy (written at save time) holds the edit;
                // the failed payload write and its bounded retry are ticket 09.
                // Keep the local mirror value so this session still sees the edit.
                log.warn(`VectFox: chunk metadata payload write failed for ${entry.collectionId}/${entry.hash}: ${err?.message || err}`);
            } finally {
                inFlight.delete(key);
            }
        })();

        inFlight.set(key, job);
        return job;
    }

    function saveMetadata(hash, metadata) {
        const stamped = { ...(metadata || {}), updatedAt: Date.now() };

        if (mode() === 'payload' && activeCollectionId && transport) {
            const key = hashKey(hash);
            const byHash = mirror.get(activeCollectionId) || new Map();
            const previous = byHash.get(key) || null;
            // What the read path resolves right now, before this save. A save that
            // only changes a client-only field arrives carrying the unchanged
            // payload fields too (the visualizer merges the load-time read), so
            // compare against the resolved view, not just the payload mirror.
            const current = mergeChunkMetadata(previous, readLegacy(hash));
            const patch = payloadPatch(stamped, clientOnly);

            byHash.set(key, { ...(previous || {}), ...stamped });
            mirror.set(activeCollectionId, byHash);

            // Shadow dual-write: the rehearsal release keeps the legacy copy until
            // the explicit sweep deletes it.
            if (shadowEnabled()) {
                writeLegacy(hash, stamped);
                persistSettings();
            }

            const changed = patch && Object.entries(patch).some(
                ([field, value]) => field !== 'updatedAt' && (!current || current[field] !== value),
            );
            if (changed) queuePayloadWrite(activeCollectionId, hash, patch);
            return;
        }

        // No-plugin path: byte-identical to the pre-store behaviour.
        writeLegacy(hash, stamped);
        persistSettings();
    }

    function deleteMetadata(hash) {
        const key = hashKey(hash);
        // Collection-scoped like every other payload operation: deleting a chunk
        // in one collection must not touch the same text hash in another.
        if (activeCollectionId) {
            mirror.get(activeCollectionId)?.delete(key);
        }
        // Cancel queued writes for this chunk so a pending save cannot resurrect
        // metadata that was just deleted.
        for (const [pendingKey, queued] of pending) {
            if (hashKey(queued.hash) !== key) continue;
            if (activeCollectionId && String(queued.collectionId) !== activeCollectionId) continue;
            if (queued.timer) clearTimeout(queued.timer);
            pending.delete(pendingKey);
            locallyWritten.delete(pendingKey);
        }
        if (deleteLegacy(hash)) persistSettings();
    }

    function getAllMetadata() {
        const all = { ...(listLegacy() || {}) };
        // Same collection scoping as the single-chunk read: only the collection
        // in use contributes payload entries.
        if (activeCollectionId) {
            for (const [hash, metadata] of mirror.get(activeCollectionId) || []) {
                all[hash] = mergeChunkMetadata(metadata, all[hash]) ?? {};
            }
        }
        return all;
    }

    async function flush() {
        // Drain the debounce queue, then wait for writes that a timer already
        // started, so a caller can rely on everything having reached the payload.
        for (;;) {
            const keys = [...pending.keys()];
            if (keys.length === 0) break;
            await Promise.all(keys.map(flushOne));
        }
        await Promise.all([...inFlight.values()]);
    }

    function reset() {
        for (const entry of pending.values()) {
            if (entry.timer) clearTimeout(entry.timer);
        }
        pending.clear();
        inFlight.clear();
        locallyWritten.clear();
        mirror.clear();
        hydrated.clear();
        hydrating.clear();
        activeCollectionId = null;
    }

    return {
        useCollection,
        getMetadata,
        saveMetadata,
        deleteMetadata,
        getAllMetadata,
        flush,
        reset,
        configure: ({ transport: nextTransport } = {}) => {
            if (nextTransport !== undefined) transport = nextTransport;
        },
    };
}
