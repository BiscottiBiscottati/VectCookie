/**
 * ============================================================================
 * USAGE CONFIGURATION SNAPSHOT
 * ============================================================================
 * One owner for the ghosting snapshot a usage record carries. The watcher
 * reads it from settings and the ledger normalizes it when it comes back from
 * chat metadata; both shapes pass through this function.
 * ============================================================================
 */

/**
 * Coerces a ghosting configuration snapshot into the persisted shape. Unknown
 * or missing fields stay null, so a row captured before a field existed does
 * not invent a batch size.
 *
 * @param {object|null} value
 * @returns {{ghostEnabled: boolean, ghostBatchSize: number|null, ghostKeepRecent: number|null}|null}
 */
export function normalizeUsageConfiguration(value) {
    if (!value || typeof value !== 'object') return null;
    return {
        ghostEnabled: !!value.ghostEnabled,
        ghostBatchSize: Number.isFinite(value.ghostBatchSize) ? value.ghostBatchSize : null,
        ghostKeepRecent: Number.isFinite(value.ghostKeepRecent) ? value.ghostKeepRecent : null,
    };
}
