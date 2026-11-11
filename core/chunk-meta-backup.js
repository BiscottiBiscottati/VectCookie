/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA BACKUP
 * ============================================================================
 * The escape hatch ADR-0003 decision 6 promises before the one irreversible step:
 * a JSON snapshot of every chunk-metadata entry the sweep would consider — the
 * redundant, the patchable, the orphans and the skipped alike — with each entry's
 * hash and fields, so a settings copy that the sweep removes can be restored.
 *
 * The classification is not recomputed here. It is read from the sweep plan the
 * dry run produced, which is built from the same scan: the backup and the report
 * can therefore never disagree about what a hash is. An entry the plan did not
 * classify throws instead of being written out unmarked, because a silent,
 * incomplete backup is worse than a failed download.
 *
 * Pure: no DOM, no settings, no requests. The caller owns turning the document
 * into a file (core/chunk-meta-backup.js is imported by the host-free
 * composition in core/chunk-meta-dry-run.js).
 * ============================================================================
 */

import { LEGACY_CHUNK_META_PREFIX } from './chunk-meta-keys.js';

/** Identifies the file's shape to a human or a future restore tool. */
const CHUNK_META_BACKUP_FORMAT = 'vectfox-chunk-meta-backup';

/** Bumped only when the document shape changes incompatibly. */
const CHUNK_META_BACKUP_VERSION = 1;

/** Entries written between yields; small enough that no single task is long. */
const DEFAULT_BACKUP_CHUNK_SIZE = 500;

/**
 * Classifies every plan hash into the one bucket the sweep put it in, with the
 * collections that justify it. A hash shared by several collections merges into
 * one record: the backup is a snapshot of settings entries, and one settings
 * entry is one hash.
 * @param {object} plan Output of planChunkMetaSweep().
 * @returns {Map<string, { kind: string, reason?: string, collections: string[] }>}
 */
function classifyPlan(plan) {
    const byHash = new Map();

    for (const record of plan.redundant) {
        byHash.set(record.hash, { kind: 'redundant', collections: [...(record.collections || [])] });
    }
    for (const record of plan.patch) {
        const existing = byHash.get(record.hash);
        if (!existing) {
            byHash.set(record.hash, { kind: 'patch', collections: [record.registryKey] });
            continue;
        }
        if (!existing.collections.includes(record.registryKey)) {
            existing.collections.push(record.registryKey);
        }
    }
    for (const record of plan.orphan) {
        // An orphan belongs to no collection; the empty list is the fact, not a gap.
        byHash.set(record.hash, { kind: 'orphan', collections: [] });
    }
    for (const record of plan.skipped) {
        byHash.set(record.hash, {
            kind: 'skipped',
            reason: record.reason,
            collections: [...(record.collections || [])],
        });
    }

    return byHash;
}

/**
 * Builds the backup document for the settings entries the sweep considered.
 *
 * Every entry carries its fields as stored — including client-only ones such as
 * `summaries` — so the file is a restore source, not just an audit trail.
 *
 * @param {object} input
 * @param {Object<string, object>} [input.entries] Legacy settings entries: hash -> metadata.
 * @param {object} input.plan The sweep plan built from the same scan.
 * @param {Date|string|number} [input.now] Timestamp to stamp the document with.
 * @returns {{
 *   format: string,
 *   version: number,
 *   generatedAt: string,
 *   source: { store: string, keyPattern: string },
 *   trusted: boolean,
 *   untrustedReason: string|null,
 *   counts: {
 *     entries: number, redundant: number, patch: number, orphan: number, skipped: number,
 *     skippedByReason: { unverified: number, clientOnly: number },
 *     collections: number, chunksRead: number,
 *   },
 *   collections: Array<{
 *     registryKey: string, collectionId: string, status: string, chunkCount: number,
 *     redundant: number, patch: number, skipped: number,
 *   }>,
 *   entries: Array<{
 *     hash: string, kind: 'redundant'|'patch'|'orphan'|'skipped',
 *     reason?: string, collections: string[], fields: object,
 *   }>,
 * }}
 */
export function buildChunkMetaBackup({ entries = {}, plan, now = new Date() } = {}) {
    if (!plan || typeof plan !== 'object' || !plan.counts || !plan.coverage) {
        throw new TypeError(
            'a chunk-metadata backup needs the sweep plan — build it from the same scan the dry run used',
        );
    }

    const classified = classifyPlan(plan);
    const items = [];

    for (const [hash, fields] of Object.entries(entries)) {
        const classification = classified.get(hash);
        if (!classification) {
            throw new TypeError(
                `the sweep plan does not classify ${hash}; writing the backup now would leave an entry out`,
            );
        }
        classified.delete(hash);

        items.push({
            hash,
            kind: classification.kind,
            ...(classification.reason ? { reason: classification.reason } : {}),
            collections: classification.collections,
            fields: { ...fields },
        });
    }

    const [unmatched] = classified.keys();
    if (unmatched !== undefined) {
        throw new TypeError(
            `the sweep plan classifies ${unmatched}, which is not among the settings entries`,
        );
    }

    return {
        format: CHUNK_META_BACKUP_FORMAT,
        version: CHUNK_META_BACKUP_VERSION,
        generatedAt: new Date(now).toISOString(),
        // Say what the entries were: a restore needs the settings namespace, and
        // the file should be usable without this module's source.
        source: {
            store: 'extension_settings.vectfox',
            keyPattern: `${LEGACY_CHUNK_META_PREFIX}<hash>`,
        },
        trusted: plan.trusted,
        untrustedReason: plan.untrustedReason,
        counts: {
            entries: plan.entries,
            redundant: plan.counts.redundant,
            patch: plan.counts.patch,
            orphan: plan.counts.orphan,
            skipped: plan.counts.skipped,
            skippedByReason: { ...plan.skippedByReason },
            collections: plan.coverage.registered,
            chunksRead: plan.coverage.chunksRead,
        },
        collections: plan.perCollection.map(row => ({
            registryKey: row.registryKey,
            collectionId: row.collectionId,
            status: row.status,
            chunkCount: row.chunkCount,
            redundant: row.redundant,
            patch: row.patch,
            skipped: row.skipped,
        })),
        entries: items,
    };
}

/**
 * Yields to the host's event loop so a large write cannot hold the main thread
 * for its full duration. A macrotask, not a microtask: microtasks drain before
 * the browser can paint or handle input, which is exactly the freeze this exists
 * to prevent.
 * @returns {Promise<void>}
 */
function yieldToHost() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

/**
 * Serializes a backup document to JSON in fixed-size chunks, yielding to the
 * host between them. A library of 17,104 entries is roughly 9 MiB of JSON; a
 * single `JSON.stringify` of that size is a visible stall, so the file is written
 * entry by entry and the event loop gets a turn every `chunkSize` entries.
 *
 * The output is ordinary JSON: assembling the header and the entry array by hand
 * is what lets the entry list be produced incrementally.
 *
 * @param {object} document Output of buildChunkMetaBackup().
 * @param {object} [options]
 * @param {number} [options.chunkSize] Entries written between yields.
 * @param {() => Promise<void>} [options.yieldControl] Yield primitive; injectable
 *     so tests can count the yields instead of waiting on real timers.
 * @param {(progress: { done: number, total: number }) => void} [options.onProgress]
 * @returns {Promise<string>} The file's contents.
 */
export async function serializeChunkMetaBackup(document, {
    chunkSize = DEFAULT_BACKUP_CHUNK_SIZE,
    yieldControl = yieldToHost,
    onProgress,
} = {}) {
    const { entries = [], ...header } = document || {};
    if (!Array.isArray(entries)) {
        throw new TypeError('a chunk-metadata backup carries its entries as an array');
    }

    const size = Number.isFinite(chunkSize) && chunkSize > 0
        ? Math.floor(chunkSize)
        : DEFAULT_BACKUP_CHUNK_SIZE;

    const headerJson = JSON.stringify(header);
    const hasHeader = Object.keys(header).length > 0;
    const parts = [headerJson.slice(0, -1), hasHeader ? ',"entries":[' : '"entries":['];

    for (let index = 0; index < entries.length; index += size) {
        if (index > 0) parts.push(',');
        const end = Math.min(index + size, entries.length);
        parts.push(entries.slice(index, end).map(entry => JSON.stringify(entry)).join(','));
        await yieldControl();
        onProgress?.({ done: end, total: entries.length });
    }

    parts.push(']}');
    return parts.join('');
}
