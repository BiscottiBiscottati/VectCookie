/**
 * ============================================================================
 * USAGE PANEL
 * ============================================================================
 * View model plus rendering for the Usage settings tab.
 *
 * The view model is pure so the numbers and labels are tested directly; the
 * DOM shell is covered by one jsdom smoke test.
 * ============================================================================
 */

import StringUtils from '../utils/string-utils.js';

const EMPTY_OFF =
    'Tracking is off. Turn on "Track token usage" to start measuring provider-reported tokens and caching.';
const EMPTY_ON =
    'Tracking is on. Send a message and the next chat-completion request will appear here.';
const PLACEHOLDER = '—';
const NUMBER_FORMAT = new Intl.NumberFormat('en-US');
const SOURCE_LABELS = {
    measured: 'measured',
    estimated: 'estimated',
    unavailable: 'unavailable',
};

/**
 * Turns ledger records into the labels the tab renders.
 *
 * @param {object} [options]
 * @param {object[]} [options.records] Newest-first records for the active chat.
 * @param {boolean} [options.trackingEnabled] Whether the observer is capturing.
 * @returns {{empty: boolean, emptyMessage: string, trackingEnabled: boolean, rows: object[]}}
 */
export function buildUsageView({ records = [], trackingEnabled = false } = {}) {
    return {
        trackingEnabled,
        empty: records.length === 0,
        emptyMessage: trackingEnabled ? EMPTY_ON : EMPTY_OFF,
        rows: records.map(buildRow),
    };
}

function buildRow(record) {
    return {
        recordId: record.recordId,
        timeLabel: formatTime(record.timestamp),
        providerModel: `${record.provider ?? 'unknown'} / ${record.model ?? 'unknown'}`,
        promptLabel: formatCount(record.promptTokens),
        hitLabel: formatCount(record.hitTokens),
        missLabel: formatCount(record.missTokens),
        totalLabel: formatCount(record.totalTokens),
        sourceLabel: SOURCE_LABELS[record.usageSource] ?? SOURCE_LABELS.unavailable,
    };
}

function formatCount(value) {
    return Number.isFinite(value) ? NUMBER_FORMAT.format(value) : PLACEHOLDER;
}

function formatTime(timestamp) {
    if (!Number.isFinite(timestamp)) return PLACEHOLDER;
    const date = new Date(timestamp);
    const pad = (part) => String(part).padStart(2, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Mounts the Usage panel into its placeholder and keeps it in sync.
 *
 * @param {object} [options]
 * @param {object} [options.settings] VectFox settings object.
 * @param {{recordsFor: (chatId: string|null) => object[]}} [options.ledger]
 * @param {() => (string|null)} [options.getChatId]
 * @param {(enabled: boolean) => void} [options.onTrackingChange] Persists the
 *   toggle and installs the observer when it turns on.
 * @returns {() => void} Refresh callback.
 */
export function initializeUsagePanel({
    settings = {},
    ledger,
    getChatId = () => null,
    onTrackingChange,
} = {}) {
    const container = document.getElementById('VectFox_usage_panel');
    if (!container) return () => {};

    const refresh = () => {
        const records = ledger?.recordsFor?.(getChatId()) ?? [];
        container.innerHTML = renderPanel(buildUsageView({
            records,
            trackingEnabled: !!settings.usage_tracking_enabled,
        }));
    };

    if (container.dataset.usagePanelBound !== '1') {
        container.addEventListener('change', (event) => {
            const toggle = event.target;
            if (toggle?.id !== 'VectFox_usage_tracking_enabled') return;
            const enabled = !!toggle.checked;
            settings.usage_tracking_enabled = enabled;
            onTrackingChange?.(enabled);
            refresh();
        });
        container.dataset.usagePanelBound = '1';
    }

    refresh();
    return refresh;
}

function renderPanel(view) {
    return `
        <div class="vectfox-usage-panel">
            <div class="vectfox-form-group">
                <label class="checkbox_label" for="VectFox_usage_tracking_enabled">
                    <input type="checkbox" id="VectFox_usage_tracking_enabled" ${view.trackingEnabled ? 'checked' : ''} />
                    <span><b>Track token usage</b></span>
                </label>
                <small class="VectFox_hint">
                    Off by default. When on, VectFox reads the provider-reported usage from
                    chat-completion responses made by this browser. It never changes a request,
                    a prompt or a response, stores no prompt text and no API keys, and makes no
                    network calls of its own.
                </small>
            </div>
            ${view.empty ? renderEmpty(view) : renderTable(view.rows)}
        </div>
    `;
}

function renderEmpty(view) {
    return `<div class="vectfox-usage-empty">${StringUtils.escapeHtml(view.emptyMessage)}</div>`;
}

function renderTable(rows) {
    const body = rows.map((row) => `
        <tr>
            <td class="vectfox-usage-time">${StringUtils.escapeHtml(row.timeLabel)}</td>
            <td class="vectfox-usage-model">${StringUtils.escapeHtml(row.providerModel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.promptLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.hitLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.missLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.totalLabel)}</td>
            <td><span class="vectfox-usage-source vectfox-usage-source-${StringUtils.escapeHtml(row.sourceLabel)}">${StringUtils.escapeHtml(row.sourceLabel)}</span></td>
        </tr>
    `).join('');

    return `
        <div class="vectfox-usage-table-wrap">
            <table class="vectfox-usage-table">
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Provider / model</th>
                        <th class="num">Prompt</th>
                        <th class="num">Hit</th>
                        <th class="num">Miss</th>
                        <th class="num">Total</th>
                        <th>Source</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        </div>
    `;
}
