/**
 * ============================================================================
 * VECTFOX STORAGE HEALTH PANEL
 * ============================================================================
 * Renders the Size Inspector's storage-health block: the serialized extension
 * settings size, the top contributing keys, the chunk-metadata entry count, the
 * over-limit warning (ADR-0003), the dry run that reports how many entries the
 * staged migration would consider redundant, patchable or orphaned, and the
 * backup download that makes the one irreversible step reversible.
 *
 * Opening the block costs one in-memory serialization of the settings object:
 * both actions are explicit buttons, and nothing imported here talks to the
 * plugin, Qdrant or the collection loader. The runners are injected, so a tab
 * that is merely opened can neither start a scan nor issue a request —
 * tests/size-inspector.test.js holds that line.
 * ============================================================================
 */

import { buildStorageHealth, formatEntryCount } from "../core/storage-health.js";
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
 * Containers with a collection scan in flight. Both actions page every
 * registered collection, so one flag covers both: two concurrent scans serve
 * neither action, and a dry run finishing after a backup would replace the
 * backup's report while the status still described the file. The flag disables
 * the rendered buttons and guards both handlers; nodes are looked up rather than
 * captured because a re-render replaces them.
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
    for (const selector of ["#vectfox_size_dry_run", "#vectfox_size_backup_download"]) {
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
 * @param {(filename: string, text: string) => (boolean|void)} [deps.saveFile]
 *     Saves the backup; returns false when it cannot. Defaults to a Blob
 *     download; injected so tests can observe the file without one.
 * @returns {object|null} The view model rendered, or null without a mount point.
 */
export function renderStorageHealthPanel(container, getSettings, deps = {}) {
    const { runDryRun, runBackup, saveFile } = deps;
    if (!container) return null;

    const view = buildStorageHealth(getSettings?.());
    const report = dryRunReports.get(container) || null;
    const backupStatus = backupStatuses.get(container) || "";
    container.innerHTML = storageHealthHtml(
        view,
        report,
        backupStatus,
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
    return view;
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

        setActionsBusy(container, true);
        setStatus("Scanning every registered collection…");
        let report;
        try {
            report = await deps.runDryRun({
                onProgress: ({ done, total }) => {
                    setStatus(`Scanning every registered collection… (${done}/${total})`);
                },
            });
        } catch (err) {
            report = {
                status: VIEW_STATUS.UNAVAILABLE,
                reason: `Dry run failed: ${err?.message || err}`,
            };
        } finally {
            setActionsBusy(container, false);
        }

        dryRunReports.set(container, report);
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

        setActionsBusy(container, true);
        setStatus("Scanning every registered collection…");

        let backup = null;
        try {
            backup = await deps.runBackup({
                onProgress: ({ done, total }) => {
                    setStatus(`Scanning every registered collection… (${done}/${total})`);
                },
                // Large libraries take several event-loop turns to serialize;
                // the status line proves the download is still progressing.
                onEncode: ({ done, total }) => {
                    setStatus(`Writing the backup file… (${done}/${total})`);
                },
            });

            if (backup?.status !== VIEW_STATUS.MEASURED) {
                setStatus(backup?.reason || "The backup could not be built.");
                return;
            }

            const saved = (deps.saveFile || downloadJsonFile)(backup.filename, backup.text);
            if (saved === false) throw new Error("this browser cannot save files");
        } catch (err) {
            setStatus(`Backup failed: ${err?.message || err}`);
            return;
        } finally {
            setActionsBusy(container, false);
        }

        // The file exists from here on: nothing below may report it as failed.
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
 * Builds the block's markup from the view model, the last dry-run report and
 * the last backup status line.
 * @param {object} view View model from buildStorageHealth()
 * @param {object|null} [report] Dry-run report view model, if one has run.
 * @param {string} [backupStatus] Last backup status line, if an action has run.
 * @param {boolean} [scanBusy] Whether a collection scan is in flight right now.
 * @returns {string} HTML
 */
function storageHealthHtml(view, report = null, backupStatus = "", scanBusy = false) {
    const head = `
        <div class="vectfox-size-health-head">
            <h4>Storage health</h4>
            <div class="vectfox-size-health-actions">
                <button id="vectfox_size_dry_run" class="vectfox-btn-sm" ${scanBusy ? "disabled" : ""}>${icons.listChecks(14)} Dry run</button>
                <button id="vectfox_size_backup_download" class="vectfox-btn-sm" ${scanBusy ? "disabled" : ""}>${icons.download(14)} Download backup</button>
                <button id="vectfox_size_health_refresh" class="vectfox-btn-sm">${icons.refreshCw(14)} Re-measure</button>
            </div>
        </div>
        <div id="vectfox_size_dry_run_status" class="vectfox-size-health-status"></div>
        <div id="vectfox_size_backup_status" class="vectfox-size-health-status">${StringUtils.escapeHtml(backupStatus)}</div>
    `;

    const reportBlock = `
        <div id="vectfox_size_dry_run_report" class="vectfox-size-health-report">
            ${dryRunReportHtml(report)}
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
