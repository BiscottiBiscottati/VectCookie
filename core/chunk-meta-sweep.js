/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA SWEEP
 * ============================================================================
 * The migration planner behind ADR-0003 decision 6, and the read-only scan that
 * feeds it. This module is deliberately host-free: it takes the settings
 * entries, the registered collections and a `listChunks` function, and returns
 * a plan. Nothing here writes, saves or patches.
 *
 * The rules, straight from the feature spec:
 *
 *   - redundant  a scanned collection's payload already holds every field, so
 *                the settings copy can go
 *   - patch      a scanned collection's payload lacks fields; copy them, then
 *                delete on the sweep
 *   - orphan     absent from EVERY registered collection — never merely absent
 *                from the one that is open, because chunk hashes are derived
 *                from content and one hash can live in several collections
 *   - skipped    untouched: either the collection holding it could not be read,
 *                or it holds a client-only field (e.g. summaries) the payload
 *                can never carry
 *
 * An untrusted run — any registered collection failed, its listing was
 * truncated, or it was never attempted, or a listing returned chunks with no
 * payload metadata at all — may still propose patches, but must delete nothing.
 * `deletable` is therefore empty on an untrusted run; `redundant` still reports
 * what the collections that *were* read proved. That is the same "unverifiable
 * is not deleted" contract the collection outage guards already follow.
 *
 * Collections are identified by registry key (`backend:collectionId`), not by
 * bare id: the same collection id can exist on two backends, and two entries
 * must never be collapsed into one scan or one report row.
 * ============================================================================
 */

import {
    carriesClientOnlyMetadata,
    chunkHashOf,
    chunkMetadataFromPayload,
    missingPayloadFields,
} from './chunk-meta-fields.js';
import { listAllChunkItems } from './chunk-paging.js';

/** Scan statuses whose chunk listing was complete, so absence in it is provable. */
const COMPLETE_SCAN_STATUSES = new Set(['ok', 'metadata-missing']);

/** A collection's identity: registry key when known, bare id otherwise. */
function collectionKeyOf(collection) {
    return String(collection?.registryKey || collection?.collectionId || '');
}

/** A collection's display id. */
function collectionIdOf(collection) {
    return String(collection?.collectionId || collection?.registryKey || '');
}

/** Chunk index for a scan: hash -> payload metadata. */
function chunkIndexOf(chunks) {
    if (chunks === undefined || chunks === null) return new Map();
    if (!(chunks instanceof Map)) {
        // Silent coercion would make every entry look absent — and an absent
        // entry is a deletion candidate. Fail loudly instead.
        throw new TypeError('a scan must carry its chunks as a Map of hash -> metadata');
    }
    return chunks;
}

/** A scan result with its chunk index, identity and status resolved. */
function normalizeScan(rawScan) {
    const registryKey = collectionKeyOf(rawScan);
    const chunks = chunkIndexOf(rawScan?.chunks);
    return {
        registryKey,
        collectionId: String(rawScan?.collectionId || registryKey),
        status: rawScan?.status || 'failed',
        error: rawScan?.error ?? null,
        chunks,
        chunkCount: chunks.size,
    };
}

/**
 * Why a run may not delete anything, if it may not. The value is either
 * `empty-registry` or the scan status that spoiled the run, so the report can
 * count the affected collections without translating between two vocabularies.
 * Ordered so the report names the most fundamental problem: nothing registered,
 * then a collection never read, then one that failed or returned a truncated
 * listing, then one whose listings carried no metadata.
 * @param {Array<object>} rows Per-registered-collection rows.
 * @returns {string|null}
 */
function untrustedReasonFor(rows) {
    if (rows.length === 0) return 'empty-registry';
    for (const status of ['unscanned', 'failed', 'metadata-missing']) {
        if (rows.some(row => row.status === status)) return status;
    }
    return null;
}

/**
 * Classifies every settings chunk-metadata entry against a completed scan. Pure:
 * it returns a plan and mutates neither input.
 *
 * @param {object} input
 * @param {Object<string, object>} [input.entries] Legacy settings entries: hash -> metadata.
 * @param {Array<object>} [input.collections] Every registered collection:
 *     `{ registryKey, collectionId }` (the loader's read-only listing).
 * @param {Array<object>} [input.scans] Per-collection scan results:
 *     `{ registryKey, collectionId, status: 'ok'|'metadata-missing'|'failed', chunks, error }`,
 *     where `chunks` is a hash -> payload-metadata Map.
 * @param {Iterable<string>} [input.clientOnlyFields] Fields with no payload representation.
 * @returns {{
 *   trusted: boolean,
 *   untrustedReason: string|null,
 *   entries: number,
 *   counts: { redundant: number, patch: number, orphan: number, skipped: number },
 *   skippedByReason: { unverified: number, clientOnly: number },
 *   redundant: Array<{ hash: string, collections: string[] }>,
 *   deletable: Array<{ hash: string, collections: string[] }>,
 *   patch: Array<{ hash: string, registryKey: string, collectionId: string, fields: object }>,
 *   orphan: Array<{ hash: string }>,
 *   skipped: Array<{ hash: string, reason: 'unverified'|'client-only', collections: string[] }>,
 *   perCollection: Array<{
 *     registryKey: string, collectionId: string, status: string,
 *     chunkCount: number, redundant: number, patch: number, skipped: number,
 *   }>,
 *   coverage: { registered: number, scanned: number, chunksRead: number },
 * }}
 */
export function planChunkMetaSweep({
    entries = {},
    collections = [],
    scans = [],
    clientOnlyFields = [],
} = {}) {
    const scansByKey = new Map();
    for (const rawScan of scans) {
        const normalized = normalizeScan(rawScan);
        if (normalized.registryKey) scansByKey.set(normalized.registryKey, normalized);
    }

    const registered = [];
    const seenKeys = new Set();
    for (const collection of collections) {
        const registryKey = collectionKeyOf(collection);
        if (!registryKey || seenKeys.has(registryKey)) continue;
        seenKeys.add(registryKey);
        registered.push({ registryKey, collectionId: collectionIdOf(collection) });
    }

    // One row per registered collection; a registered collection without a scan
    // result was never attempted and counts as untrusted.
    const rows = registered.map(({ registryKey, collectionId }) => {
        const scan = scansByKey.get(registryKey) || null;
        return {
            registryKey,
            collectionId,
            status: scan?.status || 'unscanned',
            chunkCount: scan?.chunkCount || 0,
            chunks: scan?.chunks || null,
            redundant: 0,
            patch: 0,
            skipped: 0,
        };
    });

    // A hash may live in an incomplete/failed/unscanned collection; until every
    // registered collection has a complete listing, absence proves nothing.
    const unverifiedKeys = rows
        .filter(row => !COMPLETE_SCAN_STATUSES.has(row.status))
        .map(row => row.registryKey);

    const plan = {
        trusted: false,
        untrustedReason: untrustedReasonFor(rows),
        entries: Object.keys(entries).length,
        counts: { redundant: 0, patch: 0, orphan: 0, skipped: 0 },
        skippedByReason: { unverified: 0, clientOnly: 0 },
        redundant: [],
        deletable: [],
        patch: [],
        orphan: [],
        skipped: [],
        perCollection: [],
        coverage: {
            registered: rows.length,
            scanned: rows.filter(row => row.status === 'ok').length,
            chunksRead: rows.reduce((total, row) => total + row.chunkCount, 0),
        },
    };
    plan.trusted = plan.untrustedReason === null;

    for (const [hash, entry] of Object.entries(entries || {})) {
        // Containment needs a complete listing: a failed or unattempted scan
        // cannot say whether it holds this hash.
        const containing = rows.filter(
            row => COMPLETE_SCAN_STATUSES.has(row.status) && row.chunks?.has(hash),
        );

        if (containing.length > 0) {
            if (carriesClientOnlyMetadata(entry, clientOnlyFields)) {
                plan.skipped.push({
                    hash,
                    reason: 'client-only',
                    collections: containing.map(row => row.registryKey),
                });
                for (const row of containing) row.skipped += 1;
                continue;
            }

            let patchRecords = 0;
            for (const row of containing) {
                const fields = missingPayloadFields(entry, row.chunks.get(hash), clientOnlyFields);
                if (Object.keys(fields).length === 0) continue;
                plan.patch.push({
                    hash,
                    registryKey: row.registryKey,
                    collectionId: row.collectionId,
                    fields,
                });
                row.patch += 1;
                patchRecords += 1;
            }

            if (patchRecords === 0) {
                plan.redundant.push({
                    hash,
                    collections: containing.map(row => row.registryKey),
                });
                for (const row of containing) row.redundant += 1;
            }
            continue;
        }

        if (unverifiedKeys.length > 0 || rows.length === 0) {
            // It may live in a collection that was not read. Absence there is not
            // proof: leave it alone rather than calling it an orphan. With an
            // empty registry nothing was read at all, so no absence is proven.
            plan.skipped.push({ hash, reason: 'unverified', collections: unverifiedKeys });
            continue;
        }

        plan.orphan.push({ hash });
    }

    // Totals are entry counts (one per hash); a per-collection row counts the
    // entry once in every collection that holds it, so row sums can exceed the
    // totals when a content-derived hash is shared. `patch` totals the entries
    // needing any patch, while `plan.patch` lists one work item per collection.
    // `deletable` is the only delete list and is empty unless the run is trusted.
    plan.counts.redundant = plan.redundant.length;
    plan.counts.patch = new Set(plan.patch.map(record => record.hash)).size;
    plan.counts.orphan = plan.orphan.length;
    plan.counts.skipped = plan.skipped.length;
    plan.skippedByReason = {
        unverified: plan.skipped.filter(record => record.reason === 'unverified').length,
        clientOnly: plan.skipped.filter(record => record.reason === 'client-only').length,
    };
    plan.deletable = plan.trusted
        ? plan.redundant.map(record => ({ hash: record.hash, collections: [...record.collections] }))
        : [];
    plan.perCollection = rows.map(row => ({
        registryKey: row.registryKey,
        collectionId: row.collectionId,
        status: row.status,
        chunkCount: row.chunkCount,
        redundant: row.redundant,
        patch: row.patch,
        skipped: row.skipped,
    }));

    return plan;
}

// ============================================================================
// SCAN
// ============================================================================

/**
 * Reads every chunk of every registered collection, one collection at a time.
 * A collection that cannot be listed — or whose listing ends before the
 * backend's reported total — becomes a `failed` scan instead of aborting the
 * run: the report can then say exactly what was and was not read, and a
 * truncated listing can never be mistaken for proof that a chunk is gone. A
 * listing that returns chunks but no payload metadata at all is marked
 * `metadata-missing`: the native hashes-only fallback looks identical, so its
 * absence of fields is not proof that a settings entry is redundant.
 *
 * @param {object} input
 * @param {Array<object>} [input.collections] Every registered collection.
 * @param {(collection: any, options: { offset: number, limit: number }) => Promise<{ items?: object[], total?: number, hasMore?: boolean }>} [input.listChunks]
 * @param {number} [input.pageSize] Chunks requested per page.
 * @param {(progress: { done: number, total: number, collectionId: string }) => void} [input.onProgress]
 * @returns {Promise<Array<{
 *   registryKey: string, collectionId: string, status: string,
 *   chunks: Map<string, object>, chunkCount: number, error?: string,
 * }>>}
 */
export async function scanChunkMetaCollections({
    collections = [],
    listChunks,
    pageSize = 500,
    onProgress,
} = {}) {
    const scans = [];
    const total = collections.length;

    for (let index = 0; index < total; index++) {
        const collection = collections[index];
        const registryKey = collectionKeyOf(collection);
        const collectionId = collectionIdOf(collection);
        onProgress?.({ done: index, total, collectionId, registryKey });

        try {
            const { items, complete, total: reportedTotal } = await listAllChunkItems(
                listChunks,
                collection,
                { pageSize },
            );
            if (!complete) {
                const received = reportedTotal === null ? 'an unknown number' : `${items.length} of ${reportedTotal}`;
                throw new Error(`listing ended after ${received} chunks`);
            }
            const chunks = new Map();
            let withMetadata = 0;
            for (const item of items) {
                const hash = chunkHashOf(item);
                if (hash === null) continue;
                const metadata = chunkMetadataFromPayload(item?.metadata);
                if (Object.keys(metadata).length > 0) withMetadata += 1;
                chunks.set(hash, metadata);
            }
            scans.push({
                registryKey,
                collectionId,
                status: items.length > 0 && withMetadata === 0 ? 'metadata-missing' : 'ok',
                chunks,
                chunkCount: chunks.size,
            });
        } catch (error) {
            scans.push({
                registryKey,
                collectionId,
                status: 'failed',
                chunks: new Map(),
                chunkCount: 0,
                error: error?.message || String(error),
            });
        }

        onProgress?.({ done: index + 1, total, collectionId, registryKey });
    }

    return scans;
}
