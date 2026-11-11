/**
 * ============================================================================
 * VECTFOX STORAGE HEALTH PANEL
 * ============================================================================
 * Renders the Size Inspector's storage-health block: the serialized extension
 * settings size, the top contributing keys, the chunk-metadata entry count, the
 * over-limit warning (ADR-0003), and the dry run that reports how many entries
 * the staged migration would consider redundant, patchable or orphaned.
 *
 * Opening the block costs one in-memory serialization of the settings object:
 * the dry run is an explicit button, and nothing imported here talks to the
 * plugin, Qdrant or the collection loader. The runner is injected, so a tab that
 * is merely opened can neither start a scan nor issue a request —
 * tests/size-inspector.test.js holds that line.
 * ============================================================================
 */

import { buildStorageHealth } from "../core/storage-health.js";
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
 * @returns {object|null} The view model rendered, or null without a mount point.
 */
export function renderStorageHealthPanel(container, getSettings, { runDryRun } = {}) {
    if (!container) return null;

    const view = buildStorageHealth(getSettings?.());
    const report = dryRunReports.get(container) || null;
    container.innerHTML = storageHealthHtml(view, report);

    const refreshButton = container.querySelector("#vectfox_size_health_refresh");
    if (refreshButton) {
        refreshButton.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            renderStorageHealthPanel(container, getSettings, { runDryRun });
        };
    }
    bindDryRun(container, getSettings, { runDryRun });
    return view;
}

/**
 * Wires the dry-run action. Deliberately the only place in this module that may
 * cause a request, and only on a click.
 */
function bindDryRun(container, getSettings, deps) {
    const button = container.querySelector("#vectfox_size_dry_run");
    const status = container.querySelector("#vectfox_size_dry_run_status");
    if (!button || !status) return;

    button.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof deps.runDryRun !== "function") {
            status.textContent = "The dry run is not available in this build.";
            return;
        }

        button.disabled = true;
        status.textContent = "Scanning every registered collection…";
        let report;
        try {
            report = await deps.runDryRun({
                onProgress: ({ done, total }) => {
                    status.textContent = `Scanning every registered collection… (${done}/${total})`;
                },
            });
        } catch (err) {
            report = {
                status: VIEW_STATUS.UNAVAILABLE,
                reason: `Dry run failed: ${err?.message || err}`,
            };
        }

        dryRunReports.set(container, report);
        renderStorageHealthPanel(container, getSettings, deps);
    };
}

/**
 * Builds the block's markup from the view model and the last dry-run report.
 * @param {object} view View model from buildStorageHealth()
 * @param {object|null} [report] Dry-run report view model, if one has run.
 * @returns {string} HTML
 */
function storageHealthHtml(view, report = null) {
    const head = `
        <div class="vectfox-size-health-head">
            <h4>Storage health</h4>
            <div class="vectfox-size-health-actions">
                <button id="vectfox_size_dry_run" class="vectfox-btn-sm">${icons.listChecks(14)} Dry run</button>
                <button id="vectfox_size_health_refresh" class="vectfox-btn-sm">${icons.refreshCw(14)} Re-measure</button>
            </div>
        </div>
        <div id="vectfox_size_dry_run_status" class="vectfox-size-health-status"></div>
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
                <span class="vectfox-size-health-detail">${StringUtils.escapeHtml(entryCountLabel(view.chunkMeta.countLabel, view.chunkMeta.count))}</span>
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
 * Count label for the chunk-metadata cell: "1 entry", "0 entries", "1,200 entries".
 * @param {string} countLabel Thousands-grouped count from the view model.
 * @param {number} count
 * @returns {string}
 */
function entryCountLabel(countLabel, count) {
    return count === 1 ? "1 entry" : `${countLabel} entries`;
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
