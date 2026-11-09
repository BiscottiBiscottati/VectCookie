/**
 * ============================================================================
 * USAGE PANEL
 * ============================================================================
 * View model plus rendering for the Usage settings tab.
 *
 * The view model is pure so the numbers and labels are tested directly; the
 * DOM shell is covered by thin jsdom smoke tests.
 * ============================================================================
 */

import StringUtils from '../utils/string-utils.js';
import {
    createDefaultUsagePrices,
    normalizeUsagePrices,
    resolveUsageCost,
    summarizeByOrigin,
} from '../core/usage-stats.js';

const EMPTY_OFF =
    'Tracking is off. Turn on "Track token usage" to start measuring provider-reported tokens and caching.';
const EMPTY_ON =
    'Tracking is on. Send a message and the next chat-completion request will appear here.';
const PLACEHOLDER = '—';
const NUMBER_FORMAT = new Intl.NumberFormat('en-US');
const PERCENT_FORMAT = new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
});
const COST_FORMATTERS = new Map();
const REPORTED_FORMAT = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
});
const SOURCE_LABELS = {
    measured: 'measured',
    estimated: 'estimated',
    unavailable: 'unavailable',
};
const ORIGIN_LABELS = {
    story: 'story',
    quiet: 'quiet',
    'worker-profile': 'worker',
    unknown: 'unknown',
};
const CARD_TITLES = {
    all: 'All requests',
    ...ORIGIN_LABELS,
    'vectfox-internal': 'VectFox · internal',
};

/**
 * Turns ledger records into the labels the tab renders.
 *
 * @param {object} [options]
 * @param {object[]} [options.records] Newest-first records for the active chat.
 * @param {boolean} [options.trackingEnabled] Whether the observer is capturing.
 * @param {object|null} [options.health] Observer health counters, when installed.
 * @param {object|null} [options.prices] Editable price table.
 * @returns {{empty: boolean, emptyMessage: string, trackingEnabled: boolean, health: object, cards: object[], rows: object[], prices: object}}
 */
export function buildUsageView({ records = [], trackingEnabled = false, health = null, prices = null } = {}) {
    const priceTable = normalizeUsagePrices(prices ?? createDefaultUsagePrices());
    const { combined, origins } = summarizeByOrigin(records, { prices: priceTable });

    return {
        trackingEnabled,
        health: describeObserverHealth({ trackingEnabled, health }),
        empty: records.length === 0,
        emptyMessage: trackingEnabled ? EMPTY_ON : EMPTY_OFF,
        cards: [
            buildCard('all', combined, priceTable),
            ...origins.map((summary) => buildCard(summary.origin, summary, priceTable)),
        ],
        rows: records.map((record) => buildRow(record, priceTable)),
        prices: priceTable,
    };
}

/**
 * Separates "tracking is off", "observer installed but nothing captured yet"
 * and "the observer is failing", so an empty table is never ambiguous.
 *
 * @param {{trackingEnabled: boolean, health: object|null}} options
 * @returns {{state: string, label: string}}
 */
export function describeObserverHealth({ trackingEnabled = false, health = null } = {}) {
    if (!trackingEnabled) {
        return { state: 'off', label: 'Tracking is off — the observer is not installed.' };
    }
    if (!health) {
        return { state: 'not-installed', label: 'Tracking is on, but the observer is not installed yet.' };
    }

    const skippedCount = Number(health.skipped) || 0;
    const skipped = skippedCount > 0
        ? `, ${skippedCount} request${skippedCount === 1 ? '' : 's'} skipped`
        : '';
    const errorCount = Number(health.errors) || 0;
    if (errorCount > 0) {
        return {
            state: 'error',
            label: `Observer error — ${errorCount} capture attempt${errorCount === 1 ? '' : 's'} failed${skipped}. Rows may be missing.`,
        };
    }

    const captured = Number(health.captured) || 0;
    if (captured === 0) {
        return { state: 'idle', label: `Observer installed — no requests captured yet${skipped}.` };
    }
    return {
        state: 'ok',
        label: `Observer installed — ${captured} request${captured === 1 ? '' : 's'} captured${skipped}.`,
    };
}

function buildCard(scope, summary, prices) {
    const estimatedPrompt = Number(summary.estimatedPromptTokens) || 0;
    const hasTokenCounts = summary.promptTokens != null || estimatedPrompt > 0;
    const promptSource = hasTokenCounts
        ? (estimatedPrompt > 0 ? 'estimated' : 'measured')
        : 'unavailable';
    const coverageSource = summary.coverage == null || !hasTokenCounts
        ? 'unavailable'
        : (estimatedPrompt > 0 || summary.unavailableRequests > 0 ? 'estimated' : 'measured');
    const requests = Number(summary.requests) || 0;

    return {
        scope,
        title: CARD_TITLES[scope] ?? scope,
        requestsLabel: `${NUMBER_FORMAT.format(requests)} request${requests === 1 ? '' : 's'}`,
        promptLabel: formatCardPrompt(summary),
        promptSource,
        hitLabel: formatCount(summary.hitTokens),
        hitSource: summary.hitTokens == null ? 'unavailable' : 'measured',
        hitRateLabel: formatPercent(summary.hitRate),
        hitRateSource: summary.hitRate == null ? 'unavailable' : 'measured',
        hitRateNote: formatHitRateNote(summary),
        coverageLabel: formatPercent(summary.coverage),
        coverageSource,
        costLabel: formatCost(summary.cost, prices.currency, summary.costSource),
        costSource: SOURCE_LABELS[summary.costSource] ?? SOURCE_LABELS.unavailable,
        savingLabel: formatCost(summary.saving, prices.currency, summary.savingSource),
        savingSource: SOURCE_LABELS[summary.savingSource] ?? SOURCE_LABELS.unavailable,
    };
}

function buildRow(record, prices) {
    const cost = resolveUsageCost(record, prices);
    const measuredPrompt = Number.isFinite(record.promptTokens) ? record.promptTokens : null;
    const estimatedPrompt = Number.isFinite(record.estimatedPromptTokens) ? record.estimatedPromptTokens : null;
    const prompt = measuredPrompt ?? estimatedPrompt;

    return {
        recordId: record.recordId,
        timeLabel: formatTime(record.timestamp),
        originLabel: formatOrigin(record),
        providerModel: `${record.provider ?? 'unknown'} / ${record.model ?? 'unknown'}`,
        promptLabel: prompt == null
            ? PLACEHOLDER
            : `${measuredPrompt == null ? '~' : ''}${formatCount(prompt)}`,
        hitLabel: formatCount(record.hitTokens),
        hitRateLabel: formatHitRate(record),
        missLabel: formatCount(record.missTokens),
        totalLabel: formatCount(record.totalTokens),
        costLabel: formatCost(cost.cost, prices.currency, cost.costSource),
        costSource: SOURCE_LABELS[cost.costSource] ?? SOURCE_LABELS.unavailable,
        savingLabel: formatCost(cost.saving, prices.currency, cost.savingSource),
        savingSource: SOURCE_LABELS[cost.savingSource] ?? SOURCE_LABELS.unavailable,
        sourceLabel: SOURCE_LABELS[record.usageSource] ?? SOURCE_LABELS.unavailable,
    };
}

function formatOrigin(record) {
    if (record.origin === 'vectfox-internal') {
        return `VectFox · ${record.featureLabel || 'internal'}`;
    }
    return ORIGIN_LABELS[record.origin] ?? ORIGIN_LABELS.unknown;
}

function formatHitRateNote(summary) {
    const promptTokens = Number(summary.promptTokens) || 0;
    const ratedPromptTokens = Number(summary.ratedPromptTokens) || 0;
    if (ratedPromptTokens > 0 && ratedPromptTokens < promptTokens) {
        return `${NUMBER_FORMAT.format(ratedPromptTokens)} of ${NUMBER_FORMAT.format(promptTokens)} prompt tokens`;
    }
    return '';
}

function formatCardPrompt(summary) {
    const measured = summary.promptTokens;
    const estimated = summary.estimatedPromptTokens;
    if (measured == null && estimated == null) return PLACEHOLDER;
    if (measured == null) return `~${formatCount(estimated)}`;
    if (estimated != null) return `${formatCount(measured)} + ~${formatCount(estimated)}`;
    return formatCount(measured);
}

function formatHitRate(record) {
    if (!Number.isFinite(record.promptTokens) || !Number.isFinite(record.hitTokens) || record.promptTokens <= 0) {
        return PLACEHOLDER;
    }
    return formatPercent(record.hitTokens / record.promptTokens);
}

function formatPercent(value) {
    return Number.isFinite(value) ? PERCENT_FORMAT.format(value) : PLACEHOLDER;
}

function formatCost(value, currency, source = 'estimated') {
    if (!Number.isFinite(value)) return PLACEHOLDER;
    // A provider-reported cost is shown as reported, never converted into the
    // price table's currency: OpenRouter reports credits, not USD.
    if (source === 'measured') return `${REPORTED_FORMAT.format(value)} reported`;
    const digits = value !== 0 && Math.abs(value) < 0.01 ? 8 : 2;
    const code = currency || 'USD';
    const key = `${code}:${digits}`;
    try {
        if (!COST_FORMATTERS.has(key)) {
            COST_FORMATTERS.set(key, new Intl.NumberFormat('en-US', {
                style: 'currency',
                currency: code,
                minimumFractionDigits: digits,
                maximumFractionDigits: digits,
            }));
        }
        return COST_FORMATTERS.get(key).format(value);
    } catch {
        return `${NUMBER_FORMAT.format(value)} ${code}`;
    }
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
 * @param {() => (object|null)} [options.getHealth] Observer health counters.
 * @param {(enabled: boolean) => void} [options.onTrackingChange] Persists the
 *   toggle and installs the observer when it turns on.
 * @param {(prices: object) => void} [options.onPricesChange] Persists the
 *   edited price table.
 * @returns {() => void} Refresh callback.
 */
export function initializeUsagePanel({
    settings = {},
    ledger,
    getChatId = () => null,
    getHealth = () => null,
    onTrackingChange,
    onPricesChange,
} = {}) {
    const container = document.getElementById('VectFox_usage_panel');
    if (!container) return () => {};

    const ensurePrices = () => {
        settings.usage_prices = normalizeUsagePrices(settings.usage_prices ?? createDefaultUsagePrices());
        return settings.usage_prices;
    };
    ensurePrices();

    const buildView = () => buildUsageView({
        records: ledger?.recordsFor?.(getChatId()) ?? [],
        trackingEnabled: !!settings.usage_tracking_enabled,
        health: getHealth?.() ?? null,
        prices: settings.usage_prices,
    });
    const refresh = () => {
        container.innerHTML = renderPanel(buildView());
    };
    // Price edits only change the computed results, so update those in place:
    // replacing the whole panel would steal focus from the next price field.
    const refreshResults = () => {
        const results = container.querySelector('.vectfox-usage-results');
        if (!results) {
            refresh();
            return;
        }
        const view = buildView();
        results.innerHTML = view.empty
            ? renderEmpty(view)
            : `${renderCards(view.cards)}${renderTable(view.rows)}`;
    };

    if (container.dataset.usagePanelBound !== '1') {
        container.addEventListener('change', (event) => {
            const target = event.target;
            if (target?.id === 'VectFox_usage_tracking_enabled') {
                const enabled = !!target.checked;
                settings.usage_tracking_enabled = enabled;
                onTrackingChange?.(enabled);
                refresh();
                return;
            }
            if (!target?.dataset) return;

            if (target.dataset.usagePriceMeta) {
                ensurePrices()[target.dataset.usagePriceMeta] = target.value;
                onPricesChange?.(settings.usage_prices);
                refreshResults();
                return;
            }

            const index = Number(target.dataset.usagePriceIndex);
            const field = target.dataset.usagePriceField;
            if (!Number.isInteger(index) || !field) return;
            const entry = ensurePrices().entries[index];
            if (!entry) return;
            entry[field] = field === 'provider' || field === 'model'
                ? target.value
                : parsePriceInput(target.value);
            onPricesChange?.(settings.usage_prices);
            refreshResults();
        });

        container.addEventListener('click', (event) => {
            const target = event.target;
            if (target?.closest?.('[data-usage-price-add]')) {
                ensurePrices().entries.push({ provider: '', model: '', hit: null, miss: null, output: null, cacheWrite: null });
                onPricesChange?.(settings.usage_prices);
                refresh();
                return;
            }
            const remove = target?.closest?.('[data-usage-price-remove]');
            if (!remove) return;
            const index = Number(remove.dataset.usagePriceRemove);
            if (!Number.isInteger(index)) return;
            ensurePrices().entries.splice(index, 1);
            onPricesChange?.(settings.usage_prices);
            refresh();
        });

        container.dataset.usagePanelBound = '1';
    }

    refresh();
    return refresh;
}

function parsePriceInput(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
            <div class="vectfox-usage-health vectfox-usage-health-${StringUtils.escapeHtml(view.health.state)}" role="status">
                ${StringUtils.escapeHtml(view.health.label)}
            </div>
            <div class="vectfox-usage-results">
                ${view.empty ? renderEmpty(view) : `${renderCards(view.cards)}${renderTable(view.rows)}`}
            </div>
            ${renderPriceEditor(view.prices)}
        </div>
    `;
}

function renderCards(cards) {
    return `<div class="vectfox-usage-cards">${cards.map(renderCard).join('')}</div>`;
}

function renderCard(card) {
    return `
        <section class="vectfox-usage-card" data-usage-card="${StringUtils.escapeHtml(card.scope)}">
            <header class="vectfox-usage-card-header">
                <h4>${StringUtils.escapeHtml(card.title)}</h4>
                <span>${StringUtils.escapeHtml(card.requestsLabel)}</span>
            </header>
            <dl class="vectfox-usage-card-metrics">
                ${renderMetric('prompt', 'Prompt', card.promptLabel, card.promptSource)}
                ${renderMetric('hit', 'Hit', card.hitLabel, card.hitSource)}
                ${renderMetric('hitRate', 'Hit %', card.hitRateLabel, card.hitRateSource, card.hitRateNote)}
                ${renderMetric('coverage', 'Coverage', card.coverageLabel, card.coverageSource)}
                ${renderMetric('cost', 'Cost', card.costLabel, card.costSource)}
                ${renderMetric('saving', 'Saving', card.savingLabel, card.savingSource)}
            </dl>
        </section>
    `;
}

function renderMetric(key, label, value, source, note = '') {
    const safeSource = StringUtils.escapeHtml(source);
    const safeNote = note ? `<small class="vectfox-usage-metric-note">${StringUtils.escapeHtml(note)}</small>` : '';
    return `
        <div class="vectfox-usage-metric">
            <dt>${StringUtils.escapeHtml(label)}</dt>
            <dd data-usage-metric="${StringUtils.escapeHtml(key)}">
                ${StringUtils.escapeHtml(value)}
                <small class="vectfox-usage-source-${safeSource}">${safeSource}</small>
                ${safeNote}
            </dd>
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
            <td class="vectfox-usage-origin">${StringUtils.escapeHtml(row.originLabel)}</td>
            <td class="vectfox-usage-model">${StringUtils.escapeHtml(row.providerModel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.promptLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.hitLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.hitRateLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.missLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.totalLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.costLabel)} <small class="vectfox-usage-source-${StringUtils.escapeHtml(row.costSource)}">${StringUtils.escapeHtml(row.costSource)}</small></td>
            <td class="num">${StringUtils.escapeHtml(row.savingLabel)} <small class="vectfox-usage-source-${StringUtils.escapeHtml(row.savingSource)}">${StringUtils.escapeHtml(row.savingSource)}</small></td>
            <td><span class="vectfox-usage-source vectfox-usage-source-${StringUtils.escapeHtml(row.sourceLabel)}">${StringUtils.escapeHtml(row.sourceLabel)}</span></td>
        </tr>
    `).join('');

    return `
        <div class="vectfox-usage-table-wrap">
            <table class="vectfox-usage-table vectfox-usage-requests-table">
                <thead>
                    <tr>
                        <th>Time</th>
                        <th>Origin</th>
                        <th>Provider / model</th>
                        <th class="num">Prompt</th>
                        <th class="num">Hit</th>
                        <th class="num">Hit %</th>
                        <th class="num">Miss</th>
                        <th class="num">Total</th>
                        <th class="num">Cost</th>
                        <th class="num">Saving</th>
                        <th>Source</th>
                    </tr>
                </thead>
                <tbody>${body}</tbody>
            </table>
        </div>
    `;
}

function renderPriceEditor(prices) {
    const rows = prices.entries.map((entry, index) => `
        <tr>
            <td><input type="text" class="text_pole" data-usage-price-index="${index}" data-usage-price-field="provider" value="${StringUtils.escapeHtml(entry.provider)}" /></td>
            <td><input type="text" class="text_pole" data-usage-price-index="${index}" data-usage-price-field="model" value="${StringUtils.escapeHtml(entry.model)}" /></td>
            ${renderPriceInput(index, 'hit', entry.hit)}
            ${renderPriceInput(index, 'miss', entry.miss)}
            ${renderPriceInput(index, 'output', entry.output)}
            ${renderPriceInput(index, 'cacheWrite', entry.cacheWrite)}
            <td><button type="button" class="menu_button" data-usage-price-remove="${index}">Remove</button></td>
        </tr>
    `).join('');

    return `
        <section class="vectfox-usage-prices">
            <h4>Price table</h4>
            <small class="VectFox_hint">
                Prices are per million tokens. They are used only when the provider does not report
                its own cost or cache discount. Output is part of cost but never part of saving.
                OpenRouter costs are shown as reported credits and are not converted.
            </small>
            <div class="vectfox-usage-price-meta">
                <label>Currency <input type="text" class="text_pole" data-usage-price-meta="currency" value="${StringUtils.escapeHtml(prices.currency)}" /></label>
                <label>Prices updated <input type="text" class="text_pole" data-usage-price-meta="updated" value="${StringUtils.escapeHtml(prices.updated)}" /></label>
            </div>
            <div class="vectfox-usage-table-wrap">
                <table class="vectfox-usage-table vectfox-usage-price-table">
                    <thead>
                        <tr>
                            <th>Provider</th>
                            <th>Model</th>
                            <th class="num">Hit</th>
                            <th class="num">Miss</th>
                            <th class="num">Output</th>
                            <th class="num">Cache write</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <button type="button" class="menu_button" data-usage-price-add>Add price row</button>
        </section>
    `;
}

function renderPriceInput(index, field, value) {
    return `<td class="num"><input type="number" min="0" step="any" class="text_pole" data-usage-price-index="${index}" data-usage-price-field="${field}" value="${Number.isFinite(value) ? value : ''}" /></td>`;
}
