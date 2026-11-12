/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA RETRY QUEUE
 * ============================================================================
 * The scheduling half of ADR-0003 decision 5. The durable records live in
 * settings (core/chunk-meta-retry.js); this module keeps the in-memory queue,
 * backoff timer and reload reconciliation behind a small injected surface —
 * read the legacy entry, prune superseded fields, call the transport, save.
 *
 * The store owns chunk metadata, not retry policy: it enqueues a failed write
 * and delegates everything else here. Keeping the scheduler separate is what
 * lets the store stay about hydration and reads, and lets the retry rules
 * (backoff, give-up, cap, reconciliation) sit in one place.
 *
 * A repair's values are read from the settings entry at attempt time, never
 * captured at failure time, so a newer fallback written while the repair waited
 * is the value that gets written.
 * ============================================================================
 */

import { chunkMetadataKey, sameStoredValue } from './chunk-meta-fields.js';
import {
    normalizeRetryFields,
    readRetryRecords,
    removeRetryRecordsMatching,
    retryRecordFor,
    RETRY_QUEUE_CAP,
    updateRetryRecordFields,
    upsertRetryRecord,
} from './chunk-meta-retry.js';

/**
 * @param {object} [deps]
 * @param {() => object|null} [deps.getSettings] - VectFox settings (the records live there)
 * @param {(hash: string) => object|null} [deps.readLegacy] - settings entry for a chunk
 * @param {(hash: string, metadata: object) => number} [deps.pruneLegacy] - remove the fields a
 *     successful retry superseded; returns how many were removed without saving
 * @param {() => void} [deps.persistSettings] - persist extension_settings
 * @param {(collectionId: string, hash: string, metadata: object) => Promise<void>} [deps.patchMetadata]
 * @param {() => boolean} [deps.shouldRepair] - false while the store policy is rolled back
 *     to settings or the plugin probe reports an outage; repairs wait rather than
 *     writing a payload nobody reads any more or burning their budget while down
 * @param {(message: string) => void} [deps.warn] - the cap/give-up warnings
 * @param {number} [deps.cap] - maximum queued repairs
 * @param {number} [deps.maxAttempts] - attempts per repair before it waits for a reload
 * @param {number} [deps.delayMs] - first retry delay
 * @param {number} [deps.maxDelayMs] - backoff ceiling
 */
export function createChunkMetaRetrier({
    getSettings = () => null,
    readLegacy = () => null,
    pruneLegacy = () => 0,
    persistSettings = () => {},
    patchMetadata = async () => {},
    shouldRepair = () => true,
    warn = () => {},
    cap = RETRY_QUEUE_CAP,
    maxAttempts = 5,
    delayMs = 5000,
    maxDelayMs = 30000,
} = {}) {
    /** chunkMetadataKey -> { collectionId, hash, fields, attempts, nextAt } */
    const queue = new Map();
    /** chunkMetadataKey -> promise of the repair attempt currently in flight */
    const inFlight = new Map();
    let timer = null;
    /** Repairs dropped by the cap this session, for the health panel's warning. */
    let droppedCount = 0;

    /** One queue entry. The only place the in-memory shape is built. */
    function newEntry(collectionId, hash, fields, attempts = 0) {
        return {
            collectionId: String(collectionId),
            hash: String(hash),
            fields,
            attempts,
            nextAt: Date.now() + delayMs,
        };
    }

    /**
     * Saves a change this module made to settings. A save failure is reported
     * rather than thrown: the work has already happened in memory, a later save
     * will persist it, and a throwing timer callback would be an unhandled
     * rejection in the browser.
     */
    function persist() {
        try {
            persistSettings();
        } catch (err) {
            warn(`chunk metadata repair changed settings but could not save them: ${err?.message || err}`);
        }
    }

    /** Backoff before the next attempt, capped so a long outage polls slowly. */
    function backoff(attempts) {
        const exponent = Math.max(0, attempts - 1);
        return Math.min(delayMs * (2 ** exponent), maxDelayMs);
    }

    function cancelTimer() {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
    }

    /**
     * Fields another collection's pending repair still reads from the shared
     * legacy entry. The entry is global per content hash, so pruning a field on
     * one collection's success would erase the other collection's only fallback.
     * @param {object|null} settings VectFox settings.
     * @param {string} hash Chunk hash.
     * @param {string} collectionId The repair that may prune.
     * @returns {Set<string>}
     */
    function neededFieldsForOtherCollections(settings, hash, collectionId) {
        const id = chunkMetadataKey(String(collectionId ?? ''), String(hash ?? ''));
        const needed = new Set();
        for (const other of readRetryRecords(settings)) {
            if (chunkMetadataKey(other.collectionId, other.hash) === id) continue;
            if (other.hash !== hash) continue;
            for (const field of other.fields) needed.add(field);
        }
        return needed;
    }

    /** One timer for the whole queue, set for its earliest due repair. */
    function schedule() {
        if (timer || queue.size === 0) return;
        let nextAt = Infinity;
        for (const entry of queue.values()) {
            if (entry.nextAt < nextAt) nextAt = entry.nextAt;
        }
        const delay = Math.max(0, nextAt - Date.now());
        timer = setTimeout(() => {
            timer = null;
            void drain();
        }, delay);
        if (typeof timer?.unref === 'function') timer.unref();
    }

    /** Removes one record and its queue entry; returns whether a record was removed. */
    function forget(hash, collectionId = null) {
        const settings = getSettings?.();
        const removed = settings
            ? removeRetryRecordsMatching(settings, { collectionId, hashes: [hash] })
            : 0;
        queue.delete(chunkMetadataKey(String(collectionId ?? ''), String(hash ?? '')));
        return removed;
    }

    /**
     * Records a failed payload write and schedules its repair. The settings
     * entry already holds the refused fields; the record names them so a reload
     * can rebuild the work. Reaching the cap drops the oldest repair and says so
     * — silently losing the queue is the failure mode ADR-0003 warns about.
     */
    function enqueue(collectionId, hash, fields) {
        const id = String(collectionId);
        const key = String(hash);
        const list = normalizeRetryFields(fields);
        if (list.length === 0) return;

        const qkey = chunkMetadataKey(id, key);
        const existing = queue.get(qkey);
        const settings = getSettings?.();
        let mergedFields = normalizeRetryFields([...(existing?.fields || []), ...list]);
        if (settings) {
            const { records, dropped } = upsertRetryRecord(
                settings,
                { collectionId: id, hash: key, fields: list },
                cap,
            );
            for (const record of dropped) {
                droppedCount += 1;
                queue.delete(chunkMetadataKey(record.collectionId, record.hash));
                warn(`the chunk metadata retry queue is full (${cap}) — dropped the oldest pending repair for ${record.collectionId}/${record.hash}. The edit stays in settings; run the sweep to move it.`);
            }
            // The durable record owns the merged field list; a record the cap just
            // dropped is not scheduled at all.
            const stored = records.find(record => chunkMetadataKey(record.collectionId, record.hash) === qkey);
            if (!stored) {
                schedule();
                return;
            }
            mergedFields = stored.fields;
        }
        queue.set(qkey, newEntry(id, key, mergedFields, existing?.attempts || 0));
        schedule();
    }

    /**
     * One repair attempt, guarded so a timer, a flush and a retry of the same
     * chunk never run twice at once. A caller that arrives while one is running
     * awaits it, so a flush means the attempt it saw has actually finished.
     */
    function attempt(entry) {
        const qkey = chunkMetadataKey(entry.collectionId, entry.hash);
        const running = inFlight.get(qkey);
        if (running) return running;
        const job = (async () => {
            try {
                await attemptOnce(entry, qkey);
            } finally {
                inFlight.delete(qkey);
            }
        })();
        inFlight.set(qkey, job);
        return job;
    }

    async function attemptOnce(entry, qkey) {
        // A deliberate rollback to the settings store, or a probe-reported
        // outage, pauses repairs: writing a payload under a settings-only policy
        // would both write a store the user turned off and delete the copy the
        // policy depends on, and a backend that is down should not burn the
        // repair's attempt budget.
        if (!shouldRepair()) {
            entry.nextAt = Date.now() + maxDelayMs;
            schedule();
            return;
        }
        const settings = getSettings?.();
        const record = retryRecordFor(settings, entry.collectionId, entry.hash);
        if (!record) {
            queue.delete(qkey);
            return;
        }
        const before = readLegacy(entry.hash) || {};
        const metadata = {};
        for (const field of record.fields) {
            if (Object.prototype.hasOwnProperty.call(before, field)) metadata[field] = before[field];
        }
        if (Object.keys(metadata).length === 0) {
            // The settings copy is gone (swept, deleted, or replaced), so there is
            // nothing left to replay. The sweep/orphan tools own deleting entries.
            if (forget(entry.hash, entry.collectionId) > 0) persist();
            schedule();
            return;
        }

        try {
            await patchMetadata(entry.collectionId, entry.hash, metadata);
        } catch (err) {
            endAttempt(entry, err?.message || String(err));
            return;
        }

        // The payload accepted the repair. Remove the settings copies it
        // superseded — only fields whose value still matches what was written,
        // so a newer fallback that landed mid-retry survives — and keep a field
        // another collection's pending repair still needs: the legacy entry is
        // global per hash, so pruning it would erase that collection's fallback
        // before its own repair could read it.
        const neededByOthers = neededFieldsForOtherCollections(settings, entry.hash, entry.collectionId);
        const prunable = {};
        for (const [field, value] of Object.entries(metadata)) {
            if (neededByOthers.has(field)) continue;
            prunable[field] = value;
        }
        // The shape owner re-reads the entry and removes only the fields whose
        // value still matches, so a newer fallback that landed mid-retry stays.
        const pruned = Object.keys(prunable).length > 0
            ? (pruneLegacy(entry.hash, prunable) || 0)
            : 0;
        const after = readLegacy(entry.hash);
        const remaining = record.fields.filter(field => (
            after
            && Object.prototype.hasOwnProperty.call(after, field)
            && !sameStoredValue(after[field], metadata[field])
        ));
        let changed = pruned > 0;
        if (remaining.length === 0) {
            changed = removeRetryRecordsMatching(settings, {
                collectionId: entry.collectionId,
                hashes: [entry.hash],
            }) > 0 || changed;
            queue.delete(qkey);
        } else {
            // The payload accepted the request but still disagrees about these
            // fields (a newer fallback raced us, or the backend normalizes the
            // value). Count it as an attempt so a backend that never persists it
            // is bounded too, rather than looping every delay forever.
            changed = updateRetryRecordFields(settings, entry.collectionId, entry.hash, remaining) || changed;
            const nextAttempt = newEntry(entry.collectionId, entry.hash, remaining, entry.attempts || 0);
            queue.set(qkey, nextAttempt);
            endAttempt(nextAttempt, 'the payload still disagrees after the write');
        }
        if (changed) persist();
        schedule();
    }

    /**
     * Counts one failed attempt and applies the bound: the backoff grows, capped,
     * or the repair's automatic retries end for this session and its durable
     * record waits for the next reload with a fresh budget. The one owner of the
     * give-up policy, so the request-failure and after-write-disagreement paths
     * cannot drift apart.
     * @param {object} entry The queue entry that failed (attempts/nextAt updated).
     * @param {string} details Why it failed, for the warning.
     * @returns {boolean} Whether the repair gave up.
     */
    function endAttempt(entry, details) {
        const attempts = (entry.attempts || 0) + 1;
        entry.attempts = attempts;
        if (attempts >= maxAttempts) {
            queue.delete(chunkMetadataKey(entry.collectionId, entry.hash));
            warn(`chunk metadata repair for ${entry.collectionId}/${entry.hash} gave up after ${attempts} attempts (${details}) — the edit stays in settings until a reload or the sweep repairs it`);
            schedule();
            return true;
        }
        entry.nextAt = Date.now() + backoff(attempts);
        schedule();
        return false;
    }

    /**
     * Runs every due repair. `force` is used by an explicit flush, which means
     * "finish the pending work now" (page hide, a test, a caller that knows the
     * backend is back).
     */
    async function drain({ force = false } = {}) {
        cancelTimer();
        for (const entry of [...queue.values()]) {
            if (!queue.has(chunkMetadataKey(entry.collectionId, entry.hash))) continue;
            if (!force && entry.nextAt > Date.now()) continue;
            await attempt(entry);
        }
        schedule();
    }

    /**
     * Rebuilds the session's queue from the durable records after a hydration.
     * A record field the payload already holds equal is not owed any more, so
     * its settings copy is pruned and dropped from the record; a field the
     * payload lacks — or holds at a different value — is the disagreement that
     * still needs writing. A chunk absent from a complete listing has no payload
     * target left; its record goes, while the settings entry stays for the sweep
     * and orphan tools to classify.
     *
     * @param {string} collectionId The hydrated collection.
     * @param {Set<string>} presentHashes Hashes in that collection's complete listing.
     * @param {(hash: string) => object} payloadFor Payload metadata for a hash.
     */
    function rebuild(collectionId, presentHashes, payloadFor = () => ({})) {
        const id = String(collectionId);
        const settings = getSettings?.();
        if (!settings) return;
        const records = readRetryRecords(settings).filter(record => String(record.collectionId) === id);
        if (records.length === 0) return;

        let changed = false;
        for (const record of records) {
            const qkey = chunkMetadataKey(id, record.hash);
            const forgetHere = () => {
                changed = forget(record.hash, id) > 0 || changed;
            };

            if (!presentHashes.has(record.hash)) {
                forgetHere();
                continue;
            }
            const entry = readLegacy(record.hash);
            if (!entry || typeof entry !== 'object') {
                forgetHere();
                continue;
            }

            const payload = payloadFor(record.hash) || {};
            const neededByOthers = neededFieldsForOtherCollections(settings, record.hash, id);
            const resolved = {};
            const pendingFields = [];
            for (const field of record.fields) {
                if (!Object.prototype.hasOwnProperty.call(entry, field)) continue;
                const value = entry[field];
                const inPayload = Object.prototype.hasOwnProperty.call(payload, field)
                    && sameStoredValue(payload[field], value);
                if (!inPayload) {
                    pendingFields.push(field);
                } else if (!neededByOthers.has(field)) {
                    // The legacy entry is global per hash: keep the copy while
                    // another collection's pending repair still needs it.
                    resolved[field] = value;
                }
            }

            if (Object.keys(resolved).length > 0 && pruneLegacy(record.hash, resolved) > 0) {
                changed = true;
            }
            if (pendingFields.length === 0) {
                forgetHere();
                continue;
            }
            changed = updateRetryRecordFields(settings, id, record.hash, pendingFields) || changed;
            queue.set(qkey, newEntry(id, record.hash, pendingFields));
        }
        if (changed) persist();
        schedule();
    }

    /**
     * Drops a deleted collection's repairs. An in-memory entry can no longer
     * target a payload that is gone, and a durable record would only come back
     * on the next load.
     * @param {string} collectionId Deleted collection's key.
     */
    function forgetCollection(collectionId) {
        const id = String(collectionId || '');
        if (!id) return;
        for (const [qkey, entry] of [...queue]) {
            if (String(entry.collectionId) === id) queue.delete(qkey);
        }
        const settings = getSettings?.();
        if (settings && removeRetryRecordsMatching(settings, { collectionId: id }) > 0) {
            persist();
        }
        schedule();
    }

    /**
     * Drops the repairs for chunks that no longer exist. `collectionId` scopes
     * the purge; without one the repairs for those hashes go in every collection,
     * matching the store's pending-write cleanup for a hash-only delete.
     * @param {string|null} collectionId Collection in use, or null when none is.
     * @param {Iterable<string>} hashes Deleted chunk hashes.
     */
    function forgetChunks(collectionId, hashes) {
        const keys = new Set([...(hashes || [])].map(String));
        if (keys.size === 0) return;
        const collection = collectionId ? String(collectionId) : null;
        for (const [qkey, entry] of [...queue]) {
            if (!keys.has(entry.hash)) continue;
            if (collection !== null && String(entry.collectionId) !== collection) continue;
            queue.delete(qkey);
        }
        const settings = getSettings?.();
        if (settings && removeRetryRecordsMatching(settings, {
            collectionId: collection,
            hashes: keys,
        }) > 0) {
            persist();
        }
        schedule();
    }

    /**
     * The queue's observable state: the durable depth (what the storage-health
     * panel shows and what a reload rebuilds from), the repairs scheduled in this
     * session, the bound, and how many the cap dropped here.
     * @returns {{ pending: number, queued: number, cap: number, dropped: number }}
     */
    function state() {
        const settings = getSettings?.();
        return {
            pending: settings ? readRetryRecords(settings).length : 0,
            queued: queue.size,
            cap,
            dropped: droppedCount,
        };
    }

    function reset() {
        cancelTimer();
        queue.clear();
        inFlight.clear();
        droppedCount = 0;
    }

    return {
        enqueue,
        rebuild,
        drain,
        forgetCollection,
        forgetChunks,
        state,
        reset,
    };
}
