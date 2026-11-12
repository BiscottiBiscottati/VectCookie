/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA RETRY RECORDS
 * ============================================================================
 * The durable half of ADR-0003 decision 5: when a chunk-payload write fails, the
 * edit is persisted to settings and one small record remembers that the payload
 * still owes it a write. The record holds the collection, the hash and the field
 * *names* — never the values, which already live in the settings entry — so a
 * stuck queue cannot re-inflate the settings blob the way the legacy metadata
 * keys did.
 *
 * The records are what makes retry survive a reload: the scheduler keeps an
 * in-memory queue (core/chunk-meta-retry-queue.js), but the records are its
 * source of truth. On the first use of a collection the scheduler compares each
 * record's fields with the hydrated payload, prunes the copies the payload
 * already holds, and queues the rest.
 *
 * The key deliberately stays outside the `vectfox_chunk_meta_` namespace: those
 * keys are legacy per-chunk entries that are listed, swept and garbage-collected
 * by hash, and a bookkeeping key inside it would be mistaken for a chunk.
 *
 * Dependency-free on purpose, so the storage-health measurement can count the
 * queue without importing the scheduler, the transport or the SillyTavern host.
 * ============================================================================
 */

import { chunkMetadataKey } from './chunk-meta-fields.js';

/** Settings key holding the pending payload-write records. */
export const PENDING_RETRY_KEY = 'vectfox_pending_chunk_meta_writes';

/** Upper bound on queued repairs; the oldest is dropped when it is reached. */
export const RETRY_QUEUE_CAP = 100;

/**
 * Field names as this queue stores them: non-empty strings, each once. Store
 * callers pass raw keys; normalization happens here so there is one definition.
 * @param {Iterable<string>} fields
 * @returns {string[]}
 */
export function normalizeRetryFields(fields) {
    if (!fields || typeof fields[Symbol.iterator] !== 'function') return [];
    return [...new Set([...fields].filter(field => typeof field === 'string' && field.length > 0))];
}

/** One stored record, normalized, or null when it addresses nothing. */
function normalizeRecord(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const collectionId = String(raw.collectionId ?? '');
    const hash = String(raw.hash ?? '');
    const fields = normalizeRetryFields(raw.fields);
    if (!collectionId || !hash || fields.length === 0) return null;
    return { collectionId, hash, fields };
}

/**
 * The pending records, normalized. Malformed or half-written values are ignored
 * rather than trusted: a bad record must never turn into a write to a payload.
 * @param {object|null|undefined} settings VectFox settings (`extension_settings.vectfox`).
 * @returns {Array<{ collectionId: string, hash: string, fields: string[] }>}
 */
export function readRetryRecords(settings) {
    const container = settings && typeof settings === 'object' ? settings[PENDING_RETRY_KEY] : null;
    if (!Array.isArray(container?.records)) return [];
    return container.records.map(normalizeRecord).filter(Boolean);
}

/**
 * Replaces the pending records. An empty queue removes the settings key, so a
 * healthy install carries no trace of this feature in its settings blob.
 * @param {object|null|undefined} settings VectFox settings.
 * @param {Array<object>} records Records to store.
 */
function writeRetryRecords(settings, records) {
    if (!settings || typeof settings !== 'object') return;
    const normalized = (records || []).map(normalizeRecord).filter(Boolean);
    if (normalized.length === 0) {
        delete settings[PENDING_RETRY_KEY];
        return;
    }
    settings[PENDING_RETRY_KEY] = { records: normalized };
}

/**
 * One record by identity.
 * @param {object|null|undefined} settings VectFox settings.
 * @param {string} collectionId Collection the failed write targeted.
 * @param {string|number} hash Chunk hash.
 * @returns {{ collectionId: string, hash: string, fields: string[] }|null}
 */
export function retryRecordFor(settings, collectionId, hash) {
    const id = chunkMetadataKey(String(collectionId ?? ''), String(hash ?? ''));
    return readRetryRecords(settings)
        .find(record => chunkMetadataKey(record.collectionId, record.hash) === id) || null;
}

/**
 * Records a failed payload write. An existing record for the same chunk keeps
 * its place in the queue and gains the newly refused fields; the oldest records
 * are dropped once `cap` is exceeded, and are returned so the caller can warn.
 *
 * Dropping a record loses only the automatic retry: the edit is still in the
 * settings entry, which is why the warning says so.
 *
 * @param {object|null|undefined} settings VectFox settings.
 * @param {{ collectionId: string, hash: string|number, fields: Iterable<string> }} record
 * @param {number} [cap] Queue bound.
 * @returns {{ records: Array<object>, dropped: Array<object> }}
 */
export function upsertRetryRecord(settings, { collectionId, hash, fields }, cap = RETRY_QUEUE_CAP) {
    const records = readRetryRecords(settings);
    const id = chunkMetadataKey(String(collectionId ?? ''), String(hash ?? ''));
    const nextFields = normalizeRetryFields(fields);
    const existing = records.find(record => chunkMetadataKey(record.collectionId, record.hash) === id);
    if (existing) {
        existing.fields = normalizeRetryFields([...existing.fields, ...nextFields]);
    } else if (nextFields.length > 0) {
        records.push({
            collectionId: String(collectionId ?? ''),
            hash: String(hash ?? ''),
            fields: nextFields,
        });
    }

    const dropped = [];
    while (records.length > cap && records.length > 0) {
        dropped.push(records.shift());
    }
    writeRetryRecords(settings, records);
    return { records, dropped };
}

/**
 * Removes every record matching a collection and/or a set of hashes. Both
 * filters are optional; with neither, the whole queue goes. This is the only
 * deletion path, so the scheduler's success, resolution and delete-path
 * cleanups cannot drift apart.
 * @param {object|null|undefined} settings VectFox settings.
 * @param {{ collectionId?: string|null, hashes?: Iterable<string|number>|null }} [filter]
 * @returns {number} How many records were removed.
 */
export function removeRetryRecordsMatching(settings, { collectionId = null, hashes = null } = {}) {
    const wantedCollection = collectionId === null || collectionId === undefined ? null : String(collectionId);
    const wantedHashes = hashes === null || hashes === undefined
        ? null
        : new Set([...hashes].map(String));
    const records = readRetryRecords(settings);
    const kept = records.filter(record => {
        if (wantedCollection !== null && String(record.collectionId) !== wantedCollection) return true;
        if (wantedHashes !== null && !wantedHashes.has(record.hash)) return true;
        return false;
    });
    const removed = records.length - kept.length;
    if (removed > 0) writeRetryRecords(settings, kept);
    return removed;
}

/**
 * Narrows one record to the fields still owed by the payload.
 * @param {object|null|undefined} settings VectFox settings.
 * @param {string} collectionId Collection the failed write targeted.
 * @param {string|number} hash Chunk hash.
 * @param {Iterable<string>} fields Fields that remain pending.
 * @returns {boolean} Whether the stored record changed.
 */
export function updateRetryRecordFields(settings, collectionId, hash, fields) {
    const records = readRetryRecords(settings);
    const id = chunkMetadataKey(String(collectionId ?? ''), String(hash ?? ''));
    const index = records.findIndex(record => chunkMetadataKey(record.collectionId, record.hash) === id);
    if (index === -1) return false;
    const next = normalizeRetryFields(fields);
    if (next.length === 0) {
        records.splice(index, 1);
        writeRetryRecords(settings, records);
        return true;
    }
    if (records[index].fields.length === next.length
        && records[index].fields.every(field => next.includes(field))) {
        return false;
    }
    records[index] = { ...records[index], fields: next };
    writeRetryRecords(settings, records);
    return true;
}
