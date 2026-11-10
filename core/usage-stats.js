/**
 * ============================================================================
 * USAGE STATISTICS
 * ============================================================================
 * Pure aggregation of usage records: token-weighted cache-hit rate,
 * coverage and (below) cost/saving. No DOM, no storage and no observer state,
 * so the same maths feeds the cards, the tables and later comparisons.
 * ============================================================================
 */

import { normalizeUsageConfiguration } from './usage-configuration.js';

const COMPLETED_STATUSES = new Set(['ok', 'no-usage']);
const MILLION = 1_000_000;

export const USAGE_ORIGIN_ORDER = ['story', 'quiet', 'worker-profile', 'vectfox-internal', 'unknown'];

/**
 * The single rule for an unrecognised or missing origin.
 *
 * @param {unknown} origin
 * @returns {string}
 */
export function normalizeUsageOrigin(origin) {
    return USAGE_ORIGIN_ORDER.includes(origin) ? origin : 'unknown';
}

/**
 * The single rule for a request that produced a record worth counting: a
 * completed request (`ok` or `no-usage`). Failed and aborted rows are recorded
 * but excluded from the completed counters.
 *
 * @param {unknown} status
 * @returns {boolean}
 */
export function isCompletedUsageStatus(status) {
    return COMPLETED_STATUSES.has(status);
}

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
    const coveredRequests = measured.filter((record) => isFiniteCount(record.promptTokens)).length;
    const estimatedPromptRequests = estimated.filter((record) => isFiniteCount(record.estimatedPromptTokens)).length;
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
        coverage: coverageFor({
            requests: completed.length,
            coveredRequests,
            unavailableRequests: unavailable.length,
            promptTokens: measuredPromptTokens,
            estimatedPromptTokens,
        }),
        coveredRequests,
        estimatedPromptRequests,
        ratedRequests: comparable.length,
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
 * `archived` carries the counters of records the 500-row cap has already
 * evicted, so a card keeps counting after its row is gone. The archived totals
 * are merged into the matching origin, not added as a separate group.
 *
 * @param {object[]} [records]
 * @param {object} [options] Same options as {@link summarizeUsage}.
 * @param {object} [options.archived] Evicted counters by origin plus total.
 * @returns {{combined: object, origins: object[]}}
 */
export function summarizeByOrigin(records = [], { archived = null, ...options } = {}) {
    const all = Array.isArray(records) ? records : [];
    const groups = new Map();
    for (const record of all) {
        const origin = normalizeUsageOrigin(record?.origin);
        if (!groups.has(origin)) groups.set(origin, []);
        groups.get(origin).push(record);
    }

    const archivedByOrigin = archived?.byOrigin && typeof archived.byOrigin === 'object'
        ? archived.byOrigin
        : {};

    return {
        combined: mergeUsageSummaries(
            summarizeUsage(all, options),
            summarizeArchived(archived?.total),
        ),
        origins: USAGE_ORIGIN_ORDER
            .filter((origin) => groups.has(origin) || hasUsageAccumulator(archivedByOrigin[origin]))
            .map((origin) => ({
                origin,
                ...mergeUsageSummaries(
                    summarizeUsage(groups.get(origin) ?? [], options),
                    summarizeArchived(archivedByOrigin[origin]),
                ),
            })),
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
export function summarizeByConfiguration(records = [], { archived = null, ...options } = {}) {
    const all = Array.isArray(records) ? records : [];
    const groups = new Map();
    for (const record of all) {
        // The configuration snapshot's shape is owned by the wiring; grouping
        // only needs to read its three fields, never to re-normalize them.
        const configuration = record?.configuration && typeof record.configuration === 'object'
            ? record.configuration
            : null;
        const key = usageConfigurationKey(configuration);
        if (!groups.has(key)) groups.set(key, { key, configuration, records: [] });
        groups.get(key).records.push(record);
    }

    // Configurations whose rows the cap has evicted still need a comparable
    // row, so seed them from the archived counters.
    const archivedByConfiguration = archived?.byConfiguration && typeof archived.byConfiguration === 'object'
        ? archived.byConfiguration
        : {};
    for (const [key, entry] of Object.entries(archivedByConfiguration)) {
        if (!hasUsageAccumulator(entry?.accumulator)) continue;
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                configuration: entry.configuration && typeof entry.configuration === 'object'
                    ? entry.configuration
                    : null,
                records: [],
            });
        }
    }

    return [...groups.values()]
        .sort(compareConfigurationGroups)
        .map(({ key, configuration, records: groupRecords }) => {
            const summary = mergeUsageSummaries(
                summarizeUsage(groupRecords, options),
                summarizeArchived(archivedByConfiguration[key]?.accumulator),
            );
            const measuredPrompt = summary.promptTokens ?? 0;
            const estimatedPrompt = summary.estimatedPromptTokens ?? 0;
            const promptRequests = summary.coveredRequests + summary.estimatedPromptRequests;

            return {
                key,
                configuration,
                ...summary,
                averagePromptTokens: promptRequests > 0 ? (measuredPrompt + estimatedPrompt) / promptRequests : null,
                averagePromptSource: promptRequests === 0 ? 'unavailable' : (summary.estimatedPromptRequests > 0 ? 'estimated' : 'measured'),
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

export function usageConfigurationKey(configuration) {
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
    return !!record && isCompletedUsageStatus(record.status);
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

/**
 * ============================================================================
 * EVICTED-COUNTER ACCUMULATORS
 * ============================================================================
 * The per-chat ledger keeps at most 500 records. Once a row is evicted its
 * contribution has to keep counting, so eviction folds the record into a raw
 * accumulator. Dollar figures are resolved with the price table in force at
 * eviction time; visible rows keep resolving from the current price table.
 * ============================================================================
 */

const ACCUMULATOR_FIELDS = [
    'requests',
    'measuredRequests',
    'estimatedRequests',
    'unavailableRequests',
    'excludedRequests',
    'ratedRequests',
    'coveredRequests',
    'estimatedPromptRequests',
    'promptTokens',
    'estimatedPromptTokens',
    'hitTokens',
    'ratedPromptTokens',
    'costMeasured',
    'costMeasuredRequests',
    'costEstimated',
    'costEstimatedRequests',
    'savingMeasured',
    'savingMeasuredRequests',
    'savingEstimated',
    'savingEstimatedRequests',
];

/**
 * A zeroed accumulator for the counts an evicted row contributes.
 *
 * @returns {object}
 */
export function createUsageAccumulator() {
    return Object.fromEntries(ACCUMULATOR_FIELDS.map((field) => [field, 0]));
}

/**
 * Coerces a persisted accumulator into finite counters.
 *
 * @param {object|null} value
 * @returns {object}
 */
export function normalizeUsageAccumulator(value) {
    const source = value && typeof value === 'object' ? value : {};
    return Object.fromEntries(ACCUMULATOR_FIELDS.map((field) => [
        field,
        Number.isFinite(source[field]) ? source[field] : 0,
    ]));
}

/**
 * Folds one record into an accumulator. Uses the same completed/measured rules
 * as {@link summarizeUsage} so the archived counters and a live summary agree.
 *
 * @param {object} accumulator
 * @param {object} record
 * @param {object|null} [prices]
 * @returns {object} The same accumulator.
 */
export function addRecordToUsageAccumulator(accumulator, record, prices = null) {
    if (!accumulator || typeof accumulator !== 'object') return accumulator;
    if (!isCompleted(record)) {
        accumulator.excludedRequests += 1;
        return accumulator;
    }

    accumulator.requests += 1;
    if (isMeasured(record)) {
        accumulator.measuredRequests += 1;
        if (isFiniteCount(record.promptTokens)) {
            accumulator.promptTokens += record.promptTokens;
            accumulator.coveredRequests += 1;
        }
    } else if (isEstimated(record)) {
        accumulator.estimatedRequests += 1;
        if (isFiniteCount(record.estimatedPromptTokens)) {
            accumulator.estimatedPromptTokens += record.estimatedPromptTokens;
            accumulator.estimatedPromptRequests += 1;
        }
    } else {
        accumulator.unavailableRequests += 1;
    }

    if (isFiniteCount(record.promptTokens) && isFiniteCount(record.hitTokens)) {
        accumulator.ratedRequests += 1;
        accumulator.ratedPromptTokens += record.promptTokens;
        accumulator.hitTokens += record.hitTokens;
    }

    const resolved = resolveUsageCost(record, prices);
    if (Number.isFinite(resolved.cost)) {
        if (resolved.costSource === 'measured') {
            accumulator.costMeasured += resolved.cost;
            accumulator.costMeasuredRequests += 1;
        } else {
            accumulator.costEstimated += resolved.cost;
            accumulator.costEstimatedRequests += 1;
        }
    }
    if (Number.isFinite(resolved.saving)) {
        if (resolved.savingSource === 'measured') {
            accumulator.savingMeasured += resolved.saving;
            accumulator.savingMeasuredRequests += 1;
        } else {
            accumulator.savingEstimated += resolved.saving;
            accumulator.savingEstimatedRequests += 1;
        }
    }
    return accumulator;
}

/**
 * Sums two accumulators.
 *
 * @param {object|null} left
 * @param {object|null} right
 * @returns {object}
 */
export function mergeUsageAccumulators(left, right) {
    const merged = normalizeUsageAccumulator(left);
    const other = normalizeUsageAccumulator(right);
    for (const field of ACCUMULATOR_FIELDS) merged[field] += other[field];
    return merged;
}

/**
 * Subtracts one accumulator from another, clamping at zero: a deleted chat
 * must never leave the all-time total negative.
 *
 * @param {object|null} left
 * @param {object|null} right
 * @returns {object}
 */
export function subtractUsageAccumulators(left, right) {
    const merged = normalizeUsageAccumulator(left);
    const other = normalizeUsageAccumulator(right);
    for (const field of ACCUMULATOR_FIELDS) merged[field] = Math.max(0, merged[field] - other[field]);
    return merged;
}

/**
 * True when an accumulator holds nothing worth persisting.
 *
 * @param {object|null} accumulator
 * @returns {boolean}
 */
export function isUsageAccumulatorEmpty(accumulator) {
    const normalized = normalizeUsageAccumulator(accumulator);
    return ACCUMULATOR_FIELDS.every((field) => normalized[field] === 0);
}

/**
 * A summary in the same shape as {@link summarizeUsage}, rebuilt from counters.
 *
 * @param {object|null} accumulator
 * @returns {object}
 */
export function summarizeAccumulator(accumulator) {
    const counters = normalizeUsageAccumulator(accumulator);
    const promptTokens = counters.coveredRequests > 0 ? counters.promptTokens : null;
    const estimatedPromptTokens = counters.estimatedPromptTokens || null;
    const hitTokens = counters.ratedRequests > 0 ? counters.hitTokens : null;
    const cost = resolveAccumulatedCost(counters, 'cost');
    const saving = resolveAccumulatedCost(counters, 'saving');

    return {
        requests: counters.requests,
        measuredRequests: counters.measuredRequests,
        estimatedRequests: counters.estimatedRequests,
        unavailableRequests: counters.unavailableRequests,
        excludedRequests: counters.excludedRequests,
        promptTokens,
        estimatedPromptTokens,
        hitTokens,
        ratedPromptTokens: counters.ratedPromptTokens,
        hitRate: counters.ratedPromptTokens > 0 && hitTokens != null
            ? hitTokens / counters.ratedPromptTokens
            : null,
        coverage: coverageFor({
            requests: counters.requests,
            coveredRequests: counters.coveredRequests,
            unavailableRequests: counters.unavailableRequests,
            promptTokens,
            estimatedPromptTokens,
        }),
        coveredRequests: counters.coveredRequests,
        estimatedPromptRequests: counters.estimatedPromptRequests,
        ratedRequests: counters.ratedRequests,
        cost: cost.value,
        costSource: cost.source,
        costedRequests: counters.costMeasuredRequests + counters.costEstimatedRequests,
        saving: saving.value,
        savingSource: saving.source,
    };
}

/**
 * Combines two summaries, preserving token-weighted rates. Null on either side
 * is treated as an empty summary, so the view model can always merge a live
 * summary with archived counters.
 *
 * @param {object|null} left
 * @param {object|null} right
 * @returns {object}
 */
export function mergeUsageSummaries(left, right) {
    if (!left) return right ?? summarizeAccumulator(null);
    if (!right) return left;

    const requests = left.requests + right.requests;
    const coveredRequests = left.coveredRequests + right.coveredRequests;
    const unavailableRequests = left.unavailableRequests + right.unavailableRequests;
    const promptTokens = sumNullable(left.promptTokens, right.promptTokens);
    const estimatedPromptTokens = sumNullable(left.estimatedPromptTokens, right.estimatedPromptTokens);
    const ratedPromptTokens = left.ratedPromptTokens + right.ratedPromptTokens;
    const hitTokens = ratedPromptTokens > 0 ? sumNullable(left.hitTokens, right.hitTokens) : null;
    const cost = sumNullable(left.cost, right.cost);
    const saving = sumNullable(left.saving, right.saving);

    return {
        requests,
        measuredRequests: left.measuredRequests + right.measuredRequests,
        estimatedRequests: left.estimatedRequests + right.estimatedRequests,
        unavailableRequests,
        excludedRequests: left.excludedRequests + right.excludedRequests,
        promptTokens,
        estimatedPromptTokens,
        hitTokens,
        ratedPromptTokens,
        hitRate: ratedPromptTokens > 0 && hitTokens != null ? hitTokens / ratedPromptTokens : null,
        coverage: coverageFor({ requests, coveredRequests, unavailableRequests, promptTokens, estimatedPromptTokens }),
        coveredRequests,
        estimatedPromptRequests: left.estimatedPromptRequests + right.estimatedPromptRequests,
        ratedRequests: left.ratedRequests + right.ratedRequests,
        cost,
        costSource: mergeSources([left.costSource, right.costSource]),
        costedRequests: left.costedRequests + right.costedRequests,
        saving,
        savingSource: mergeSources([left.savingSource, right.savingSource]),
    };
}

function summarizeArchived(accumulator) {
    return hasUsageAccumulator(accumulator) ? summarizeAccumulator(accumulator) : null;
}

function hasUsageAccumulator(accumulator) {
    return !!accumulator && typeof accumulator === 'object' && !isUsageAccumulatorEmpty(accumulator);
}

function resolveAccumulatedCost(counters, prefix) {
    const measuredRequests = counters[`${prefix}MeasuredRequests`];
    const estimatedRequests = counters[`${prefix}EstimatedRequests`];
    if (measuredRequests + estimatedRequests === 0) return { value: null, source: 'unavailable' };
    const value = counters[`${prefix}Measured`] + counters[`${prefix}Estimated`];
    return { value, source: estimatedRequests > 0 ? 'estimated' : 'measured' };
}

function coverageFor({ requests, coveredRequests, unavailableRequests, promptTokens, estimatedPromptTokens }) {
    if (requests === 0) return null;
    const measuredPrompt = promptTokens ?? 0;
    const promptTotal = measuredPrompt + (estimatedPromptTokens ?? 0);
    const tokenCoverage = promptTotal > 0 ? measuredPrompt / promptTotal : 0;
    const requestCoverage = coveredRequests / requests;
    // A completed request with no token count is uncovered data, so it also
    // caps coverage by the share of requests that had a count.
    return unavailableRequests > 0 ? Math.min(tokenCoverage, requestCoverage) : tokenCoverage;
}

function sumNullable(left, right) {
    if (left == null && right == null) return null;
    return (left ?? 0) + (right ?? 0);
}


/**
 * ============================================================================
 * EVICTED-ROW ARCHIVE
 * ============================================================================
 * The per-chat namespace keeps a rolling aggregate of the rows the retention
 * cap has evicted: overall, per origin, per provider/model and per ghosting
 * configuration. Keeping the aggregation here, next to the live summaries,
 * means an origin or configuration rule changes in one place.
 * ============================================================================
 */

/**
 * @returns {{total: object, byOrigin: object, byModel: object, byConfiguration: object}}
 */
export function createUsageArchive() {
    return {
        total: createUsageAccumulator(),
        byOrigin: {},
        byModel: {},
        byConfiguration: {},
    };
}

/**
 * Coerces a persisted archive into the shape the summaries expect.
 *
 * @param {object|null} value
 * @returns {{total: object, byOrigin: object, byModel: object, byConfiguration: object}}
 */
export function normalizeUsageArchive(value) {
    const archive = createUsageArchive();
    if (!value || typeof value !== 'object') return archive;
    archive.total = normalizeUsageAccumulator(value.total);
    for (const [origin, counters] of Object.entries(value.byOrigin ?? {})) {
        if (!counters || typeof counters !== 'object') continue;
        archive.byOrigin[origin] = normalizeUsageAccumulator(counters);
    }
    for (const [key, entry] of Object.entries(value.byModel ?? {})) {
        if (!entry || typeof entry !== 'object') continue;
        archive.byModel[key] = {
            provider: typeof entry.provider === 'string' ? entry.provider : '',
            model: typeof entry.model === 'string' ? entry.model : '',
            accumulator: normalizeUsageAccumulator(entry.accumulator),
        };
    }
    for (const [key, entry] of Object.entries(value.byConfiguration ?? {})) {
        if (!entry || typeof entry !== 'object') continue;
        archive.byConfiguration[key] = {
            configuration: normalizeUsageConfiguration(entry.configuration),
            accumulator: normalizeUsageAccumulator(entry.accumulator),
        };
    }
    return archive;
}

/**
 * Folds one evicted record into the archive. Cost is resolved with the price
 * table in force at eviction time; visible rows keep using the current table.
 *
 * @param {object} archive
 * @param {object} record
 * @param {object|null} [prices]
 * @returns {object} The same archive.
 */
export function addRecordToUsageArchive(archive, record, prices = null) {
    if (!archive || typeof archive !== 'object') return archive;
    if (!record || typeof record !== 'object') return archive;
    addRecordToUsageAccumulator(archive.total, record, prices);

    const origin = normalizeUsageOrigin(record.origin);
    if (!archive.byOrigin[origin]) archive.byOrigin[origin] = createUsageAccumulator();
    addRecordToUsageAccumulator(archive.byOrigin[origin], record, prices);

    const provider = typeof record.provider === 'string' ? record.provider : '';
    const model = typeof record.model === 'string' ? record.model : '';
    const modelKey = usageModelKey(provider, model);
    if (!archive.byModel[modelKey]) {
        archive.byModel[modelKey] = { provider, model, accumulator: createUsageAccumulator() };
    }
    addRecordToUsageAccumulator(archive.byModel[modelKey].accumulator, record, prices);

    const configuration = normalizeUsageConfiguration(record.configuration);
    const configurationKey = usageConfigurationKey(configuration);
    if (!archive.byConfiguration[configurationKey]) {
        archive.byConfiguration[configurationKey] = {
            configuration,
            accumulator: createUsageAccumulator(),
        };
    }
    addRecordToUsageAccumulator(archive.byConfiguration[configurationKey].accumulator, record, prices);
    return archive;
}

/**
 * Sums two archives.
 *
 * @param {object|null} left
 * @param {object|null} right
 * @returns {object}
 */
export function mergeUsageArchives(left, right) {
    const target = normalizeUsageArchive(left);
    const source = normalizeUsageArchive(right);
    target.total = mergeUsageAccumulators(target.total, source.total);
    for (const [origin, counters] of Object.entries(source.byOrigin)) {
        target.byOrigin[origin] = mergeUsageAccumulators(target.byOrigin[origin] ?? null, counters);
    }
    for (const [key, entry] of Object.entries(source.byModel)) {
        if (!target.byModel[key]) {
            target.byModel[key] = { provider: entry.provider, model: entry.model, accumulator: createUsageAccumulator() };
        }
        target.byModel[key].accumulator = mergeUsageAccumulators(
            target.byModel[key].accumulator,
            entry.accumulator,
        );
    }
    for (const [key, entry] of Object.entries(source.byConfiguration)) {
        if (!target.byConfiguration[key]) {
            target.byConfiguration[key] = {
                configuration: entry.configuration,
                accumulator: createUsageAccumulator(),
            };
        }
        target.byConfiguration[key].accumulator = mergeUsageAccumulators(
            target.byConfiguration[key].accumulator,
            entry.accumulator,
        );
    }
    return target;
}

/**
 * True when an archive holds nothing worth persisting.
 *
 * @param {object|null} archive
 * @returns {boolean}
 */
export function isUsageArchiveEmpty(archive) {
    if (!archive) return true;
    if (!isUsageAccumulatorEmpty(archive.total)) return false;
    for (const counters of Object.values(archive.byOrigin ?? {})) {
        if (!isUsageAccumulatorEmpty(counters)) return false;
    }
    for (const entry of Object.values(archive.byModel ?? {})) {
        if (!isUsageAccumulatorEmpty(entry?.accumulator)) return false;
    }
    for (const entry of Object.values(archive.byConfiguration ?? {})) {
        if (!isUsageAccumulatorEmpty(entry?.accumulator)) return false;
    }
    return true;
}

/**
 * Stable key for the provider/model breakdown.
 *
 * @param {unknown} provider
 * @param {unknown} model
 * @returns {string}
 */
export function usageModelKey(provider, model) {
    return `${normalizeKey(provider)}|${normalizeKey(model)}`;
}
