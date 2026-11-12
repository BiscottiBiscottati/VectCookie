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

// ============================================================================
// SWEEP RUN REPORT
// ============================================================================

/**
 * A count with its noun in the singular or plural form.
 * @param {number} count
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
function nounCount(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * A stamp timestamp in a compact, unambiguous form. The stamp is support
 * evidence, so the zone is always named rather than assumed.
 * @param {string|null} iso
 * @returns {string|null}
 */
function stampTimeOf(iso) {
    if (!iso) return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * One line describing the last sweep's stamp, or an empty string when the
 * install has never swept. The Size Inspector shows it under the actions so a
 * migrated install is recognisable without running anything.
 * @param {object|null} stamp Normalized stamp from getSweepStamp().
 * @returns {string} Display line, or '' when there is no stamp.
 */
export function formatSweepStamp(stamp) {
    if (!stamp) return '';
    const when = stampTimeOf(stamp.finishedAt || stamp.startedAt);
    const counts = stamp.counts || {};
    const outcome = stamp.status === 'aborted'
        ? `stopped${when ? ` at ${when}` : ''}`
        : `complete${when ? ` at ${when}` : ''}`;
    const patched = Number(counts.patched) || 0;
    const deleted = Number(counts.deleted) || 0;
    const unsaved = stamp.persisted === false ? ' — not saved yet' : '';
    return `Last sweep ${outcome} (${stamp.mode || 'payload'} mode): `
        + `${nounCount(patched, 'entry', 'entries')} patched, `
        + `${nounCount(deleted, 'settings entry', 'settings entries')} removed${unsaved}.`;
}

/**
 * The report of one sweep run: what it moved, why it stopped or refused to
 * delete, and the stamp it left behind. Formatting lives here so the renderer
 * places text only.
 * @param {object} run Output of executeChunkMetaSweep().
 * @param {{ refusal?: string|null }} [options]
 * @param {string|null} [options.refusal] The scan's refusal sentence, when the
 *     run was untrusted and could not have deleted anyway.
 * @returns {object} View model.
 */
export function buildSweepRunView(run, { refusal = null } = {}) {
    const patched = run.counts.patched;
    const deleted = run.counts.deleted;
    const removed = nounCount(deleted, 'settings entry', 'settings entries');

    let headline;
    if (run.status === 'noop') {
        // Orphans and unverified entries are deliberately not the sweep's work,
        // so the claim is limited to what a sweep moves: redundant and patchable
        // settings entries.
        headline = 'Nothing to sweep — no settings entry is waiting to be patched or removed.';
    } else if (run.status === 'aborted') {
        headline = `Sweep stopped — ${nounCount(patched, 'entry', 'entries')} patched, `
            + `${removed} removed before it stopped.`;
    } else {
        headline = `Sweep complete — ${nounCount(patched, 'entry', 'entries')} patched, `
            + `${removed} removed.`;
    }

    return {
        status: VIEW_STATUS.MEASURED,
        outcome: run.status,
        trusted: run.trusted,
        headline,
        failure: run.error
            ? `The sweep stopped early: ${run.error}. Settings copies are only removed after `
                + 'their payload write succeeds, so every entry it removed was already in a '
                + 'payload; a re-run continues from where it stopped.'
            : null,
        saveWarning: run.saveError
            ? `The run finished, but the settings could not be saved: ${run.saveError}. The `
                + 'deletions and the stamp are in memory only until a settings save succeeds.'
            : null,
        refusal: run.deletionRefused
            ? (refusal || 'Deletion is refused for this run — no settings entry was removed.')
            : null,
        resumedNote: run.resumed
            ? `Continuing the interrupted run that started ${stampTimeOf(run.stamp.startedAt)} — `
                + 'work it finished was not repeated.'
            : null,
        counts: {
            entries: countCell(run.counts.entries || 0),
            patched: countCell(patched),
            deleted: countCell(deleted),
        },
        stampNote: formatSweepStamp(run.stamp),
    };
}
