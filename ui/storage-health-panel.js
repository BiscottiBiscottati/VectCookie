/**
 * ============================================================================
 * VECTFOX STORAGE HEALTH PANEL
 * ============================================================================
 * Renders the Size Inspector's storage-health block: the serialized extension
 * settings size, the top contributing keys, the chunk-metadata entry count and
 * the over-limit warning (ADR-0003).
 *
 * The block exists so the problem can be seen on the screen users already open
 * to diagnose bloat, rather than discovered through a slow tunnel. What it costs
 * is one in-memory serialization of the settings object: nothing imported here
 * talks to the plugin, Qdrant or the collection loader, so opening the tab can
 * neither start a scan nor issue a request — tests/size-inspector.test.js holds
 * that line.
 * ============================================================================
 */

import { buildStorageHealth } from "../core/storage-health.js";
import { icons } from "./icons.js";
import StringUtils from "../utils/string-utils.js";

/**
 * Renders the storage-health block into `container`, replacing whatever was
 * there. `getSettings` is called on every render, so reopening the tab or
 * pressing Re-measure reads the current settings rather than a snapshot taken
 * when the tab first opened.
 * @param {HTMLElement|null} container Mount point for the block.
 * @param {function(): (object|null|undefined)} getSettings Returns the extension
 *     settings object (`extension_settings.vectfox`) to measure.
 * @returns {object|null} The view model rendered, or null without a mount point.
 */
export function renderStorageHealthPanel(container, getSettings) {
    if (!container) return null;

    const view = buildStorageHealth(getSettings?.());
    container.innerHTML = storageHealthHtml(view);

    const refreshButton = container.querySelector("#vectfox_size_health_refresh");
    if (refreshButton) {
        refreshButton.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            renderStorageHealthPanel(container, getSettings);
        };
    }
    return view;
}

/**
 * Builds the block's markup from the view model.
 * @param {object} view View model from buildStorageHealth()
 * @returns {string} HTML
 */
function storageHealthHtml(view) {
    const head = `
        <div class="vectfox-size-health-head">
            <h4>Storage health</h4>
            <button id="vectfox_size_health_refresh" class="vectfox-btn-sm">${icons.refreshCw(14)} Re-measure</button>
        </div>
    `;

    if (view.status !== "measured") {
        return `${head}<div class="vectfox-size-health-status">${StringUtils.escapeHtml(view.reason || "")}</div>`;
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
    `;
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
