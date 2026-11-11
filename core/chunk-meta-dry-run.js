/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA DRY RUN (composition)
 * ============================================================================
 * Composes the four things a dry run needs — the live settings, the registered
 * collections, the legacy settings entries, and the plugin transport — into the
 * read-only scan plus plan in core/chunk-meta-sweep-report.js.
 *
 * Host-free on purpose: the dependencies are injected by the wiring layer
 * (ui/database-browser.js), so this seam can be tested without resolving
 * SillyTavern modules, and the scan cannot reach a write path it was not given.
 * Nothing here saves settings, patches a payload or registers a collection.
 * ============================================================================
 */

import { runChunkMetaDryRun } from './chunk-meta-sweep-report.js';
import { VIEW_STATUS } from './view-status.js';

/**
 * A dry run that cannot run at all — reported as such rather than as an empty
 * trusted plan, so the UI never implies "nothing to do".
 * @param {string} reason
 * @returns {{ status: 'unavailable', reason: string }}
 */
function unavailable(reason) {
    return { status: VIEW_STATUS.UNAVAILABLE, reason };
}

/**
 * @param {object} deps
 * @param {function({ getSettings: function }): object} deps.createTransport
 *     Builds the plugin transport (`isAvailable`, `listChunks`, `patchMetadata`).
 *     The dry run only ever calls `isAvailable` and `listChunks`.
 * @param {function(object): Array<{ registryKey: string, collectionId: string }>} deps.listCollections
 *     The registered collections for the given settings.
 * @param {function(): Object<string, object>} deps.listEntries
 *     The legacy settings entries: hash -> metadata.
 * @param {Iterable<string>} [deps.clientOnlyFields] Fields with no payload representation.
 * @returns {function(object=): Promise<object>} The dry-run entry point, returning
 *     a report view model or an unavailable view.
 */
export function createStorageDryRun({
    createTransport,
    listCollections,
    listEntries,
    clientOnlyFields = [],
} = {}) {
    /**
     * Scans every registered collection and reports how many settings
     * chunk-metadata entries are redundant, need patching, are orphans, or were
     * skipped. Writes nothing.
     *
     * Plugin-only: without the plugin there is no payload metadata to compare
     * against, so the run reports itself unavailable instead of issuing a scan
     * whose every listing would be metadata-less.
     *
     * @param {object} [options]
     * @param {() => (object|null|undefined)} [options.getSettings] Returns
     *     `extension_settings.vectfox`.
     * @param {number} [options.pageSize] Chunks requested per listing page.
     * @param {(progress: { done: number, total: number, collectionId: string }) => void} [options.onProgress]
     * @returns {Promise<object>} Report view model, or an unavailable view.
     */
    return async function runStorageDryRun({ getSettings, pageSize = 500, onProgress } = {}) {
        if (typeof createTransport !== 'function'
            || typeof listCollections !== 'function'
            || typeof listEntries !== 'function') {
            return unavailable('The storage dry run is not configured in this build.');
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

        const run = await runChunkMetaDryRun({
            entries: listEntries(),
            collections: listCollections(settings) || [],
            clientOnlyFields,
            pageSize,
            onProgress,
            // The transport routes by registry key, which is what the registry holds.
            listChunks: (collection, options) => transport.listChunks(collection.registryKey, options),
        });

        return run.view;
    };
}
