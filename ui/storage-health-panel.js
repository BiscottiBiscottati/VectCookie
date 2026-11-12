/**
 * ============================================================================
 * VECTFOX STORAGE HEALTH PANEL
 * ============================================================================
 * Renders the Size Inspector's storage-health block: the serialized extension
 * settings size, the top contributing keys, the chunk-metadata entry count, the
 * over-limit warning (ADR-0003), the dry run that reports how many entries the
 * staged migration would consider redundant, patchable or orphaned, the backup
 * download that makes the one irreversible step reversible, and the sweep itself
 * with the stamp of the last run.
 *
 * Opening the block costs one in-memory serialization of the settings object:
 * every action is an explicit button, and nothing imported here talks to the
 * plugin, Qdrant or the collection loader. The runners are injected, so a tab
 * that is merely opened can neither start a scan nor issue a request —
 * tests/size-inspector.test.js holds that line.
 * ============================================================================
 */

import { buildStorageHealth, formatEntryCount } from "../core/storage-health.js";
import { formatSweepStamp } from "../core/chunk-meta-sweep-report.js";
import { getSweepStamp } from "../core/chunk-meta-sweep-execute.js";
import { downloadJsonFile } from "../utils/file-download.js";
import { VIEW_STATUS } from "../core/view-status.js";
import { icons } from "./icons.js";
import StringUtils from "../utils/string-utils.js";

/**
 * Last dry-run report per mounted health block. Re-measure rebuilds the block's
 * markup, and losing a report whose scan just took a minute would be worse than
 * keeping it: the WeakMap holds it per container and is released with the node.
 */
const dryRunReports = new WeakMap();

/**
 * Last backup status per mounted health block. Kept beside the report for the
 * same reason: Re-measure (or the dry run finishing) rebuilds the markup, and a
 * "Backup saved" that vanishes the moment the user re-measures reads as if the
 * download never happened. Also survives a re-render during an in-flight
 * backup, so progress is never written to a detached node.
 */
const backupStatuses = new WeakMap();

/**
 * Last sweep result and status line per mounted health block. They survive
 * Re-measure for the same reason the dry-run report does: a sweep can take a
 * minute, and losing the record of what it moved the moment the user re-measures
 * would leave the panel looking as if nothing happened.
 */
const sweepResults = new WeakMap();
const sweepStatuses = new WeakMap();

/**
 * Containers with a collection scan in flight. Dry run, backup and sweep all
 * page every registered collection, so one flag covers all three: concurrent
 * scans serve no action, a sweep started mid-dry-run would act on a plan the
 * panel no longer shows, and a dry run finishing after a backup would replace
 * the backup's report while the status still described the file. The flag
 * disables the rendered buttons and guards every handler; nodes are looked up
 * rather than captured because a re-render replaces them.
 */
const scansInFlight = new WeakSet();

/**
 * Marks the block's collection actions busy (or idle).
 * @param {HTMLElement} container
 * @param {boolean} busy
 */
function setActionsBusy(container, busy) {
    if (busy) scansInFlight.add(container);
    else scansInFlight.delete(container);
    for (const selector of [
        "#vectfox_size_dry_run",
        "#vectfox_size_backup_download",
        "#vectfox_size_run_sweep",
    ]) {
        const node = container.querySelector(selector);
        if (node) node.disabled = busy;
    }
}

/**
 * Renders the storage-health block into `container`, replacing whatever was
 * there. `getSettings` is called on every render, so reopening the tab or
 * pressing Re-measure reads the current settings rather than a snapshot taken
 * when the tab first opened.
 * @param {HTMLElement|null} container Mount point for the block.
 * @param {function(): (object|null|undefined)} getSettings Returns the extension
 *     settings object (`extension_settings.vectfox`) to measure.
 * @param {object} [deps]
 * @param {function({ onProgress?: function }): Promise<object>} [deps.runDryRun]
 *     Runs the read-only scan and resolves to the dry-run report view model.
 * @param {function({ onProgress?: function, onEncode?: function }): Promise<object>} [deps.runBackup]
 *     Runs the same scan and resolves to `{ status, filename, text, entries, view }`
 *     — the file, its label, and the report of the scan it was built from — or
 *     an unavailable view.
 * @param {function({ onProgress?: function }): Promise<object>} [deps.runSweep]
 *     Runs the explicit sweep and resolves to the run's report view model, or an
 *     unavailable view. It is the only runner here that mutates.
 * @param {(filename: string, text: string) => (boolean|void)} [deps.saveFile]
 *     Saves the backup; returns false when it cannot. Defaults to a Blob
 *     download; injected so tests can observe the file without one.
 * @returns {object|null} The view model rendered, or null without a mount point.
 */
export function renderStorageHealthPanel(container, getSettings, deps = {}) {
    const { runDryRun, runBackup, saveFile } = deps;
    if (!container) return null;

    const settings = getSettings?.();
    const view = buildStorageHealth(settings);
    const report = dryRunReports.get(container) || null;
    const sweep = sweepResults.get(container) || null;
    const backupStatus = backupStatuses.get(container) || "";
    const sweepStatus = sweepStatuses.get(container) || "";
    const stampNote = formatSweepStamp(getSweepStamp(settings));
    container.innerHTML = storageHealthHtml(
        view,
        report,
        sweep,
        { backupStatus, sweepStatus, stampNote },
        scansInFlight.has(container),
    );

    const refreshButton = container.querySelector("#vectfox_size_health_refresh");
    if (refreshButton) {
        refreshButton.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            renderStorageHealthPanel(container, getSettings, deps);
        };
    }
    bindDryRun(container, getSettings, deps);
    bindBackup(container, getSettings, deps);
    bindSweep(container, getSettings, deps);
    return view;
}

/**
 * The skeleton every collection action shares: refuse while another scan is in
 * flight, mark the buttons busy, run the injected action, and restore the
 * buttons whether it resolved or threw. What the result *means* — a report, a
 * saved file, a stamp — stays in the handler, so this helper owns no wording.
 * @param {HTMLElement} container Mount point of the health block.
 * @param {() => Promise<any>} action The injected runner call.
 * @returns {Promise<{ result?: any, error?: Error }>} One of the two, never both.
 */
async function runCollectionAction(container, action) {
    setActionsBusy(container, true);
    try {
        return { result: await action() };
    } catch (error) {
        return { error };
    } finally {
        setActionsBusy(container, false);
    }
}

/**
 * Wires the dry-run action. One of only two places in this module that may
 * cause a request, and only on a click.
 */
function bindDryRun(container, getSettings, deps) {
    const buttonOf = () => container.querySelector("#vectfox_size_dry_run");
    if (!buttonOf()) return;

    /** Writes progress to the current node; a re-render replaces it. */
    const setStatus = (text) => {
        const current = container.querySelector("#vectfox_size_dry_run_status");
        if (current) current.textContent = text;
    };

    buttonOf().onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (scansInFlight.has(container)) return;
        if (typeof deps.runDryRun !== "function") {
            setStatus("The dry run is not available in this build.");
            return;
        }

        setStatus("Scanning every registered collection…");
        const { result, error } = await runCollectionAction(container, () => deps.runDryRun({
            onProgress: ({ done, total }) => {
                setStatus(`Scanning every registered collection… (${done}/${total})`);
            },
        }));

        dryRunReports.set(container, error
            ? { status: VIEW_STATUS.UNAVAILABLE, reason: `Dry run failed: ${error?.message || error}` }
            : result);
        renderStorageHealthPanel(container, getSettings, deps);
    };
}

/**
 * Wires the backup download. The scan it runs is the dry run's, and the runner
 * hands back that scan's report: the panel replaces the on-screen report with
 * it, so the counts the user sees are the counts the file holds. The click is
 * the only trigger.
 */
function bindBackup(container, getSettings, deps) {
    const buttonOf = () => container.querySelector("#vectfox_size_backup_download");
    if (!buttonOf()) return;

    /**
     * Writes the status to both the stored state and the current node. A
     * Re-measure or a finishing dry run replaces the node; writing through the
     * lookup means an in-flight backup keeps reporting progress on the new one.
     */
    const setStatus = (text) => {
        backupStatuses.set(container, text);
        const current = container.querySelector("#vectfox_size_backup_status");
        if (current) current.textContent = text;
    };

    buttonOf().onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (scansInFlight.has(container)) return;
        if (typeof deps.runBackup !== "function") {
            setStatus("The backup download is not available in this build.");
            return;
        }

        setStatus("Scanning every registered collection…");

        // The download happens inside the action so a browser that cannot save
        // is a failure, while a saved file can never be reported as one.
        const { result: backup, error } = await runCollectionAction(container, async () => {
            const run = await deps.runBackup({
                onProgress: ({ done, total }) => {
                    setStatus(`Scanning every registered collection… (${done}/${total})`);
                },
                // Large libraries take several event-loop turns to serialize;
                // the status line proves the download is still progressing.
                onEncode: ({ done, total }) => {
                    setStatus(`Writing the backup file… (${done}/${total})`);
                },
            });

            if (run?.status !== VIEW_STATUS.MEASURED) return { unavailable: run };

            const saved = (deps.saveFile || downloadJsonFile)(run.filename, run.text);
            if (saved === false) throw new Error("this browser cannot save files");
            return run;
        });

        if (error) {
            setStatus(`Backup failed: ${error?.message || error}`);
            return;
        }
        if (backup?.unavailable) {
            setStatus(backup.unavailable.reason || "The backup could not be built.");
            return;
        }

        // The label is read defensively because the runner is an injected seam.
        const label = backup.entries?.label;
        setStatus(label
            ? `Backup saved: ${backup.filename} (${label})`
            : `Backup saved: ${backup.filename}`);
        // Show the report of the scan the file was built from. If an older
        // dry-run report was on screen, it is now the backup's, not a stale
        // reading that could disagree with the download.
        if (backup.view) dryRunReports.set(container, backup.view);
        renderStorageHealthPanel(container, getSettings, deps);
    };
}

/**
 * Wires the sweep action. It is the only mutating handler in this module: the
 * button is the sole trigger, and the runner owns every safety rule (the trusted
 * scan, the batch abort, the single save and the stamp). The panel only reports
 * what the run returned, then re-measures — which is how the smaller settings
 * payload becomes visible — and drops the dry-run report the run invalidated.
 */
function bindSweep(container, getSettings, deps) {
    const buttonOf = () => container.querySelector("#vectfox_size_run_sweep");
    if (!buttonOf()) return;

    /** Writes the status to both the stored state and the current node. */
    const setStatus = (text) => {
        sweepStatuses.set(container, text);
        const current = container.querySelector("#vectfox_size_sweep_status");
        if (current) current.textContent = text;
    };

    buttonOf().onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (scansInFlight.has(container)) return;
        if (typeof deps.runSweep !== "function") {
            setStatus("The sweep is not available in this build.");
            return;
        }

        setStatus("Scanning every registered collection…");
        const { result, error } = await runCollectionAction(container, () => deps.runSweep({
            onProgress: (progress) => {
                setStatus(progress?.phase
                    ? `Moving chunk metadata… (${progress.done}/${progress.total})`
                    : `Scanning every registered collection… (${progress.done}/${progress.total})`);
            },
        }));

        if (error) {
            setStatus(`Sweep failed: ${error?.message || error}`);
            return;
        }
        if (result?.status !== VIEW_STATUS.MEASURED) {
            setStatus(result?.reason || "The sweep could not run.");
            return;
        }

        sweepResults.set(container, result);
        setStatus(result.headline);
        // The dry-run counts described the entries this run just moved; leaving
        // them on screen beside the run's own result would be two answers.
        if (result.outcome !== "noop") dryRunReports.delete(container);
        renderStorageHealthPanel(container, getSettings, deps);
    };
}

/**
 * Builds the block's markup from the view model, the last dry-run report, the
 * last sweep result and the status lines.
 * @param {object} view View model from buildStorageHealth()
 * @param {object|null} [report] Dry-run report view model, if one has run.
 * @param {object|null} [sweep] Sweep report view model, if one has run.
 * @param {{ backupStatus?: string, sweepStatus?: string, stampNote?: string }} [status] Persisted status lines.
 * @param {boolean} [scanBusy] Whether a collection scan is in flight right now.
 * @returns {string} HTML
 */
function storageHealthHtml(
    view,
    report = null,
    sweep = null,
    { backupStatus = "", sweepStatus = "", stampNote = "" } = {},
    scanBusy = false,
) {
    const head = `
        <div class="vectfox-size-health-head">
            <h4>Storage health</h4>
            <div class="vectfox-size-health-actions">
                <button id="vectfox_size_dry_run" class="vectfox-btn-sm" ${scanBusy ? "disabled" : ""}>${icons.listChecks(14)} Dry run</button>
                <button id="vectfox_size_backup_download" class="vectfox-btn-sm" ${scanBusy ? "disabled" : ""}>${icons.download(14)} Download backup</button>
                <button id="vectfox_size_run_sweep" class="vectfox-btn-sm" ${scanBusy ? "disabled" : ""}>${icons.listChecks(14)} Run sweep</button>
                <button id="vectfox_size_health_refresh" class="vectfox-btn-sm">${icons.refreshCw(14)} Re-measure</button>
            </div>
        </div>
        <div id="vectfox_size_dry_run_status" class="vectfox-size-health-status"></div>
        <div id="vectfox_size_backup_status" class="vectfox-size-health-status">${StringUtils.escapeHtml(backupStatus)}</div>
        <div id="vectfox_size_sweep_status" class="vectfox-size-health-status">${StringUtils.escapeHtml(sweepStatus)}</div>
        <div class="vectfox-size-health-detail" data-sweep="stamp">${StringUtils.escapeHtml(stampNote)}</div>
    `;

    const reportBlock = `
        <div id="vectfox_size_dry_run_report" class="vectfox-size-health-report">
            ${dryRunReportHtml(report)}
        </div>
        <div id="vectfox_size_sweep_result" class="vectfox-size-health-report">
            ${sweepResultHtml(sweep)}
        </div>
    `;

    if (view.status !== VIEW_STATUS.MEASURED) {
        return `
            ${head}
            <div class="vectfox-size-health-status">${StringUtils.escapeHtml(view.reason || "")}</div>
            ${reportBlock}
        `;
    }

    return `
        ${head}
        <div class="vectfox-size-health-grid">
            <div class="vectfox-size-health-item" data-health="settings-size">
                <span class="vectfox-size-health-label">Extension settings</span>
                <span class="vectfox-size-health-value">${StringUtils.escapeHtml(view.total.sizeLabel)}</span>
                <span class="vectfox-size-health-detail">${StringUtils.escapeHtml(view.total.exactLabel)} bytes</span>
            </div>
            <div class="vectfox-size-health-item" data-health="chunk-meta">
                <span class="vectfox-size-health-label">Chunk metadata in settings</span>
                <span class="vectfox-size-health-value">${StringUtils.escapeHtml(view.chunkMeta.sizeLabel)}</span>
                <span class="vectfox-size-health-detail">${StringUtils.escapeHtml(formatEntryCount(view.chunkMeta.count))}</span>
            </div>
        </div>
        ${view.warning ? `<div class="vectfox-size-health-warning" data-health="warning">${StringUtils.escapeHtml(view.warning)}</div>` : ""}
        <div class="vectfox-size-table-scroll">
            <table class="vectfox-size-table vectfox-size-health-table">
                <thead>
                    <tr>
                        <th>Top contributing key</th>
                        <th class="num">Size</th>
                        <th class="num">Bytes</th>
                    </tr>
                </thead>
                <tbody>${topKeyRows(view.topKeys)}</tbody>
            </table>
        </div>
        ${reportBlock}
    `;
}

/**
 * The dry-run report: counts per collection and in total, plus the plain
 * statement that an untrusted scan refuses deletion.
 * @param {object|null} report
 * @returns {string} HTML, or an empty string before the first run.
 */
function dryRunReportHtml(report) {
    if (!report) return "";

    if (report.status !== VIEW_STATUS.MEASURED) {
        return `<div class="vectfox-size-health-warning" data-dry-run="unavailable">${StringUtils.escapeHtml(report.reason || "The dry run is unavailable.")}</div>`;
    }

    return `
        <div class="vectfox-size-health-headline" data-dry-run="headline">${StringUtils.escapeHtml(report.headline)}</div>
        <div class="vectfox-size-health-detail" data-dry-run="coverage">${StringUtils.escapeHtml(report.coverageLabel)}</div>
        ${report.refusal ? `<div class="vectfox-size-health-warning" data-dry-run="refusal">${StringUtils.escapeHtml(report.refusal)}</div>` : ""}
        ${report.skippedNote ? `<div class="vectfox-size-health-detail" data-dry-run="skipped-note">${StringUtils.escapeHtml(report.skippedNote)}</div>` : ""}
        <div class="vectfox-size-table-scroll">
            <table class="vectfox-size-table">
                <thead>
                    <tr>
                        <th>Collection</th>
                        <th>Scan</th>
                        <th class="num">Chunks</th>
                        <th class="num">Redundant</th>
                        <th class="num">Need patch</th>
                        <th class="num">Skipped</th>
                        <th class="num">Orphans</th>
                    </tr>
                </thead>
                <tbody>${dryRunRows(report.collections)}</tbody>
                <tfoot>
                    <tr class="vectfox-size-dry-run-total">
                        <td>Total</td>
                        <td></td>
                        <td class="num">${report.totals.chunks.label}</td>
                        <td class="num" data-dry-run="total-redundant">${report.totals.redundant.label}</td>
                        <td class="num" data-dry-run="total-patch">${report.totals.patch.label}</td>
                        <td class="num" data-dry-run="total-skipped">${report.totals.skipped.label}</td>
                        <td class="num" data-dry-run="total-orphan">${report.totals.orphan.label}</td>
                    </tr>
                </tfoot>
            </table>
        </div>
        <div class="vectfox-size-health-detail" data-dry-run="orphan-note">${StringUtils.escapeHtml(report.orphanNote)}</div>
    `;
}

/**
 * @param {Array<{
 *   registryKey: string, collectionId: string, status: string,
 *   chunkCount: { count: number, label: string },
 *   redundant: { count: number, label: string },
 *   patch: { count: number, label: string },
 *   skipped: { count: number, label: string },
 * }>} collections
 * @returns {string} HTML rows
 */
function dryRunRows(collections) {
    if (!collections.length) {
        return `<tr><td colspan="7" class="vectfox-size-health-empty">No registered collections were found.</td></tr>`;
    }
    return collections.map((row) => `
        <tr data-collection="${StringUtils.escapeHtml(row.registryKey)}">
            <td class="collection-cell" title="${StringUtils.escapeHtml(row.registryKey)}">${StringUtils.escapeHtml(row.collectionId)}</td>
            <td>${StringUtils.escapeHtml(row.status)}</td>
            <td class="num">${row.chunkCount.label}</td>
            <td class="num" data-dry-run="row-redundant">${row.redundant.label}</td>
            <td class="num" data-dry-run="row-patch">${row.patch.label}</td>
            <td class="num" data-dry-run="row-skipped">${row.skipped.label}</td>
            <td class="num" title="An orphan belongs to no collection.">—</td>
        </tr>`).join("");
}

/**
 * The sweep result: what the run moved, why it stopped, and why deletion may
 * have been refused. Counts carry their labels from the view model.
 * @param {object|null} sweep
 * @returns {string} HTML, or an empty string before the first run.
 */
function sweepResultHtml(sweep) {
    if (!sweep) return "";
    return `
        <div class="vectfox-size-health-headline" data-sweep="headline">${StringUtils.escapeHtml(sweep.headline)}</div>
        <div class="vectfox-size-health-detail">
            Entries handled: <span data-sweep="entries">${sweep.counts.entries.label}</span>
            · Patched: <span data-sweep="patched">${sweep.counts.patched.label}</span>
            · Settings entries removed: <span data-sweep="deleted">${sweep.counts.deleted.label}</span>
        </div>
        ${sweep.resumedNote ? `<div class="vectfox-size-health-detail" data-sweep="resumed">${StringUtils.escapeHtml(sweep.resumedNote)}</div>` : ""}
        ${sweep.refusal ? `<div class="vectfox-size-health-warning" data-sweep="refusal">${StringUtils.escapeHtml(sweep.refusal)}</div>` : ""}
        ${sweep.failure ? `<div class="vectfox-size-health-warning" data-sweep="failure">${StringUtils.escapeHtml(sweep.failure)}</div>` : ""}
        ${sweep.saveWarning ? `<div class="vectfox-size-health-warning" data-sweep="save-warning">${StringUtils.escapeHtml(sweep.saveWarning)}</div>` : ""}
    `;
}

/**
 * @param {Array<{ key: string, bytes: number, sizeLabel: string, exactLabel: string }>} topKeys
 * @returns {string} HTML rows
 */
function topKeyRows(topKeys) {
    if (!topKeys.length) {
        return `<tr><td colspan="3" class="vectfox-size-health-empty">No settings keys outside the chunk-metadata namespace.</td></tr>`;
    }
    return topKeys.map((row) => `
        <tr>
            <td class="hash-cell" title="${StringUtils.escapeHtml(row.key)}">${StringUtils.escapeHtml(row.key)}</td>
            <td class="num">${StringUtils.escapeHtml(row.sizeLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.exactLabel)}</td>
        </tr>`).join("");
}
