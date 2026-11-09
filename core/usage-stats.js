/**
 * ============================================================================
 * USAGE STATISTICS
 * ============================================================================
 * Pure aggregation of usage records: token-weighted cache-hit rate,
 * coverage and (below) cost/saving. No DOM, no storage and no observer state,
 * so the same maths feeds the cards, the tables and later comparisons.
 * ============================================================================
 */

const COMPLETED_STATUSES = new Set(['ok', 'no-usage']);
const MILLION = 1_000_000;

const USAGE_ORIGIN_ORDER = ['story', 'quiet', 'worker-profile', 'vectfox-internal', 'unknown'];

/**
 * Seed price table. DeepSeek Flash off-peak rates from the ghosting cost
 * analysis in `.scratch/cache-friendly-ghosting/cost-analysis.md`: cache hit
 * $0.003/M, cache miss $0.15/M, output $0.60/M. Cache writes bill at the miss
 * rate. The user edits these in the tab; there is no network price lookup.
 */
export function createDefaultUsagePrices() {
    return {
        currency: 'USD',
        updated: '2026-07-31',
        entries: [
            { provider: 'deepseek', model: 'deepseek-v4-flash', hit: 0.003, miss: 0.15, output: 0.6, cacheWrite: 0.15 },
        ],
    };
}

/**
 * Coerces a persisted price table into the shape the editor and maths expect.
 *
 * @param {object|null} value
 * @returns {{currency: string, updated: string, entries: object[]}}
 */
export function normalizeUsagePrices(value) {
    const source = value && typeof value === 'object' ? value : {};
    const entries = Array.isArray(source.entries) ? source.entries : [];
    return {
        currency: nonEmptyString(source.currency) || 'USD',
        updated: typeof source.updated === 'string' ? source.updated : '',
        entries: entries.map((entry) => ({
            provider: typeof entry?.provider === 'string' ? entry.provider : '',
            model: typeof entry?.model === 'string' ? entry.model : '',
            hit: finiteOrNull(entry?.hit),
            miss: finiteOrNull(entry?.miss),
            output: finiteOrNull(entry?.output),
            cacheWrite: finiteOrNull(entry?.cacheWrite),
        })),
    };
}

/**
 * Summarizes one set of records.
 *
 * The hit rate is token-weighted: sum of hit tokens over sum of prompt tokens
 * for records that reported both. Failed and aborted requests never enter the
 * denominator. Coverage is the measured share of prompt tokens; an estimated
 * prompt counts as uncovered tokens, so a provider without usage visibly
 * lowers coverage instead of disappearing from the rate.
 *
 * @param {object[]} [records]
 * @param {object} [options]
 * @param {object} [options.prices] Price table used for cost/saving.
 * @returns {object}
 */
export function summarizeUsage(records = [], { prices = null } = {}) {
    const all = Array.isArray(records) ? records : [];
    const completed = all.filter(isCompleted);

    const measured = completed.filter(isMeasured);
    const estimated = completed.filter((record) => !isMeasured(record) && isEstimated(record));
    const unavailable = completed.filter((record) => !isMeasured(record) && !isEstimated(record));

    const measuredPromptTokens = sumFinite(measured, 'promptTokens');
    const estimatedPromptTokens = sumFinite(estimated, 'estimatedPromptTokens') ?? 0;
    const comparable = measured.filter((record) => (
        isFiniteCount(record.promptTokens) && isFiniteCount(record.hitTokens)
    ));
    const ratedPromptTokens = sumFinite(comparable, 'promptTokens') ?? 0;
    const hitTokens = sumFinite(comparable, 'hitTokens') ?? null;
    const promptTotal = measuredPromptTokens + estimatedPromptTokens;
    const coveredRequests = measured.filter((record) => isFiniteCount(record.promptTokens)).length;
    const tokenCoverage = promptTotal > 0 ? measuredPromptTokens / promptTotal : 0;
    const requestCoverage = completed.length > 0 ? coveredRequests / completed.length : 1;
    const costs = completed.map((record) => resolveUsageCost(record, prices));
    const costedRequests = costs.filter((entry) => Number.isFinite(entry.cost)).length;

    return {
        requests: completed.length,
        measuredRequests: measured.length,
        estimatedRequests: estimated.length,
        unavailableRequests: unavailable.length,
        excludedRequests: all.length - completed.length,
        promptTokens: measuredPromptTokens ?? null,
        estimatedPromptTokens: estimatedPromptTokens || null,
        hitTokens,
        ratedPromptTokens,
        hitRate: ratedPromptTokens > 0 ? hitTokens / ratedPromptTokens : null,
        // A completed request with no token count (estimator unavailable) is
        // uncovered data, so it also caps coverage by the share of requests
        // that had a count. An empty record set has no coverage at all.
        coverage: completed.length === 0
            ? null
            : (unavailable.length > 0 ? Math.min(tokenCoverage, requestCoverage) : tokenCoverage),
        coveredRequests,
        cost: sumPresent(costs.map((entry) => entry.cost)),
        costSource: mergeSources(costs.map((entry) => entry.costSource)),
        costedRequests,
        saving: sumPresent(costs.map((entry) => entry.saving)),
        savingSource: mergeSources(costs.map((entry) => entry.savingSource)),
    };
}

/**
 * Combined summary plus one row per origin that has records.
 *
 * @param {object[]} [records]
 * @param {object} [options] Same options as {@link summarizeUsage}.
 * @returns {{combined: object, origins: object[]}}
 */
export function summarizeByOrigin(records = [], options = {}) {
    const all = Array.isArray(records) ? records : [];
    const groups = new Map();
    for (const record of all) {
        const origin = USAGE_ORIGIN_ORDER.includes(record?.origin) ? record.origin : 'unknown';
        if (!groups.has(origin)) groups.set(origin, []);
        groups.get(origin).push(record);
    }

    return {
        combined: summarizeUsage(all, options),
        origins: USAGE_ORIGIN_ORDER
            .filter((origin) => groups.has(origin))
            .map((origin) => ({ origin, ...summarizeUsage(groups.get(origin), options) })),
    };
}

/**
 * One row per ghosting configuration that has records, ordered so a before /
 * after batch-size comparison reads top to bottom. A record with no snapshot
 * gets its own trailing group rather than being merged into a measured one.
 *
 * Average prompt and cost per request divide by the requests that had the
 * required count, never by all requests: a request without a token count or a
 * price must not be silently averaged in as zero.
 *
 * @param {object[]} [records]
 * @param {object} [options] Same options as {@link summarizeUsage}.
 * @returns {object[]}
 */
export function summarizeByConfiguration(records = [], options = {}) {
    const all = Array.isArray(records) ? records : [];
    const groups = new Map();
    for (const record of all) {
        // The configuration snapshot's shape is owned by the wiring; grouping
        // only needs to read its three fields, never to re-normalize them.
        const configuration = record?.configuration && typeof record.configuration === 'object'
            ? record.configuration
            : null;
        const key = configurationKey(configuration);
        if (!groups.has(key)) groups.set(key, { key, configuration, records: [] });
        groups.get(key).records.push(record);
    }

    return [...groups.values()]
        .sort(compareConfigurationGroups)
        .map(({ key, configuration, records: groupRecords }) => {
            const summary = summarizeUsage(groupRecords, options);
            const measuredPrompt = summary.promptTokens ?? 0;
            const estimatedPrompt = summary.estimatedPromptTokens ?? 0;
            const estimatedCount = groupRecords.filter((record) => (
                isCompleted(record) && !isMeasured(record) && isEstimated(record)
                && isFiniteCount(record.estimatedPromptTokens)
            )).length;
            const promptRequests = summary.coveredRequests + estimatedCount;

            return {
                key,
                configuration,
                ...summary,
                averagePromptTokens: promptRequests > 0 ? (measuredPrompt + estimatedPrompt) / promptRequests : null,
                averagePromptSource: promptRequests === 0 ? 'unavailable' : (estimatedCount > 0 ? 'estimated' : 'measured'),
                costPerRequest: summary.cost != null && summary.costedRequests > 0
                    ? summary.cost / summary.costedRequests
                    : null,
                costPerRequestSource: summary.costedRequests > 0 ? summary.costSource : 'unavailable',
            };
        })
        // A group made only of failed or aborted requests has nothing to
        // compare; leaving it as a zero-request row would look like data.
        .filter((group) => group.requests > 0);
}

function configurationKey(configuration) {
    if (!configuration) return 'configuration-unknown';
    const batch = configuration.ghostBatchSize ?? 'none';
    const keep = configuration.ghostKeepRecent ?? 'none';
    return `ghost:${configuration.ghostEnabled ? 'on' : 'off'}:batch:${batch}:keep:${keep}`;
}

function compareConfigurationGroups(left, right) {
    if (!left.configuration) return 1;
    if (!right.configuration) return -1;
    if (left.configuration.ghostEnabled !== right.configuration.ghostEnabled) {
        return left.configuration.ghostEnabled ? 1 : -1;
    }
    const batch = compareFinite(left.configuration.ghostBatchSize, right.configuration.ghostBatchSize);
    if (batch !== 0) return batch;
    return compareFinite(left.configuration.ghostKeepRecent, right.configuration.ghostKeepRecent);
}

function compareFinite(left, right) {
    const leftValue = Number.isFinite(left) ? left : null;
    const rightValue = Number.isFinite(right) ? right : null;
    if (leftValue == null && rightValue == null) return 0;
    if (leftValue == null) return 1;
    if (rightValue == null) return -1;
    return leftValue - rightValue;
}

/**
 * Resolves one record's cost and cache saving.
 *
 * A provider-reported cost or cache discount wins and is labelled measured.
 * Otherwise the price table derives both and the result is labelled estimated:
 * cost is hit, cache-write, remaining-miss and output tokens, each billed once;
 * saving is hit tokens times the miss-minus-hit price, so output never counts.
 *
 * @param {object} record
 * @param {object|null} prices
 * @returns {{cost: number|null, costSource: string, saving: number|null, savingSource: string}}
 */
export function resolveUsageCost(record, prices = null) {
    const reportedCost = finiteOrNull(record?.cost);
    const reportedSaving = finiteOrNull(record?.cacheDiscount);
    const price = findUsagePrice(prices, record);

    const cost = reportedCost ?? (price ? estimateCost(record, price) : null);
    const saving = reportedSaving ?? (price ? estimateSaving(record, price) : null);

    return {
        cost,
        costSource: reportedCost != null ? 'measured' : (cost != null ? 'estimated' : 'unavailable'),
        saving,
        savingSource: reportedSaving != null ? 'measured' : (saving != null ? 'estimated' : 'unavailable'),
    };
}

/**
 * Finds the price entry for a record's provider and model, case-insensitively.
 *
 * @param {object|null} prices
 * @param {object} record
 * @returns {object|null}
 */
function findUsagePrice(prices, record) {
    const entries = Array.isArray(prices?.entries) ? prices.entries : [];
    const provider = normalizeKey(record?.provider);
    const model = normalizeKey(record?.model);
    if (!provider || !model) return null;
    return entries.find((entry) => (
        normalizeKey(entry?.provider) === provider && normalizeKey(entry?.model) === model
    )) ?? null;
}

function estimateCost(record, price) {
    const promptTokens = finiteOrNull(record?.promptTokens);
    if (promptTokens == null || price.hit == null || price.miss == null || price.output == null) return null;

    const hit = finiteOrNull(record?.hitTokens) ?? 0;
    const cacheWrite = finiteOrNull(record?.cacheWriteTokens) ?? 0;
    const completion = finiteOrNull(record?.completionTokens) ?? 0;
    const cacheWritePrice = price.cacheWrite ?? price.miss;

    // The reported miss count already includes cache writes; allocate the
    // prompt once so the write rate does not double-charge those tokens.
    const uncachedInput = Math.max(0, promptTokens - hit - cacheWrite);
    const microCost = hit * price.hit
        + cacheWrite * cacheWritePrice
        + uncachedInput * price.miss
        + completion * price.output;
    return microCost / MILLION;
}

function estimateSaving(record, price) {
    const hit = finiteOrNull(record?.hitTokens);
    if (hit == null || price.hit == null || price.miss == null) return null;
    return hit * (price.miss - price.hit) / MILLION;
}

function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeKey(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

function sumPresent(values) {
    let total = null;
    for (const value of values) {
        if (!Number.isFinite(value)) continue;
        total = (total ?? 0) + value;
    }
    return total;
}

function mergeSources(sources) {
    let measured = false;
    let estimated = false;
    for (const source of sources) {
        if (source === 'measured') measured = true;
        else if (source === 'estimated') estimated = true;
    }
    if (estimated) return 'estimated';
    return measured ? 'measured' : 'unavailable';
}

function isCompleted(record) {
    return !!record && COMPLETED_STATUSES.has(record.status);
}

function isMeasured(record) {
    return record?.usageSource === 'measured';
}

function isEstimated(record) {
    return record?.usageSource === 'estimated' || isFiniteCount(record?.estimatedPromptTokens);
}

function isFiniteCount(value) {
    return Number.isFinite(value) && value >= 0;
}

function sumFinite(records, field) {
    let total = null;
    for (const record of records) {
        const value = record?.[field];
        if (!isFiniteCount(value)) continue;
        total = (total ?? 0) + value;
    }
    return total;
}
