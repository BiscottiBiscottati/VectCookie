/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA BACKUP VIEW
 * ============================================================================
 * The view model for the backup download: its filename, the entry-count label,
 * and the report of the very scan the file was built from. Formatting lives
 * here, not in the renderer and not in core/chunk-meta-backup.js, so the
 * document module stays data-only and the panel only places text — the same
 * split core/chunk-meta-sweep-report.js applies to the dry run.
 *
 * Pure: no DOM, no settings, no requests.
 * ============================================================================
 */

import { formatEntryCount } from './storage-health.js';

/**
 * The download's view model: the filename, its contents, and the entry count as
 * the panel should show it.
 * @param {object} document Output of buildChunkMetaBackup().
 * @param {string} text Serialized document (serializeChunkMetaBackup()).
 * @returns {{ filename: string, text: string, entries: { count: number, label: string } }}
 */
export function buildBackupDownload(document, text) {
    const count = document.counts.entries;
    return {
        filename: backupFilename(document.generatedAt),
        text,
        entries: { count, label: formatEntryCount(count) },
    };
}

/**
 * A filename carrying the document's own timestamp, so two downloads in one
 * session do not overwrite each other.
 * @param {string} generatedAt ISO timestamp from the backup document.
 * @returns {string}
 */
export function backupFilename(generatedAt) {
    return `vectfox-chunk-meta-backup-${String(generatedAt).replace(/[:.]/g, '-')}.json`;
}
