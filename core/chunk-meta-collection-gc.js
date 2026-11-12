/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA COLLECTION GARBAGE COLLECTION
 * ============================================================================
 * The garbage collection that follows a collection's deletion (or a chunk's
 * deletion) — ADR-0003 decision 6's other half. The sweep removes the settings
 * copies a payload supersedes; this removes the copies of chunks that no longer
 * exist, so a normal delete cannot create an orphan and the leak that grew the
 * settings object to 17,104 entries cannot recur.
 *
 * What a delete has to get right, and why the planner is separate from the
 * composition that scans:
 *
 *   - Chunk hashes are content-derived, so one `vectfox_chunk_meta_<hash>` key
 *     can serve several collections. Deleting chunk H from collection A must
 *     not remove A's settings entry while B still holds the same text: the
 *     per-field read would then lose whatever only settings held for B, and
 *     with it an edit the user never deleted. A hash still present in another
 *     registered collection is therefore kept.
 *   - Absence is only proof when the listing that shows it actually finished.
 *     A collection whose scan failed, or was never attempted, may hold any
 *     hash, so nothing is deleted on that run — the same "unverifiable is not
 *     deleted" contract as the sweep (ticket 05/06).
 *   - Only the deletion's own chunks are candidates. An entry whose hash was in
 *     no scanned collection before this delete is somebody else's orphan; the
 *     dry run reports it and the counted orphan deletion may remove it. This
 *     action removes "exactly that collection's chunk metadata".
 *   - An entry holding client-only metadata (dual-vector `summaries`) IS
 *     collectable here, unlike in the sweep: the sweep keeps such an entry
 *     because its chunk is alive and no payload can carry the field, whereas
 *     this deletion has just removed the chunk. When the hash is still shared,
 *     the shared rule keeps it as usual.
 *
 * Executor: one settings save for the whole run, and none at all when nothing
 * was removed. A failed removal stops the run (counted), and a failed save is
 * reported beside the counts rather than thrown — what was removed is gone from
 * memory either way.
 *
 * Host-free: the settings deletion, the persistence and the plan's sources are
 * injected. The composition that lists collections and owns the settings object
 * is `deleteChunkMetadataForCollection` in core/collection-metadata.js.
 * ============================================================================
 */

import { collectionKeyOf } from './chunk-meta-fields.js';

/**
 * Scan statuses whose hash listing provably reached the end, so absence in them
 * is proof. The composition's scan emits exactly `ok` for a complete listing and
 * `failed` otherwise; anything else counts as unread.
 */
const PROVEN_SCAN_STATUSES = new Set(['ok']);

/** The hash set of one scan. */
function hashesOf(scan) {
    return new Set(scan?.hashes || []);
}

/**
 * Whether every registered collection after the deleted one was read completely.
 * @param {Array<{status: string}>} rows
 * @returns {string|null} The status of the first row that is not proof, or null.
 */
function untrustedReasonFor(rows) {
    const unreadable = rows.find(row => !PROVEN_SCAN_STATUSES.has(row.status));
    return unreadable ? unreadable.status : null;
}

/**
 * Classifies the legacy settings entries a deletion covers. Pure: it returns a
 * plan and mutates neither input.
 *
 * @param {object} input
 * @param {Object<string, object>} [input.entries] Legacy settings entries: hash -> metadata.
 * @param {Iterable<string>} [input.deletedHashes]
 *     The hashes the deletion provably covers: the deleted collection's chunks
 *     (or the chunks deleted from it), read before they disappeared.
 * @param {Array<object>} [input.collections] The *other* registered collections:
 *     `{ registryKey, collectionId }`. The deleted one is not among them.
 * @param {Array<object>} [input.scans] One scan per other collection:
 *     `{ registryKey, collectionId, status: 'ok'|'failed'|'unscanned', hashes, error }`,
 *     where `hashes` is the collection's complete hash set (a Set or an array).
 * @returns {{
 *   trusted: boolean,
 *   untrustedReason: string|null,
 *   counts: { candidates: number, deletable: number, shared: number, unverified: number },
 *   deletable: string[],
 *   kept: Array<{ hash: string, reason: 'shared'|'unverified' }>,
 *   collections: Array<{ registryKey: string, collectionId: string, status: string, chunkCount: number }>,
 * }}
 */
export function planCollectionChunkMetaGc({
    entries = {},
    deletedHashes = [],
    collections = [],
    scans = [],
} = {}) {
    const scansByKey = new Map();
    for (const scan of scans) {
        const key = collectionKeyOf(scan);
        if (key) scansByKey.set(key, scan);
    }

    // One row per other registered collection. A registered collection without a
    // scan was never attempted, and could hold any hash.
    const rows = [];
    const seen = new Set();
    for (const collection of collections) {
        const registryKey = collectionKeyOf(collection);
        if (!registryKey || seen.has(registryKey)) continue;
        seen.add(registryKey);
        const scan = scansByKey.get(registryKey) || null;
        rows.push({
            registryKey,
            collectionId: String(collection?.collectionId || registryKey),
            status: scan?.status || 'unscanned',
            hashes: hashesOf(scan),
        });
    }

    const untrustedReason = untrustedReasonFor(rows);
    const trusted = untrustedReason === null;
    const completable = rows.filter(row => PROVEN_SCAN_STATUSES.has(row.status));

    const plan = {
        trusted,
        untrustedReason,
        counts: { candidates: 0, deletable: 0, shared: 0, unverified: 0 },
        deletable: [],
        kept: [],
        collections: rows.map(row => ({
            registryKey: row.registryKey,
            collectionId: row.collectionId,
            status: row.status,
            chunkCount: row.hashes.size,
        })),
    };

    const covered = new Set([...deletedHashes].map(String));
    for (const hash of Object.keys(entries || {})) {
        if (!covered.has(hash)) continue;
        plan.counts.candidates += 1;

        // A still-existing copy of the same text is where the value lives after
        // the deletion; the settings entry keeps serving it.
        if (completable.some(row => row.hashes.has(hash))) {
            plan.kept.push({ hash, reason: 'shared' });
            plan.counts.shared += 1;
            continue;
        }

        // An unreadable collection may hold the hash, so the entry cannot go.
        if (!trusted) {
            plan.kept.push({ hash, reason: 'unverified' });
            plan.counts.unverified += 1;
            continue;
        }

        plan.deletable.push(hash);
        plan.counts.deletable += 1;
    }

    return plan;
}

/**
 * Executes a plan: removes exactly the entries it names, with one settings save
 * after them. See the module header for the safety rules.
 *
 * @param {object} options
 * @param {object} options.plan Output of planCollectionChunkMetaGc().
 * @param {(hash: string) => boolean|void} [options.deleteEntry]
 *     Removes one legacy settings entry without saving; false when there was
 *     nothing to remove.
 * @param {() => void} [options.persistSettings] Persists the settings, once.
 * @param {(progress: { done: number, total: number, deleted: number }) => void} [options.onProgress]
 * @returns {Promise<{
 *   status: 'refused'|'empty'|'complete'|'aborted',
 *   trusted: boolean,
 *   counts: { deleted: number, skipped: number },
 *   deleted: string[],
 *   error: string|null,
 *   saveError: string|null,
 * }>}
 */
export async function executeCollectionChunkMetaGc({
    plan,
    deleteEntry = () => false,
    persistSettings = () => {},
    onProgress,
} = {}) {
    if (!plan || typeof plan !== 'object' || !plan.counts) {
        throw new TypeError('a collection chunk-metadata GC needs the plan from a completed scan');
    }

    const trusted = plan.trusted === true;
    const hashes = trusted
        ? (Array.isArray(plan.deletable) ? plan.deletable : [])
            .map(hash => String(hash))
            .filter(hash => hash.length > 0)
        : [];
    const result = {
        trusted,
        counts: { deleted: 0, skipped: 0 },
        deleted: [],
        error: null,
        saveError: null,
    };

    if (!trusted) return { ...result, status: 'refused' };
    if (hashes.length === 0) return { ...result, status: 'empty' };

    let failure = null;
    let done = 0;
    for (const hash of hashes) {
        try {
            if (deleteEntry(hash) === false) {
                result.counts.skipped += 1;
            } else {
                result.counts.deleted += 1;
                result.deleted.push(hash);
            }
        } catch (error) {
            failure = error;
            break;
        }
        done += 1;
        onProgress?.({ done, total: hashes.length, deleted: result.counts.deleted });
    }

    // What was removed is in memory either way; a failed save must not read as
    // "nothing was deleted". It is reported beside the counts instead.
    let saveError = null;
    if (result.counts.deleted > 0) {
        try {
            persistSettings?.();
        } catch (error) {
            saveError = error?.message || String(error);
        }
    }

    return {
        ...result,
        status: failure ? 'aborted' : 'complete',
        error: failure ? (failure.message || String(failure)) : null,
        saveError,
    };
}
