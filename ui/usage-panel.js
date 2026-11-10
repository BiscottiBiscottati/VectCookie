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
    summarizeAccumulator,
    summarizeByConfiguration,
    summarizeByOrigin,
} from '../core/usage-stats.js';

const EMPTY_OFF =
    'Tracking is off. Turn on "Track token usage" to start measuring provider-reported tokens and caching.';
const EMPTY_ON =
    'Tracking is on. Send a message and the next chat-completion request will appear here.';
const EMPTY_RUN = 'No requests in this measurement run yet.';
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
 * The optional run filter narrows every results surface (cards, configuration
 * comparison and rows) to one measurement run while the run bar still lists
 * every old run. Archived counters keep the cards counting after the 500-row
 * cap has evicted a row; a run filter cannot attribute those rows to a run, so
 * it falls back to the retained rows.
 *
 * @param {object} [options]
 * @param {object[]} [options.records] Newest-first records for the active chat.
 * @param {boolean} [options.trackingEnabled] Whether the observer is capturing.
 * @param {object|null} [options.health] Observer health counters, when installed.
 * @param {object|null} [options.prices] Editable price table.
 * @param {object[]} [options.runs] Newest-first measurement-run markers.
 * @param {string} [options.currentRunId] Run id owned by the ledger.
 * @param {string} [options.selectedRunId] Run to show; '' means all runs.
 * @param {object|null} [options.archived] Counters of the rows the cap evicted.
 * @param {object|null} [options.allTime] All-time counters and chat count.
 * @param {object|null} [options.retention] Retained/total row counts for the cap note.
 * @returns {{empty: boolean, emptyMessage: string, trackingEnabled: boolean, health: object, run: object, cards: object[], configurations: object[], rows: object[], prices: object, retention: object|null, allTime: object|null}}
 */
export function buildUsageView({
    records = [],
    trackingEnabled = false,
    health = null,
    prices = null,
    runs = [],
    currentRunId = '',
    selectedRunId = '',
    archived = null,
    allTime = null,
    retention = null,
} = {}) {
    const priceTable = normalizeUsagePrices(prices ?? createDefaultUsagePrices());
    const allRecords = Array.isArray(records) ? records : [];
    const runList = (Array.isArray(runs) ? runs : [])
        .filter((run) => run && typeof run.runId === 'string' && run.runId);
    const selected = typeof selectedRunId === 'string' ? selectedRunId : '';
    const current = typeof currentRunId === 'string' ? currentRunId : '';
    const visibleRecords = selected
        ? allRecords.filter((record) => record?.runId === selected)
        : allRecords;
    // Evicted rows span runs and chats, so a single-run view cannot include
    // them without lying about which run they belong to.
    const archivedCounters = selected ? null : archived;
    const { combined, origins } = summarizeByOrigin(visibleRecords, {
        prices: priceTable,
        archived: archivedCounters,
    });
    const configurations = summarizeByConfiguration(visibleRecords, {
        prices: priceTable,
        archived: archivedCounters,
    }).map((entry) => buildConfigurationRow(entry, priceTable));
    const retentionNote = buildRetention(retention, { selectedRunId: selected });

    return {
        trackingEnabled,
        health: describeObserverHealth({ trackingEnabled, health }),
        empty: visibleRecords.length === 0,
        emptyMessage: describeEmpty({ trackingEnabled, selectedRunId: selected, allRecords }),
        run: buildRunBar({ runs: runList, records: allRecords, currentRunId: current, selectedRunId: selected }),
        cards: [
            buildCard('all', combined, priceTable),
            ...origins.map((summary) => buildCard(summary.origin, summary, priceTable)),
        ],
        configurations,
        rows: visibleRecords.map((record) => buildRow(record, priceTable)),
        prices: priceTable,
        retention: retentionNote,
        allTime: buildAllTime(allTime, priceTable),
    };
}

function buildRetention(retention, { selectedRunId = '' } = {}) {
    if (!retention || !Number.isFinite(retention.limit) || !Number.isFinite(retention.retained)) return null;
    const limit = Math.max(0, Math.floor(retention.limit));
    const retained = Math.max(0, Math.floor(retention.retained));
    const total = Math.max(retained, Math.floor(Number(retention.total) || 0));
    const capped = total > retained;
    // Under a run filter the cards and table use retained rows only, so the
    // all-record counters must not be claimed as the totals above.
    if (selectedRunId) {
        return {
            limit,
            retained,
            total,
            capped: false,
            // Archived counters cannot be attributed to a run, so this view
            // cannot include rows the cap evicted. Say so instead of letting
            // the comparison look complete.
            label: `Showing this measurement run only; records the ${formatCount(limit)}-record cap evicted are not included. Each chat keeps its newest ${formatCount(limit)} records.`,
        };
    }
    // `total` counts every retained/evicted record, including failed and
    // aborted attempts, while the cards count completed requests only.
    const label = capped
        ? `Showing the newest ${formatCount(limit)} of ${formatCount(total)} records. Request totals above exclude failed and aborted rows.`
        : `Showing all ${formatCount(total)} records. Each chat keeps its newest ${formatCount(limit)}.`;
    return { limit, retained, total, capped, label };
}

function buildAllTime(allTime, prices) {
    const totals = allTime?.totals;
    const chats = Math.max(0, Math.floor(Number(allTime?.chats) || 0));
    if (!totals || chats === 0) return null;
    const card = buildCard('all-time', summarizeAccumulator(totals), prices);
    return {
        ...card,
        title: 'All time · all chats',
        detailLabel: `${formatCountLabel(chats, 'chat')} · ${card.requestsLabel}`,
    };
}

function describeEmpty({ trackingEnabled, selectedRunId, allRecords }) {
    if (selectedRunId && allRecords.length > 0) return EMPTY_RUN;
    return trackingEnabled ? EMPTY_ON : EMPTY_OFF;
}

function buildRunBar({ runs, records, currentRunId, selectedRunId }) {
    const requestCounts = new Map();
    for (const record of records) {
        if (!record?.runId) continue;
        requestCounts.set(record.runId, (requestCounts.get(record.runId) ?? 0) + 1);
    }

    const current = runs.find((run) => run.runId === currentRunId) ?? null;
    return {
        currentRunId: current?.runId ?? '',
        currentLabel: current?.label ?? 'No measurement run',
        selectedRunId,
        options: [
            buildRunOption({
                runId: '',
                label: 'All runs',
                startedLabel: '',
                requestCount: records.length,
                selected: selectedRunId === '',
            }),
            ...runs.map((run) => buildRunOption({
                runId: run.runId,
                label: run.label || run.runId,
                startedLabel: formatLocalTime(run.startedAt, { includeDate: true }),
                requestCount: requestCounts.get(run.runId) ?? 0,
                selected: run.runId === selectedRunId,
            })),
        ],
    };
}

function buildRunOption({ runId, label, startedLabel, requestCount, selected }) {
    const detail = [
        startedLabel,
        formatCountLabel(requestCount, 'record'),
    ].filter(Boolean).join(' · ');
    return {
        runId,
        label,
        selected,
        optionLabel: `${label} · ${detail}`,
    };
}

function formatLocalTime(timestamp, { includeDate = false, includeSeconds = false } = {}) {
    if (!Number.isFinite(timestamp)) return '';
    const date = new Date(timestamp);
    const pad = (part) => String(part).padStart(2, '0');
    const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}${includeSeconds ? `:${pad(date.getSeconds())}` : ''}`;
    return includeDate ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}` : clock;
}

function buildConfigurationRow(entry, prices) {
    const requests = Number(entry.requests) || 0;
    return {
        key: entry.key,
        label: formatConfigurationLabel(entry.configuration),
        requestsLabel: formatRequests(requests),
        averagePromptLabel: entry.averagePromptTokens == null
            ? PLACEHOLDER
            : formatCount(Math.round(entry.averagePromptTokens)),
        averagePromptSource: entry.averagePromptSource ?? 'unavailable',
        hitRateLabel: formatPercent(entry.hitRate),
        hitRateSource: entry.hitRate == null ? 'unavailable' : 'measured',
        hitRateNote: formatHitRateNote(entry),
        costPerRequestLabel: formatCost(entry.costPerRequest, prices.currency, entry.costPerRequestSource),
        costPerRequestSource: usageSourceLabel(entry.costPerRequestSource),
        savingLabel: formatCost(entry.saving, prices.currency, entry.savingSource),
        savingSource: usageSourceLabel(entry.savingSource),
    };
}

function formatConfigurationLabel(configuration) {
    if (!configuration) return 'Configuration unknown';
    const state = configuration.ghostEnabled ? 'Ghosting on' : 'Ghosting off';
    const batch = Number.isFinite(configuration.ghostBatchSize)
        ? `batch ${configuration.ghostBatchSize}`
        : 'batch unknown';
    const keep = Number.isFinite(configuration.ghostKeepRecent)
        ? `keep ${configuration.ghostKeepRecent}`
        : 'keep unknown';
    return `${state} · ${batch} · ${keep}`;
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
        requestsLabel: formatRequests(requests),
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
        costSource: usageSourceLabel(summary.costSource),
        savingLabel: formatCost(summary.saving, prices.currency, summary.savingSource),
        savingSource: usageSourceLabel(summary.savingSource),
    };
}

function buildRow(record, prices) {
    const cost = resolveUsageCost(record, prices);
    const measuredPrompt = Number.isFinite(record.promptTokens) ? record.promptTokens : null;
    const estimatedPrompt = Number.isFinite(record.estimatedPromptTokens) ? record.estimatedPromptTokens : null;
    const prompt = measuredPrompt ?? estimatedPrompt;
    const sharedPrefix = Number.isFinite(record.sharedPrefixTokens) ? record.sharedPrefixTokens : null;

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
        costSource: usageSourceLabel(cost.costSource),
        savingLabel: formatCost(cost.saving, prices.currency, cost.savingSource),
        savingSource: usageSourceLabel(cost.savingSource),
        // Prefix tokens come from the tokenizer estimate, never from the
        // provider; the field is empty when there is no comparable prior
        // request or a matched message has no token count. The source label is
        // empty too, so the table cell has one availability signal.
        sharedPrefixLabel: formatCount(sharedPrefix),
        sharedPrefixSource: sharedPrefix == null ? '' : usageSourceLabel('estimated'),
        prefixBreakerLabel: record.possiblePrefixBreaker ? 'Possible prefix breaker' : '',
        sourceLabel: usageSourceLabel(record.usageSource),
    };
}

function formatOrigin(record) {
    if (record.origin === 'vectfox-internal') {
        return `VectFox · ${record.featureLabel || 'internal'}`;
    }
    return ORIGIN_LABELS[record.origin] ?? ORIGIN_LABELS.unknown;
}

function formatHitRateNote(summary) {
    // Estimated prompt tokens count as uncovered prompt, so a group with a
    // measured rate over part of its prompt must disclose the whole scope.
    const promptTokens = (Number(summary.promptTokens) || 0) + (Number(summary.estimatedPromptTokens) || 0);
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

function usageSourceLabel(source) {
    return SOURCE_LABELS[source] ?? SOURCE_LABELS.unavailable;
}

function formatRequests(count) {
    return formatCountLabel(count, 'request');
}

function formatCountLabel(count, noun) {
    return `${NUMBER_FORMAT.format(count)} ${noun}${count === 1 ? '' : 's'}`;
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
    return formatLocalTime(timestamp, { includeSeconds: true });
}

/**
 * Mounts the Usage panel into its placeholder and keeps it in sync.
 *
 * @param {object} [options]
 * @param {object} [options.settings] VectFox settings object.
 * @param {object} [options.ledger] Durable ledger. The panel reads records,
 *   runs, current run, archived counters, retention counts and all-time totals;
 *   it never writes to it.
 * @param {(chatId: string|null) => object[]} [options.ledger.recordsFor]
 * @param {(chatId: string|null) => object[]} [options.ledger.runsFor]
 * @param {(chatId: string|null) => (string|null)} [options.ledger.currentRunIdFor]
 * @param {(chatId: string|null) => object} [options.ledger.archivedFor]
 * @param {(chatId: string|null) => object} [options.ledger.retentionFor]
 * @param {() => object} [options.ledger.allTimeForView]
 * @param {() => (string|null)} [options.getChatId]
 * @param {() => (object|null)} [options.getHealth] Observer health counters.
 * @param {(enabled: boolean) => void} [options.onTrackingChange] Persists the
 *   toggle and installs the observer when it turns on.
 * @param {(prices: object) => void} [options.onPricesChange] Persists the
 *   edited price table.
 * @param {() => void} [options.onRunStart] Opens a new measurement run.
 * @returns {() => void} Refresh callback.
 */
export function initializeUsagePanel({
    settings = {},
    ledger,
    getChatId = () => null,
    getHealth = () => null,
    onTrackingChange,
    onPricesChange,
    onRunStart,
} = {}) {
    const container = document.getElementById('VectFox_usage_panel');
    if (!container) return () => {};

    const ensurePrices = () => {
        settings.usage_prices = normalizeUsagePrices(settings.usage_prices ?? createDefaultUsagePrices());
        return settings.usage_prices;
    };
    ensurePrices();

    // Run filter lives in the panel, not in settings: it is a view choice, not
    // a persisted preference, and '' means "show every run". Runs are per chat,
    // so a chat switch resets the filter instead of showing an empty table for
    // a run that belongs to the previous chat.
    let selectedRunId = '';
    let lastChatId = getChatId();
    const buildView = () => {
        const chatId = getChatId();
        if (chatId !== lastChatId) {
            lastChatId = chatId;
            selectedRunId = '';
        }
        return buildUsageView({
            records: ledger?.recordsFor?.(chatId) ?? [],
            trackingEnabled: !!settings.usage_tracking_enabled,
            health: getHealth?.() ?? null,
            prices: settings.usage_prices,
            runs: ledger?.runsFor?.(chatId) ?? [],
            currentRunId: ledger?.currentRunIdFor?.(chatId) ?? '',
            selectedRunId,
            archived: ledger?.archivedFor?.(chatId) ?? null,
            retention: ledger?.retentionFor?.(chatId) ?? null,
            allTime: ledger?.allTimeForView?.() ?? null,
        });
    };
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
        results.innerHTML = renderResults(buildView());
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
            if (target?.matches?.('[data-usage-run-select]')) {
                selectedRunId = target.value || '';
                // Filtering only changes the results: leave the select the
                // user just operated in place instead of rebuilding it.
                refreshResults();
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
            if (target?.closest?.('[data-usage-run-start]')) {
                onRunStart?.();
                // With a run filtered, point the table at the new run or its
                // first records would be invisible; under All runs the new
                // records already show.
                if (selectedRunId) {
                    selectedRunId = ledger?.currentRunIdFor?.(getChatId()) ?? selectedRunId;
                }
                refresh();
                return;
            }
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
            ${renderAllTime(view.allTime)}
            ${renderRunBar(view.run)}
            <div class="vectfox-usage-results">
                ${renderResults(view)}
            </div>
            ${renderPriceEditor(view.prices)}
        </div>
    `;
}

function renderRunBar(run) {
    const options = run.options.map((option) => (
        `<option value="${StringUtils.escapeHtml(option.runId)}" ${option.selected ? 'selected' : ''}>${StringUtils.escapeHtml(option.optionLabel)}</option>`
    )).join('');

    return `
        <div class="vectfox-usage-runs">
            <span class="vectfox-usage-run-current">
                Current run: <b>${StringUtils.escapeHtml(run.currentLabel)}</b>
            </span>
            <button type="button" class="menu_button" data-usage-run-start>Start new measurement</button>
            <label class="vectfox-usage-run-filter">
                Show
                <select class="text_pole" data-usage-run-select>${options}</select>
            </label>
            <small class="VectFox_hint">
                Starting a run keeps earlier runs available, so a batch-size change can be compared
                before and after without exporting. Requests captured before the first run stay
                under All runs.
            </small>
        </div>
    `;
}

function renderResults(view) {
    if (view.empty) return `${renderRetention(view.retention)}${renderEmpty(view)}`;
    return `${renderCards(view.cards)}${renderRetention(view.retention)}${renderConfigurationTable(view.configurations)}${renderTable(view.rows)}`;
}

function renderRetention(retention) {
    if (!retention) return '';
    return `<div class="vectfox-usage-retention" data-usage-retention>${StringUtils.escapeHtml(retention.label)}</div>`;
}

function renderAllTime(allTime) {
    if (!allTime) return '';
    return `<div class="vectfox-usage-alltime" data-usage-alltime>${renderCard(allTime, 'vectfox-usage-card-alltime')}</div>`;
}

function renderConfigurationTable(rows) {
    const body = rows.map((row) => `
        <tr data-usage-configuration="${StringUtils.escapeHtml(row.key)}">
            <td class="vectfox-usage-configuration-name">${StringUtils.escapeHtml(row.label)}</td>
            <td class="num">${StringUtils.escapeHtml(row.requestsLabel)}</td>
            <td class="num">${StringUtils.escapeHtml(row.averagePromptLabel)} ${renderSource(row.averagePromptSource)}</td>
            <td class="num">
                ${StringUtils.escapeHtml(row.hitRateLabel)} ${renderSource(row.hitRateSource)}
                ${row.hitRateNote ? `<small class="vectfox-usage-metric-note">${StringUtils.escapeHtml(row.hitRateNote)}</small>` : ''}
            </td>
            <td class="num">${StringUtils.escapeHtml(row.costPerRequestLabel)} ${renderSource(row.costPerRequestSource)}</td>
            <td class="num">${StringUtils.escapeHtml(row.savingLabel)} ${renderSource(row.savingSource)}</td>
        </tr>
    `).join('');

    const table = rows.length === 0
        ? '<div class="vectfox-usage-empty">No requests to compare yet.</div>'
        : `
            <div class="vectfox-usage-table-wrap">
                <table class="vectfox-usage-table vectfox-usage-configurations-table">
                    <thead>
                        <tr>
                            <th>Configuration</th>
                            <th class="num">Requests</th>
                            <th class="num">Avg prompt</th>
                            <th class="num">Hit %</th>
                            <th class="num">Cost / request</th>
                            <th class="num">Saving</th>
                        </tr>
                    </thead>
                    <tbody>${body}</tbody>
                </table>
            </div>
        `;

    return `
        <section class="vectfox-usage-configurations">
            <h4>By configuration</h4>
            <small class="VectFox_hint">
                Grouped by ghosting state, batch size and keep-recent, so a run at batch size 1 and
                a run at batch size 30 are directly comparable. Cost and saving are totalled per
                configuration; cost is divided by the requests that had a price.
            </small>
            ${table}
        </section>
    `;
}

function renderSource(source) {
    const safe = StringUtils.escapeHtml(source);
    return `<small class="vectfox-usage-source-${safe}">${safe}</small>`;
}

function renderCards(cards) {
    return `<div class="vectfox-usage-cards">${cards.map(renderCard).join('')}</div>`;
}

function renderCard(card, className = '') {
    return `
        <section class="vectfox-usage-card ${className}" data-usage-card="${StringUtils.escapeHtml(card.scope)}">
            <header class="vectfox-usage-card-header">
                <h4>${StringUtils.escapeHtml(card.title)}</h4>
                <span>${StringUtils.escapeHtml(card.detailLabel ?? card.requestsLabel)}</span>
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
    const safeNote = note ? `<small class="vectfox-usage-metric-note">${StringUtils.escapeHtml(note)}</small>` : '';
    return `
        <div class="vectfox-usage-metric">
            <dt>${StringUtils.escapeHtml(label)}</dt>
            <dd data-usage-metric="${StringUtils.escapeHtml(key)}">
                ${StringUtils.escapeHtml(value)}
                ${renderSource(source)}
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
            <td class="num">${StringUtils.escapeHtml(row.costLabel)} ${renderSource(row.costSource)}</td>
            <td class="num">${StringUtils.escapeHtml(row.savingLabel)} ${renderSource(row.savingSource)}</td>
            <td class="num">
                ${StringUtils.escapeHtml(row.sharedPrefixLabel)}
                ${row.sharedPrefixSource ? renderSource(row.sharedPrefixSource) : ''}
                ${row.prefixBreakerLabel
                    ? `<span class="vectfox-usage-prefix-flag" data-usage-prefix-flag>${StringUtils.escapeHtml(row.prefixBreakerLabel)}</span>`
                    : ''}
            </td>
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
                        <th class="num">Shared prefix</th>
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
