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
 * A payload-path save writes no settings copy of the payload metadata (ticket
 * 07). The settings object is only touched for fields a payload cannot carry
 * (client-only `summaries`) and when a payload write fails, where the refused
 * fields are persisted to settings instead of being lost. Bulk writers such as
 * keyword persistence ask `isPayloadStore` before minting a settings key the
 * payload already holds.
 *
 * A failed write also records a bounded retry (ticket 09), delegated to
 * core/chunk-meta-retry-queue.js: a small durable record in settings names the
 * chunk and the refused fields, and an in-memory queue replays them with
 * backoff. A successful retry removes the settings copy it superseded. The
 * records are read back on the next hydration, where the disagreement between
 * the two stores decides what is already repaired and what is still owed. The
 * queue is capped; reaching the cap drops the oldest repair and warns rather
 * than failing silently.
 *
 * The legacy settings shape (`vectfox_chunk_meta_<hash>`) is defined in
 * core/chunk-meta-keys.js and owned by core/collection-metadata.js, which reaches
 * this module through the injected readLegacy / writeLegacy / mergeLegacy /
 * deleteLegacy / listLegacy callbacks. The store decides *when* settings is
 * written and *which fields* belong there (from the injected client-only list);
 * the shape owner decides what the entry looks like.
 */

import { log } from './log.js';
import {
    chunkHashOf,
    chunkMetadataFromPayload,
    chunkMetadataKey,
    hasValue,
    splitForPayload,
} from './chunk-meta-fields.js';
import { listAllChunkItems } from './chunk-paging.js';
import { createChunkMetaRetrier } from './chunk-meta-retry-queue.js';
import { RETRY_QUEUE_CAP } from './chunk-meta-retry.js';

/** Chunk hash as used by the public functions (numeric or string). */
function hashKey(hash) {
    return String(hash);
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
 * @param {() => object|null} [deps.getSettings] - VectFox settings (store policy)
 * @param {(hash: string) => object|null} [deps.readLegacy] - settings entry for a chunk
 * @param {(hash: string, metadata: object) => void} [deps.writeLegacy] - replace settings entry
 * @param {(hash: string, metadata: object) => number} [deps.pruneLegacy] - remove the fields a
 *     successful payload retry superseded; returns how many were removed without saving
 * @param {(hash: string) => boolean} [deps.deleteLegacy] - remove settings entry; true when it existed
 * @param {() => object} [deps.listLegacy] - hash -> metadata map from settings
 * @param {() => void} [deps.persistSettings] - persist extension_settings
 * @param {string[]} [deps.clientOnlyFields] - fields that never travel to the payload
 * @param {{ isAvailable: () => boolean, listChunks: Function, patchMetadata: Function }} [deps.transport]
 * @param {number} [deps.debounceMs] - payload write debounce
 * @param {number} [deps.pageSize] - chunks/list page size while hydrating
 * @param {number} [deps.retryCap] - maximum queued payload repairs
 * @param {number} [deps.retryMaxAttempts] - automatic attempts per repair before it waits for a reload
 * @param {number} [deps.retryDelayMs] - first retry delay
 * @param {number} [deps.retryMaxDelayMs] - retry backoff ceiling
 */
export function createChunkMetaStore({
    getSettings = () => null,
    readLegacy = () => null,
    writeLegacy = () => {},
    mergeLegacy = () => {},
    pruneLegacy = () => 0,
    deleteLegacy = () => false,
    listLegacy = () => ({}),
    persistSettings = () => {},
    clientOnlyFields = [],
    transport = null,
    debounceMs = 2000,
    pageSize = 500,
    retryCap = RETRY_QUEUE_CAP,
    retryMaxAttempts = 5,
    retryDelayMs = 5000,
    retryMaxDelayMs = 30000,
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
    /** Collections forgotten by a deletion; an in-flight hydration must not refill them. */
    const forgotten = new Set();

    let activeCollectionId = null;

    function payloadAvailable() {
        try {
            return Boolean(transport?.isAvailable?.());
        } catch (_) {
            return false;
        }
    }

    // Failed payload writes are replayed by the retry scheduler; the store only
    // enqueues them and delegates the queue, backoff and reload reconciliation.
    const retrier = createChunkMetaRetrier({
        getSettings,
        readLegacy,
        pruneLegacy,
        persistSettings,
        patchMetadata: async (collectionId, hash, metadata) => {
            if (!transport) throw new Error('chunk metadata transport is unavailable');
            await transport.patchMetadata(collectionId, hash, metadata);
        },
        shouldRepair: () => mode() === 'payload',
        warn: (message) => log.warn(`VectFox: ${message}`),
        cap: retryCap,
        maxAttempts: retryMaxAttempts,
        delayMs: retryDelayMs,
        maxDelayMs: retryMaxDelayMs,
    });

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

    /**
     * Whether this install's chunk metadata lives in the chunk payload. Bulk
     * writers ask before falling back to settings: on the payload path the
     * payload already holds the value they would otherwise mint a settings key
     * for (see `saveMetadata`).
     */
    function isPayloadStore() {
        return mode() === 'payload';
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

    function fetchCollection(collectionId) {
        // The paging termination rules live in core/chunk-paging.js: the sweep
        // scan reads whole collections the same way, and they must not drift.
        return listAllChunkItems(
            (id, options) => transport.listChunks(id, options),
            collectionId,
            { pageSize },
        );
    }

    /** Drops the write guards for one collection once its snapshot is applied. */
    function clearLocalWrites(collectionId) {
        const prefix = chunkMetadataKey(collectionId, '');
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
        if (!isPayloadStore() || !transport) return Promise.resolve(false);

        let trusted = false;
        const job = (async () => {
            try {
                const { items, complete } = await fetchCollection(id);
                // The collection was deleted while this listing was in flight: its
                // payload is gone, and refilling the mirror would serve a ghost.
                if (forgotten.has(id)) return false;
                if (!complete) {
                    // A partial listing tells us nothing about the chunks it did
                    // not return. Keep the settings fallback (do not mark the
                    // collection hydrated) so a read never goes payload-blind.
                    log.warn(`VectFox: chunk metadata listing for ${id} ended before every chunk was read — keeping the settings fallback`);
                    return false;
                }
                const byHash = new Map();
                const existing = mirror.get(id);
                if (existing) {
                    // Keep edits made while the hydration was in flight.
                    for (const [key, value] of existing) {
                        if (locallyWritten.has(chunkMetadataKey(id, key))) byHash.set(key, value);
                    }
                }
                let withMetadata = 0;
                const presentHashes = new Set();
                for (const item of items) {
                    const key = chunkHashOf(item);
                    if (key === null) continue;
                    presentHashes.add(key);
                    if (locallyWritten.has(chunkMetadataKey(id, key))) continue;
                    const metadata = chunkMetadataFromPayload(item?.metadata);
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
                if (trusted) {
                    hydrated.add(id);
                    // Reload reconciliation (ticket 09): the durable records plus
                    // this snapshot say which failed writes the payload still owes.
                    retrier.rebuild(id, presentHashes, hash => mirror.get(id)?.get(hash) || {});
                }
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
        // A collection deleted last time it was in use may be back (re-vectorized,
        // re-imported); its next hydration is the proof, not the old tombstone.
        forgotten.delete(activeCollectionId);
        return hydrate(activeCollectionId);
    }

    function queuePayloadWrite(collectionId, hash, metadata) {
        const key = chunkMetadataKey(collectionId, hashKey(hash));
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
                // The payload refused the edit and, since ticket 07, settings holds
                // no copy of it — so until this runs, the change exists only in
                // memory. Persist the refused fields to settings: the read path
                // merges payload-first per field, so they are served immediately and
                // survive a reload instead of vanishing with the mirror. Ticket 09
                // adds the durable record and the bounded retry that repairs the
                // payload and removes this copy again once it succeeds.
                log.warn(`VectFox: chunk metadata payload write failed for ${entry.collectionId}/${entry.hash}: ${err?.message || err}`);
                // The mirror entry is the "is this chunk still wanted" check: a
                // chunk deleted (or a store reset) while the write was in flight
                // must not gain a settings entry here — that would mint the orphan
                // this feature exists to remove.
                if (mirror.get(String(entry.collectionId))?.has(hashKey(entry.hash))) {
                    mergeLegacy(entry.hash, entry.metadata);
                    retrier.enqueue(entry.collectionId, entry.hash, Object.keys(entry.metadata || {}));
                    persistSettings();
                }
            } finally {
                inFlight.delete(key);
            }
        })();

        inFlight.set(key, job);
        return job;
    }

    function saveMetadata(hash, metadata) {
        const stamped = { ...(metadata || {}), updatedAt: Date.now() };

        if (isPayloadStore() && activeCollectionId && transport) {
            const key = hashKey(hash);
            const collectionId = activeCollectionId;
            const byHash = mirror.get(collectionId) || new Map();
            const previous = byHash.get(key) || null;
            // What the read path resolves right now, before this save. A save that
            // only changes a client-only field arrives carrying the unchanged
            // payload fields too (the visualizer merges the load-time read), so
            // compare against the resolved view, not just the payload mirror.
            const current = mergeChunkMetadata(previous, readLegacy(hash));
            const split = splitForPayload(stamped, clientOnly);
            const patch = split.payload;

            byHash.set(key, { ...(previous || {}), ...stamped });
            mirror.set(collectionId, byHash);

            // No settings copy of the payload metadata is written here any more
            // (ticket 07): it duplicated every field into the settings object,
            // and persisting it re-uploaded the whole blob on every edit. Only
            // fields no payload can carry (`summaries`) still go to settings,
            // merged into the entry so a field only settings holds is never
            // dropped. The sweep removes the entries left from before, after
            // which this writes nothing at all.
            if (Object.keys(split.clientOnly).length > 0) {
                mergeLegacy(hash, { ...split.clientOnly, updatedAt: stamped.updatedAt });
                persistSettings();
            }

            const changed = patch && Object.entries(patch).some(
                ([field, value]) => field !== 'updatedAt' && (!current || current[field] !== value),
            );
            if (changed) queuePayloadWrite(collectionId, hash, patch);
            return;
        }

        // No-plugin path: byte-identical to the pre-store behaviour.
        writeLegacy(hash, stamped);
        persistSettings();
    }

    /**
     * Drops payload state for chunks that are gone from the collection in use:
     * their mirror entries, and any payload write still waiting on the debounce.
     * The caller owns the settings side, because whether a settings entry may go
     * depends on the other collections holding the same content hash.
     * @param {Iterable<string|number>} hashes Deleted chunk hashes
     */
    function forgetChunks(hashes) {
        const keys = new Set([...(hashes || [])].map(hashKey));
        if (keys.size === 0) return;
        if (activeCollectionId) {
            const byHash = mirror.get(activeCollectionId);
            if (byHash) {
                for (const key of keys) byHash.delete(key);
            }
        }
        // Cancel queued writes for these chunks so a pending save cannot
        // resurrect metadata that was just deleted.
        for (const [pendingKey, queued] of [...pending]) {
            if (!keys.has(hashKey(queued.hash))) continue;
            if (activeCollectionId && String(queued.collectionId) !== activeCollectionId) continue;
            if (queued.timer) clearTimeout(queued.timer);
            pending.delete(pendingKey);
            locallyWritten.delete(pendingKey);
        }
        // A repair queued for a deleted chunk would write metadata the backend no
        // longer has; drop it too. Its settings entry is the caller's business.
        retrier.forgetChunks(activeCollectionId, keys);
    }

    /**
     * Drops every trace of a deleted collection: its mirror, its hydration state
     * and its queued payload writes and repairs. An in-flight hydration is ignored
     * when it lands (`forgotten`), and a failed write can no longer mint a
     * settings entry for it (the failure path checks the mirror).
     * @param {string} collectionId Deleted collection's key
     */
    function forgetCollection(collectionId) {
        const id = String(collectionId || '');
        if (!id) return;
        forgotten.add(id);
        mirror.delete(id);
        hydrated.delete(id);
        hydrating.delete(id);
        const prefix = chunkMetadataKey(id, '');
        for (const [key, entry] of [...pending]) {
            if (!key.startsWith(prefix)) continue;
            if (entry.timer) clearTimeout(entry.timer);
            pending.delete(key);
            locallyWritten.delete(key);
        }
        retrier.forgetCollection(id);
    }

    /**
     * One collection's chunk hashes, read through the transport. Membership is all
     * the garbage collection needs, so this deliberately returns hashes and not
     * metadata — and it works without the plugin, because a standard-backend
     * install lists its hashes natively.
     *
     * `complete` is the proof the caller must have before deleting anything: a
     * failed or truncated listing cannot say which chunks the collection held.
     * @param {string} collectionId Collection key (registry key or bare id)
     * @returns {Promise<{ hashes: string[], complete: boolean }>}
     */
    function listCollectionHashes(collectionId) {
        const id = String(collectionId || '');
        if (!id || !transport || typeof transport.listChunks !== 'function') {
            return Promise.resolve({ hashes: [], complete: false });
        }
        return (async () => {
            try {
                const { items, complete } = await fetchCollection(id);
                const hashes = [];
                const seen = new Set();
                for (const item of items) {
                    const hash = chunkHashOf(item);
                    if (hash === null || seen.has(hash)) continue;
                    seen.add(hash);
                    hashes.push(hash);
                }
                return { hashes, complete };
            } catch (err) {
                log.warn(`VectFox: could not list ${id}'s chunks for chunk-metadata cleanup — deleting nothing: ${err?.message || err}`);
                return { hashes: [], complete: false };
            }
        })();
    }

    function deleteMetadata(hash) {
        forgetChunks([hash]);
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
        // Then replay every recorded repair, forcing past its backoff: a flush
        // means "finish the pending work now", and a repair that cannot succeed
        // stays recorded for the next hydration.
        await retrier.drain({ force: true });
    }

    function getRetryState() {
        return retrier.state();
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
        forgotten.clear();
        retrier.reset();
        activeCollectionId = null;
    }

    return {
        useCollection,
        getMetadata,
        saveMetadata,
        deleteMetadata,
        getAllMetadata,
        forgetChunks,
        forgetCollection,
        listCollectionHashes,
        isPayloadStore,
        getRetryState,
        flush,
        reset,
        configure: ({ transport: nextTransport } = {}) => {
            if (nextTransport !== undefined) transport = nextTransport;
        },
    };
}
