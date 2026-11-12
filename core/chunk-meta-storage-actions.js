/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA STORAGE ACTIONS (dry run, backup and sweep)
 * ============================================================================
 * Composes the four things the staged migration's actions need — the live
 * settings, the registered collections, the legacy settings entries, and the
 * plugin transport — into the scan plus plan in core/chunk-meta-sweep-report.js.
 *
 * The dry run and the backup run the one scan implementation. That is the
 * ticket-04 guarantee: the backup's contents come from the dry run's scan, not
 * from a second, separately-written reading of the same sources. A backup
 * necessarily scans again when it is requested — it has to be as fresh as
 * possible before deletion — so it also hands back the report of the scan it
 * used, and the panel shows that report beside the file. What the user sees
 * after downloading is therefore exactly what the file holds.
 *
 * The sweep runs the same scan and plan, then hands them to the executor in
 * core/chunk-meta-sweep-execute.js. It is the only action here that writes: the
 * composition supplies the writes, the stamp accessors and the one settings save
 * after the run, so the executor stays host-free and testable.
 *
 * Orphan deletion also runs that scan, because a fresh absence check is the whole
 * point of it, then hands the plan to core/chunk-meta-orphan-delete.js. It
 * deletes nothing until the UI's counted confirmation resolves true, which is
 * why its only extra dependency is the confirmation callback. It refuses the
 * `settings` store policy for the same reason the sweep does: that is the
 * rollback state, and a destructive migration action has no business running in
 * it.
 *
 * Host-free on purpose: the dependencies are injected by the wiring layer
 * (ui/database-browser.js), so this seam can be tested without resolving
 * SillyTavern modules, and the scan cannot reach a write path it was not given.
 * Nothing here saves settings except the sweep's own single save, and the read
 * actions patch nothing.
 * ============================================================================
 */

import { buildChunkMetaBackup, serializeChunkMetaBackup } from './chunk-meta-backup.js';
import { buildBackupDownload } from './chunk-meta-backup-view.js';
import {
    decideChunkMetaOrphanDelete,
    executeChunkMetaOrphanDelete,
} from './chunk-meta-orphan-delete.js';
import {
    executeChunkMetaSweep,
} from './chunk-meta-sweep-execute.js';
import {
    buildOrphanDeleteConfirmView,
    buildOrphanDeleteRunView,
    buildSweepRunView,
    runChunkMetaDryRun,
} from './chunk-meta-sweep-report.js';
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
 *     The read actions only call `isAvailable` and `listChunks`; the sweep also
 *     calls `patchMetadata`.
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
            // The same transport instance the gate accepted, so the sweep writes
            // through what was verified reachable rather than building a second.
            transport,
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

/**
 * The sweep: the staged migration's one explicit, mutating action. It runs the
 * dry run's scan and plan, then patches the payloads that lack fields and removes
 * the settings copies the payload supersedes. Orphans, unverified entries and
 * client-only entries are left alone; an untrusted scan deletes nothing. One
 * settings save follows the run, and the stamp it leaves in settings is what a
 * later run resumes from.
 *
 * Refuses to run when the store policy is explicitly `settings`: that is the
 * rollback state, in which the settings namespace is the source of truth and a
 * sweep would move data away from it.
 *
 * @param {object} [deps] See createStorageScan(), plus:
 * @param {(hash: string) => boolean|void} [deps.deleteEntry]
 *     Removes one legacy settings entry without saving.
 * @param {() => (object|null|undefined)} [deps.readStamp] The stored sweep stamp.
 * @param {(stamp: object) => void} [deps.writeStamp] Stores the sweep stamp.
 * @param {() => void} [deps.persistSettings]
 *     Persists the settings, called once after the run.
 * @param {number} [deps.batchSize] Work items per batch.
 * @returns {function(object=): Promise<object>} The sweep entry point, resolving
 *     to the run's report view model or an unavailable view.
 */
export function createStorageSweep(deps = {}) {
    const {
        deleteEntry,
        readStamp,
        writeStamp,
        persistSettings,
        batchSize,
    } = deps;
    const scan = createStorageScan(deps);

    /**
     * @param {object} [options]
     * @param {() => (object|null|undefined)} [options.getSettings] Returns
     *     `extension_settings.vectfox`.
     * @param {number} [options.pageSize] Chunks requested per listing page.
     * @param {(progress: { done: number, total: number, collectionId: string }) => void} [options.onProgress]
     *     Scan progress, per collection.
     * @param {Date|string|number} [options.now] Timestamp the run is stamped with.
     * @returns {Promise<object>}
     */
    return async function runStorageSweep({ getSettings, pageSize = 500, onProgress, now } = {}) {
        if (typeof deleteEntry !== 'function' || typeof persistSettings !== 'function') {
            return unavailable('The storage migration tools are not configured in this build.');
        }

        // The policy is the rollback switch: with `settings` chosen explicitly,
        // the settings namespace is the declared source of truth, and a sweep
        // would move data out from under that choice. The sweep therefore writes
        // the payload and stamps that mode; it never runs in settings mode.
        const settings = getSettings?.();
        if (settings?.chunk_meta_store === 'settings') {
            return unavailable(
                'The chunk metadata store is set to settings, so the sweep would move nothing. '
                + 'Set it back to auto before sweeping.',
            );
        }

        const result = await scan({ getSettings, pageSize, onProgress });
        if (result.status !== VIEW_STATUS.MEASURED) return result;

        const run = await executeChunkMetaSweep({
            plan: result.plan,
            mode: 'payload',
            patchMetadata: (registryKey, hash, fields) => (
                result.transport.patchMetadata(registryKey, hash, fields)
            ),
            deleteEntry,
            readStamp,
            writeStamp,
            persistSettings,
            batchSize,
            now,
            // The scan owns listing progress; the run's own progress follows it.
            onProgress: (progress) => onProgress?.(progress),
        });

        return {
            status: VIEW_STATUS.MEASURED,
            // The report of the very run whose stamp was written.
            ...buildSweepRunView(run, { refusal: result.view.refusal }),
            run,
        };
    };
}

/**
 * Orphan deletion: removes the settings entries whose chunk exists in no
 * registered collection. It runs the dry run's own scan, plan and rules — a
 * fresh one, because absence is the thing being acted on — so the count and the
 * size it asks the user to confirm describe the settings as they are at the
 * click, not as an older report left on screen. It deletes only the plan's
 * orphan hashes: never a redundant, patchable, client-only or unverified entry.
 *
 * The confirmation is counted and is the only way in: `confirm` receives the
 * view model built from the decision, and a missing, false or throwing
 * confirmation removes nothing and saves nothing. An untrusted scan (any
 * registered collection unreadable) refuses the whole run, because absence in a
 * collection that was never read is not proof of an orphan. The `settings`
 * store policy refuses too: it is the rollback state, where the settings
 * namespace is declared the source of truth and destructive migration actions
 * stay out (the sweep follows the same rule).
 *
 * @param {object} [deps] See createStorageScan(), plus:
 * @param {(hash: string) => boolean|void} [deps.deleteEntry]
 *     Removes one legacy settings entry without saving.
 * @param {() => void} [deps.persistSettings]
 *     Persists the settings, called once after the deletion.
 * @returns {function(object=): Promise<object>} The deletion entry point,
 *     resolving to the run's report view model or an unavailable view.
 */
export function createStorageOrphanDelete(deps = {}) {
    const { deleteEntry, persistSettings, clientOnlyFields = [] } = deps;
    const scan = createStorageScan(deps);

    /**
     * @param {object} [options]
     * @param {() => (object|null|undefined)} [options.getSettings] Returns
     *     `extension_settings.vectfox`.
     * @param {number} [options.pageSize] Chunks requested per listing page.
     * @param {(progress: object) => void} [options.onProgress] Scan progress,
     *     then per-entry deletion progress.
     * @param {(view: object) => (boolean|Promise<boolean>)} [options.confirm]
     *     Shows the counted confirmation. Absent, the run cancels.
     * @returns {Promise<object>}
     */
    return async function runStorageOrphanDelete({
        getSettings,
        pageSize = 500,
        onProgress,
        confirm,
    } = {}) {
        if (typeof deleteEntry !== 'function' || typeof persistSettings !== 'function') {
            return unavailable('The storage migration tools are not configured in this build.');
        }

        const settings = getSettings?.();
        if (settings?.chunk_meta_store === 'settings') {
            return unavailable(
                'The chunk metadata store is set to settings, which is the rollback state. '
                + 'Set it back to auto before deleting orphans.',
            );
        }

        const result = await scan({ getSettings, pageSize, onProgress });
        if (result.status !== VIEW_STATUS.MEASURED) return result;

        const decision = decideChunkMetaOrphanDelete({
            plan: result.plan,
            settings: getSettings?.(),
            // A client-only field is the only copy of its data; the planner
            // already keeps such entries, and this passes the same rule to the
            // decision so a hand-built plan cannot remove one either.
            clientOnlyFields,
        });
        const run = await executeChunkMetaOrphanDelete({
            decision,
            // Built lazily and awaited: the UI's confirmation is a dialog, and an
            // unawaited promise is always truthy — which would delete without an
            // answer. Refused and empty decisions never reach it.
            confirmDelete: async () => Boolean(
                await confirm?.(buildOrphanDeleteConfirmView(decision)),
            ),
            deleteEntry,
            persistSettings,
            onProgress,
        });

        return {
            status: VIEW_STATUS.MEASURED,
            ...buildOrphanDeleteRunView(run, {
                refusal: result.view.refusal,
                untrustedReason: result.plan.untrustedReason,
            }),
            // The report of the scan this run acted on, so the panel can keep the
            // screen and the confirmation in agreement when nothing was removed.
            scanView: result.view,
            run,
        };
    };
}
