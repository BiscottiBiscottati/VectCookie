/**
 * ============================================================================
 * USAGE EXPORT
 * ============================================================================
 * Builds the versioned JSON file the Usage tab downloads.
 *
 * Export is a projection, not a dump: only the documented usage fields leave
 * the extension. That is the privacy guarantee — prompt text, request bodies
 * and credentials have no field in the output, so a future record field cannot
 * leak through the export by accident.
 *
 * The shape is owned here; the panel renders the button and the download.
 * ============================================================================
 */

import { normalizeUsageConfiguration } from './usage-configuration.js';
import { createUsageAccumulator, createUsageArchive } from './usage-stats.js';

export const USAGE_EXPORT_VERSION = 1;
export const USAGE_EXPORT_KIND = 'vectfox-usage-export';

/**
 * The record fields the export publishes. Anything else on a record is not
 * part of the export, so prompt text and credentials cannot ride along.
 */
const EXPORT_RECORD_FIELDS = [
    'recordId',
    'timestamp',
    'chatId',
    'runId',
    'origin',
    'featureLabel',
    'configuration',
    'provider',
    'model',
    'responseId',
    'stream',
    'status',
    'httpStatus',
    'latencyMs',
    'messageCount',
    'promptTokens',
    'hitTokens',
    'missTokens',
    'cacheWriteTokens',
    'completionTokens',
    'reasoningTokens',
    'totalTokens',
    'cost',
    'cacheDiscount',
    'estimatedPromptTokens',
    'usageSource',
    'sharedPrefixTokens',
    'possiblePrefixBreaker',
];

/**
 * Builds the export object from one ledger snapshot. The caller stringifies
 * and downloads it.
 *
 * The snapshot is already normalized by its owner (`UsageLedger`), so this
 * module publishes it without re-deriving shapes. The price table in force at
 * export time travels with the file; archived and all-time counters were
 * accumulated with the table in force when each row was evicted, so a later
 * price edit means the current table alone cannot explain older counters.
 *
 * @param {object} [options]
 * @param {string|null} [options.chatId] Chat the records belong to.
 * @param {number} [options.now] Export time, injected for tests.
 * @param {object|null} [options.snapshot] Output of `UsageLedger.exportSnapshotFor`.
 * @param {object|null} [options.prices] Price table in force at export time.
 * @returns {object}
 */
export function buildUsageExport({
    chatId = null,
    now = Date.now(),
    snapshot = null,
    prices = null,
} = {}) {
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const allTime = source.allTime && typeof source.allTime === 'object' ? source.allTime : null;

    return {
        version: USAGE_EXPORT_VERSION,
        kind: USAGE_EXPORT_KIND,
        exportedAt: toIsoString(now),
        chatId: typeof chatId === 'string' && chatId ? chatId : null,
        currentPrices: prices && typeof prices === 'object' ? prices : null,
        records: (Array.isArray(source.records) ? source.records : [])
            .filter((record) => record && typeof record === 'object')
            .map(projectRecord),
        runs: (Array.isArray(source.runs) ? source.runs : []).map(projectRun).filter(Boolean),
        currentRunId: typeof source.currentRunId === 'string' && source.currentRunId
            ? source.currentRunId
            : null,
        aggregates: {
            archived: source.archived && typeof source.archived === 'object'
                ? source.archived
                : createUsageArchive(),
            retention: source.retention && typeof source.retention === 'object'
                ? source.retention
                : { limit: 0, retained: 0, total: 0 },
            allTime: {
                totals: allTime?.totals && typeof allTime.totals === 'object'
                    ? allTime.totals
                    : createUsageAccumulator(),
                chats: allTime?.buckets && typeof allTime.buckets === 'object'
                    ? allTime.buckets
                    : {},
            },
        },
    };
}

/**
 * A download name that is safe on every platform and says which chat the file
 * came from.
 *
 * @param {object} [options]
 * @param {string|null} [options.chatId]
 * @param {number} [options.now]
 * @returns {string}
 */
export function usageExportFileName({ chatId = null, now = Date.now() } = {}) {
    const stamp = exportStamp(now);
    const slug = chatSlug(chatId);
    return `vectfox-usage-${slug ? `${slug}-` : ''}${stamp}.json`;
}

function projectRecord(record) {
    const projected = {};
    for (const field of EXPORT_RECORD_FIELDS) {
        if (!(field in record)) continue;
        projected[field] = field === 'configuration'
            ? normalizeUsageConfiguration(record[field])
            : record[field];
    }
    return projected;
}

function projectRun(run) {
    if (!run || typeof run !== 'object' || typeof run.runId !== 'string' || !run.runId) return null;
    return {
        runId: run.runId,
        label: typeof run.label === 'string' ? run.label : run.runId,
        startedAt: Number.isFinite(run.startedAt) ? run.startedAt : null,
        endedAt: Number.isFinite(run.endedAt) ? run.endedAt : null,
    };
}


function toIsoString(value) {
    const timestamp = Number.isFinite(value) ? value : Date.now();
    return new Date(timestamp).toISOString();
}

function exportStamp(value) {
    const date = new Date(Number.isFinite(value) ? value : Date.now());
    const pad = (part) => String(part).padStart(2, '0');
    return [
        date.getUTCFullYear(),
        pad(date.getUTCMonth() + 1),
        pad(date.getUTCDate()),
        '-',
        pad(date.getUTCHours()),
        pad(date.getUTCMinutes()),
        pad(date.getUTCSeconds()),
    ].join('');
}

function chatSlug(chatId) {
    if (typeof chatId !== 'string' || !chatId) return '';
    return chatId
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 80);
}
