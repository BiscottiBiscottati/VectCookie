/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA STORAGE ACTIONS (dry run and backup)
 * ============================================================================
 * Composes the four things the staged migration's read-only actions need — the
 * live settings, the registered collections, the legacy settings entries, and the
 * plugin transport — into the scan plus plan in core/chunk-meta-sweep-report.js.
 *
 * Both actions run the one scan implementation. That is the ticket-04 guarantee:
 * the backup's contents come from the dry run's scan, not from a second,
 * separately-written reading of the same sources. A backup necessarily scans
 * again when it is requested — it has to be as fresh as possible before deletion
 * — so it also hands back the report of the scan it used, and the panel shows
 * that report beside the file. What the user sees after downloading is therefore
 * exactly what the file holds.
 *
 * Host-free on purpose: the dependencies are injected by the wiring layer
 * (ui/database-browser.js), so this seam can be tested without resolving
 * SillyTavern modules, and the scan cannot reach a write path it was not given.
 * Nothing here saves settings, patches a payload or registers a collection.
 * ============================================================================
 */

import { buildChunkMetaBackup, serializeChunkMetaBackup } from './chunk-meta-backup.js';
import { buildBackupDownload } from './chunk-meta-backup-view.js';
import { runChunkMetaDryRun } from './chunk-meta-sweep-report.js';
import { VIEW_STATUS } from './view-status.js';

/**
 * A read-only action that cannot run at all — reported as such rather than as an
 * empty trusted plan, so the UI never implies "nothing to do".
 * @param {string} reason
 * @returns {{ status: 'unavailable', reason: string }}
 */
function unavailable(reason) {
    return { status: VIEW_STATUS.UNAVAILABLE, reason };
}

/**
 * The one scan both actions share: gate on the plugin, list the registered
 * collections and the legacy entries, then scan and plan. Returns either an
 * unavailable view or a measured run carrying everything both actions need.
 *
 * @param {object} [deps]
 * @param {function({ getSettings: function }): object} [deps.createTransport]
 *     Builds the plugin transport (`isAvailable`, `listChunks`, `patchMetadata`).
 *     Both actions only ever call `isAvailable` and `listChunks`.
 * @param {function(object): Array<{ registryKey: string, collectionId: string }>} [deps.listCollections]
 *     The registered collections for the given settings.
 * @param {function(): Object<string, object>} [deps.listEntries]
 *     The legacy settings entries: hash -> metadata.
 * @param {Iterable<string>} [deps.clientOnlyFields] Fields with no payload representation.
 * @returns {function(object=): Promise<object>} The scan entry point.
 */
function createStorageScan({
    createTransport,
    listCollections,
    listEntries,
    clientOnlyFields = [],
} = {}) {
    return async function scanStorage({ getSettings, pageSize = 500, onProgress } = {}) {
        if (typeof createTransport !== 'function'
            || typeof listCollections !== 'function'
            || typeof listEntries !== 'function') {
            return unavailable('The storage migration tools are not configured in this build.');
        }

        const settings = getSettings?.();
        if (!settings || typeof settings !== 'object') {
            return unavailable('VectFox settings are not available yet — nothing was scanned.');
        }

        const transport = createTransport({ getSettings });
        if (!transport?.isAvailable?.()) {
            return unavailable(
                'The Similharity plugin is not available, so there is no chunk payload to compare '
                + 'against. Nothing was scanned and nothing would be deleted.',
            );
        }

        const entries = listEntries();
        const run = await runChunkMetaDryRun({
            entries,
            collections: listCollections(settings) || [],
            clientOnlyFields,
            pageSize,
            onProgress,
            // The transport routes by registry key, which is what the registry holds.
            listChunks: (collection, options) => transport.listChunks(collection.registryKey, options),
        });

        return {
            status: VIEW_STATUS.MEASURED,
            entries,
            plan: run.plan,
            view: run.view,
        };
    };
}

/**
 * The dry run: scans every registered collection and reports how many settings
 * chunk-metadata entries are redundant, need patching, are orphans, or were
 * skipped. Writes nothing.
 *
 * Plugin-only: without the plugin there is no payload metadata to compare
 * against, so the run reports itself unavailable instead of issuing a scan whose
 * every listing would be metadata-less.
 *
 * @param {object} [deps] See createStorageScan(); `createStorageDryRun` passes
 *     them straight through.
 * @returns {function(object=): Promise<object>} The dry-run entry point, returning
 *     a report view model or an unavailable view.
 */
export function createStorageDryRun(deps) {
    const scan = createStorageScan(deps);

    /**
     * @param {object} [options]
     * @param {() => (object|null|undefined)} [options.getSettings] Returns
     *     `extension_settings.vectfox`.
     * @param {number} [options.pageSize] Chunks requested per listing page.
     * @param {(progress: { done: number, total: number, collectionId: string }) => void} [options.onProgress]
     * @returns {Promise<object>} Report view model, or an unavailable view.
     */
    return async function runStorageDryRun(options = {}) {
        const result = await scan(options);
        return result.status === VIEW_STATUS.MEASURED ? result.view : result;
    };
}

/**
 * The backup: runs the same scan the dry run reports on, then serializes every
 * considered entry — orphans included — into a self-describing JSON file. The
 * download itself is the UI's job; this returns the file's name and contents,
 * the entry count as a display label, and the report of the scan it used.
 *
 * @param {object} [deps] See createStorageScan().
 * @returns {function(object=): Promise<object>} The backup entry point, resolving
 *     to `{ status, filename, text, entries, view }` (the file, its count, and the
 *     report of the scan it was built from) or an unavailable view.
 */
export function createStorageBackup(deps) {
    const scan = createStorageScan(deps);

    /**
     * @param {object} [options]
     * @param {() => (object|null|undefined)} [options.getSettings] Returns
     *     `extension_settings.vectfox`.
     * @param {number} [options.pageSize] Chunks requested per listing page.
     * @param {(progress: { done: number, total: number, collectionId: string }) => void} [options.onProgress]
     *     Scan progress, per collection.
     * @param {(progress: { done: number, total: number }) => void} [options.onEncode]
     *     File-writing progress, per chunk of entries.
     * @param {Date|string|number} [options.now] Timestamp the file is stamped with.
     * @param {number} [options.chunkSize] Entries written between event-loop yields.
     * @param {() => Promise<void>} [options.yieldControl] Yield primitive; tests inject one.
     * @returns {Promise<object>}
     */
    return async function runStorageBackup({
        getSettings,
        pageSize = 500,
        onProgress,
        onEncode,
        now,
        chunkSize,
        yieldControl,
    } = {}) {
        const result = await scan({ getSettings, pageSize, onProgress });
        if (result.status !== VIEW_STATUS.MEASURED) return result;

        const document = buildChunkMetaBackup({ entries: result.entries, plan: result.plan, now });
        const text = await serializeChunkMetaBackup(document, {
            chunkSize,
            yieldControl,
            onProgress: onEncode,
        });

        return {
            status: VIEW_STATUS.MEASURED,
            ...buildBackupDownload(document, text),
            // The report of the very scan this file was built from.
            view: result.view,
        };
    };
}
