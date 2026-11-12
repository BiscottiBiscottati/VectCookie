/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA TRANSFER VIEW
 * ============================================================================
 * The labels for the export report, kept out of the data module
 * (core/chunk-meta-transfer.js) and out of the renderer:
 *
 *   - the entry count, in words, so "1 entry has ... was" and "2 entries have
 *     ... were" are decided in one place;
 *   - the notice one collection's export shows when some settings entries had
 *     no chunk in that collection and were therefore not written to the file;
 *   - the same notice totalled across a bulk export.
 *
 * The wording names the collection, not orphanhood: only the Size Inspector's
 * dry run scans every registered collection, so an entry reported here may
 * still belong to another collection. Calling it an orphan would be a claim the
 * export cannot prove.
 * ============================================================================
 */

/** The closing sentence both notices share. */
const ORPHAN_POINTER = "The Size Inspector's dry run reports orphaned entries across every collection.";

/**
 * Counts as words. "1 entry has ... was" and "2 entries have ... were" are the
 * two shapes the notices need, so the plural agreement is decided here once.
 * @param {number} count
 * @returns {{ noun: string, have: string, was: string }}
 */
function agreement(count) {
    const one = count === 1;
    return {
        noun: one ? 'entry' : 'entries',
        have: one ? 'has' : 'have',
        was: one ? 'was' : 'were',
    };
}

/**
 * "1 chunk-metadata entry" / "3 chunk-metadata entries" — the count label the
 * notices and the bulk export's log line share.
 * @param {number} count
 * @returns {string}
 */
export function chunkMetaEntryCountLabel(count) {
    return `${count} chunk-metadata ${agreement(count).noun}`;
}

/**
 * How many settings entries an export could not carry, from its
 * `chunkMetaReport`. Zero for a missing report, so callers never branch on
 * shape.
 * @param {{ unmatchedSettingsEntries?: { count?: number } }|null|undefined} report
 * @returns {number}
 */
export function unmatchedChunkMetaCount(report) {
    return report?.unmatchedSettingsEntries?.count || 0;
}

/**
 * The warning line for an export whose settings held entries the collection no
 * longer contains, or null when there is nothing to report.
 * @param {{ unmatchedSettingsEntries?: { count?: number } }|null|undefined} report
 *     The export's `chunkMetaReport`.
 * @returns {string|null}
 */
export function exportChunkMetaNotice(report) {
    const count = unmatchedChunkMetaCount(report);
    if (count <= 0) return null;
    const { have, was } = agreement(count);
    return `${chunkMetaEntryCountLabel(count)} in settings ${have} no chunk in this ` +
        `collection and ${was} not exported. ${ORPHAN_POINTER}`;
}

/**
 * The warning line for a bulk export, where each collection file reports
 * separately. Null when nothing was left out.
 * @param {number} count Unmatched entries reported across the exported files —
 *     an occurrence count, not a distinct-entry count: the same settings hash
 *     can be unmatched in several of the exported collections.
 * @returns {string|null}
 */
export function exportChunkMetaTotalsNotice(count) {
    if (!(count > 0)) return null;
    const { have, was } = agreement(count);
    return `${chunkMetaEntryCountLabel(count)} ${have} no chunk in at least one ` +
        `exported collection and ${was} not exported. ${ORPHAN_POINTER}`;
}
