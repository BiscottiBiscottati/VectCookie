/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA SWEEP REPORT
 * ============================================================================
 * Turns a sweep plan into the labels the Size Inspector renders: one row per
 * registered collection, a totals row, the coverage line, and the plain
 * sentence that an untrusted run refuses deletion (ADR-0003).
 *
 * Kept apart from core/chunk-meta-sweep.js so the planner and scan stay free of
 * presentation concerns and of any dependency on the Size Inspector's view
 * model; this module is the only one that formats. Pure: no DOM, no requests.
 * ============================================================================
 */

import {
    planChunkMetaSweep,
    scanChunkMetaCollections,
} from './chunk-meta-sweep.js';
import { formatCount } from './storage-health.js';
import { VIEW_STATUS } from './view-status.js';

/** Human label for each scan status. */
const STATUS_LABELS = {
    ok: 'read',
    'metadata-missing': 'no metadata',
    failed: 'failed',
    unscanned: 'not scanned',
};

/** A count with both the raw number and its thousands-grouped label. */
function countCell(count) {
    return { count, label: formatCount(count) };
}

/** How many collections ended a scan in the given status. */
function countStatus(plan, status) {
    return plan.perCollection.filter(row => row.status === status).length;
}

/**
 * Why deletion is refused, in the plainest words the case allows. The wording
 * names the count and the total so the report explains the refusal rather than
 * only announcing it.
 * @param {object} plan Output of planChunkMetaSweep().
 * @returns {string|null}
 */
function refusalFor(plan) {
    const status = plan.untrustedReason;
    if (status === null) return null;

    const total = plan.coverage.registered;
    if (status === 'empty-registry') {
        return 'Deletion is refused for this run — no registered collections were available to scan.';
    }

    const count = countStatus(plan, status);
    switch (status) {
        case 'unscanned':
            return `Deletion is refused for this run — ${count} of ${total} collections were not scanned.`;
        case 'failed':
            return `Deletion is refused for this run — ${count} of ${total} collections could not be read.`;
        case 'metadata-missing':
            return `Deletion is refused for this run — ${count} of ${total} collections returned no chunk metadata.`;
        default:
            return `Deletion is refused for this run — ${count} of ${total} collections could not be verified.`;
    }
}

/**
 * Explains skips the per-collection rows cannot attribute: an unverified entry
 * may live in a collection that was never read, so it belongs to no row.
 * @param {object} plan
 * @returns {string|null}
 */
function skippedNoteFor(plan) {
    const unverified = plan.skippedByReason.unverified;
    if (unverified === 0) return null;
    const noun = unverified === 1 ? 'entry' : 'entries';
    const pronoun = unverified === 1 ? 'it' : 'they';
    return `${unverified} skipped ${noun} could not be attributed to a collection: ${pronoun} may live in one that was not read.`;
}

/**
 * Builds the report view model: headline, coverage, refusal, totals and one row
 * per registered collection. Counts carry their labels so the renderer formats
 * nothing.
 * @param {object} plan Output of planChunkMetaSweep().
 * @returns {object} Report view model.
 */
export function buildSweepReportView(plan) {
    const { counts } = plan;
    return {
        status: VIEW_STATUS.MEASURED,
        trusted: plan.trusted,
        untrustedReason: plan.untrustedReason,
        headline: `${formatCount(plan.entries)} entries checked — `
            + `${counts.redundant} redundant, ${counts.patch} need patching, `
            + `${counts.orphan} ${counts.orphan === 1 ? 'orphan' : 'orphans'}, ${counts.skipped} skipped.`,
        coverageLabel: `${plan.coverage.scanned} of ${plan.coverage.registered} collections fully read`,
        refusal: refusalFor(plan),
        skippedNote: skippedNoteFor(plan),
        totals: {
            entries: countCell(plan.entries),
            chunks: countCell(plan.coverage.chunksRead),
            redundant: countCell(counts.redundant),
            patch: countCell(counts.patch),
            orphan: countCell(counts.orphan),
            skipped: countCell(counts.skipped),
        },
        collections: plan.perCollection.map(row => ({
            registryKey: row.registryKey,
            collectionId: row.collectionId,
            status: STATUS_LABELS[row.status] || row.status,
            chunkCount: countCell(row.chunkCount),
            redundant: countCell(row.redundant),
            patch: countCell(row.patch),
            skipped: countCell(row.skipped),
        })),
        orphanNote: 'An orphan exists in no registered collection — not merely in the one that is open.',
    };
}

/**
 * The dry run: scan every registered collection, classify every settings entry,
 * and return the plan plus its report. Reads only — it holds no transport of its
 * own and has no write path.
 *
 * @param {object} input
 * @param {Object<string, object>} [input.entries] Legacy settings entries: hash -> metadata.
 * @param {Array<object>} [input.collections] Every registered collection.
 * @param {(collection: any, options: { offset: number, limit: number }) => Promise<{ items?: object[] }>} [input.listChunks]
 * @param {Iterable<string>} [input.clientOnlyFields] Fields with no payload representation.
 * @param {number} [input.pageSize] Chunks requested per page.
 * @param {(progress: { done: number, total: number, collectionId: string }) => void} [input.onProgress]
 * @returns {Promise<{ plan: object, view: object }>}
 */
export async function runChunkMetaDryRun({
    entries = {},
    collections = [],
    listChunks,
    clientOnlyFields = [],
    pageSize = 500,
    onProgress,
} = {}) {
    const scans = await scanChunkMetaCollections({ collections, listChunks, pageSize, onProgress });
    const plan = planChunkMetaSweep({ entries, collections, scans, clientOnlyFields });
    return { plan, view: buildSweepReportView(plan) };
}
