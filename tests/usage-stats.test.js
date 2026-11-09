/**
 * Usage statistics — the view-model's pure maths.
 *
 * The hit rate is token-weighted, coverage is a token share, and cost/saving
 * are resolved per record from the provider report or the price table. Tests
 * assert worked examples, never a recomputation of the implementation.
 */

import { describe, it, expect } from 'vitest';

import {
    createDefaultUsagePrices,
    summarizeUsage,
    summarizeByConfiguration,
    summarizeByOrigin,
} from '../core/usage-stats.js';

function record(overrides = {}) {
    return {
        recordId: 'rec-1',
        timestamp: 1_700_000_000_000,
        chatId: 'chat-1',
        origin: 'story',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 'ok',
        stream: false,
        promptTokens: 1000,
        hitTokens: 500,
        missTokens: 500,
        cacheWriteTokens: null,
        completionTokens: 100,
        totalTokens: 1100,
        cost: null,
        cacheDiscount: null,
        usageSource: 'measured',
        ...overrides,
    };
}

describe('usage statistics — token-weighted hit rate', () => {
    it('weights by prompt tokens instead of averaging per-request percentages', () => {
        // 100/1000 = 10%, and 10/10 = 100%. The mean would be 55%; the
        // token-weighted rate is 110/1010.
        const summary = summarizeUsage([
            record({ promptTokens: 1000, hitTokens: 100, missTokens: 900 }),
            record({ promptTokens: 10, hitTokens: 10, missTokens: 0 }),
        ]);

        expect(summary.hitRate).toBeCloseTo(110 / 1010, 10);
        expect(summary.hitTokens).toBe(110);
        expect(summary.ratedPromptTokens).toBe(1010);
    });

    it('leaves failed and aborted requests out of the hit-rate denominator', () => {
        const summary = summarizeUsage([
            record({ promptTokens: 1000, hitTokens: 500, missTokens: 500 }),
            record({ status: 'error', promptTokens: 900, hitTokens: 0, missTokens: 900 }),
            record({ status: 'aborted', promptTokens: 900, hitTokens: 0, missTokens: 900 }),
        ]);

        expect(summary.ratedPromptTokens).toBe(1000);
        expect(summary.hitRate).toBeCloseTo(0.5, 10);
        expect(summary.excludedRequests).toBe(2);
    });

    it('reports an unavailable rate rather than a zero when no hit count was reported', () => {
        const summary = summarizeUsage([
            record({ usageSource: 'unavailable', status: 'no-usage', promptTokens: null, hitTokens: null, missTokens: null }),
        ]);

        expect(summary.hitRate).toBeNull();
        expect(summary.hitTokens).toBeNull();
    });
});

describe('usage statistics — coverage', () => {
    it('is the measured share of prompt tokens, with estimated prompts counted as uncovered', () => {
        const summary = summarizeUsage([
            record({ promptTokens: 900, hitTokens: 400, missTokens: 500 }),
            record({
                status: 'no-usage',
                usageSource: 'estimated',
                promptTokens: null,
                hitTokens: null,
                missTokens: null,
                estimatedPromptTokens: 100,
            }),
        ]);

        expect(summary.promptTokens).toBe(900);
        expect(summary.estimatedPromptTokens).toBe(100);
        expect(summary.coverage).toBeCloseTo(0.9, 10);
        expect(summary.coveredRequests).toBe(1);
        expect(summary.estimatedRequests).toBe(1);
    });

    it('shows full coverage with measured rows and no coverage without any rows', () => {
        expect(summarizeUsage([record()]).coverage).toBe(1);
        expect(summarizeUsage([]).coverage).toBeNull();
    });

    it('counts a completed row with no token count as uncovered', () => {
        const summary = summarizeUsage([
            record({
                status: 'no-usage',
                usageSource: 'unavailable',
                promptTokens: null,
                hitTokens: null,
                missTokens: null,
            }),
        ]);

        expect(summary.coverage).toBe(0);
        expect(summary.unavailableRequests).toBe(1);
    });

    it('caps coverage by the request share when a row has no token count', () => {
        // One measured request and one usage-less request with no estimate:
        // the token share is 100%, but only half the requests were measured.
        const summary = summarizeUsage([
            record({ promptTokens: 900, hitTokens: 400, missTokens: 500 }),
            record({
                status: 'no-usage',
                usageSource: 'unavailable',
                promptTokens: null,
                hitTokens: null,
                missTokens: null,
            }),
        ]);

        expect(summary.coverage).toBeCloseTo(0.5, 10);
        expect(summary.coveredRequests).toBe(1);
        expect(summary.unavailableRequests).toBe(1);
    });
});

describe('usage statistics — default prices', () => {
    it('seeds the documented DeepSeek Flash rates', () => {
        const prices = createDefaultUsagePrices();

        expect(prices.entries).toContainEqual({
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            hit: 0.003,
            miss: 0.15,
            output: 0.6,
            cacheWrite: 0.15,
        });
        expect(prices.currency).toBe('USD');
    });
});

describe('usage statistics — cost and saving', () => {
    const deepseekPrices = {
        currency: 'USD',
        updated: '2026-07-31',
        entries: [
            { provider: 'DeepSeek', model: 'DeepSeek-V4-Flash', hit: 0.003, miss: 0.15, output: 0.6, cacheWrite: 0.15 },
        ],
    };

    it('uses provider-reported cost and cache discount when present', () => {
        const summary = summarizeUsage([
            record({ cost: 0.95, cacheDiscount: 0.25, usageSource: 'measured' }),
        ], { prices: deepseekPrices });

        expect(summary.cost).toBe(0.95);
        expect(summary.costSource).toBe('measured');
        expect(summary.saving).toBe(0.25);
        expect(summary.savingSource).toBe('measured');
    });

    it('computes DeepSeek cost and saving from the price table', () => {
        // 900 hit at $0.003/M, 300 miss at $0.15/M, 100 output at $0.60/M.
        // Cost: (2.7 + 45 + 60) / 1M. Saving: 900 × (0.15 − 0.003) / 1M.
        const [summary] = [summarizeUsage([
            record({ promptTokens: 1200, hitTokens: 900, missTokens: 300 }),
        ], { prices: deepseekPrices })];

        expect(summary.cost).toBeCloseTo(107.7 / 1_000_000, 12);
        expect(summary.costSource).toBe('estimated');
        expect(summary.saving).toBeCloseTo(132.3 / 1_000_000, 12);
        expect(summary.savingSource).toBe('estimated');
    });

    it('never counts output tokens in the saving', () => {
        const quiet = summarizeUsage([record({ completionTokens: 0 })], { prices: deepseekPrices });
        const chatty = summarizeUsage([record({ completionTokens: 1_000_000 })], { prices: deepseekPrices });

        expect(chatty.saving).toBeCloseTo(quiet.saving, 12);
        expect(chatty.cost).toBeGreaterThan(quiet.cost);
    });

    it('bills each prompt token once when cache-write tokens are reported', () => {
        // 80 hit + 100 written + 20 remaining miss = 200 prompt tokens.
        const summary = summarizeUsage([
            record({
                promptTokens: 200,
                hitTokens: 80,
                missTokens: 120,
                cacheWriteTokens: 100,
                completionTokens: 0,
            }),
        ], { prices: deepseekPrices });

        expect(summary.cost).toBeCloseTo((80 * 0.003 + 100 * 0.15 + 20 * 0.15) / 1_000_000, 12);
    });

    it('reports cost and saving as unavailable without a report or a price entry', () => {
        const summary = summarizeUsage([
            record({ provider: 'custom', model: 'unknown-model', cost: null, cacheDiscount: null }),
        ], { prices: deepseekPrices });

        expect(summary.cost).toBeNull();
        expect(summary.costSource).toBe('unavailable');
        expect(summary.saving).toBeNull();
        expect(summary.savingSource).toBe('unavailable');
    });

    it('labels a mixed total as estimated rather than measured', () => {
        const summary = summarizeUsage([
            record({ cost: 0.5, cacheDiscount: 0.1 }),
            record({ recordId: 'rec-2', cost: null, cacheDiscount: null }),
        ], { prices: deepseekPrices });

        expect(summary.costSource).toBe('estimated');
        expect(summary.savingSource).toBe('estimated');
    });
});

describe('usage statistics — by origin', () => {
    it('sums all requests and each origin separately', () => {
        const { combined, origins } = summarizeByOrigin([
            record({ origin: 'story', promptTokens: 1000, hitTokens: 500 }),
            record({ recordId: 'rec-2', origin: 'story', promptTokens: 2000, hitTokens: 1000 }),
            record({ recordId: 'rec-3', origin: 'vectfox-internal', featureLabel: 'EventBase', promptTokens: 100, hitTokens: 0 }),
        ]);

        expect(combined.requests).toBe(3);
        expect(combined.hitRate).toBeCloseTo(1500 / 3100, 10);

        expect(origins.map((entry) => entry.origin)).toEqual(['story', 'vectfox-internal']);
        expect(origins[0]).toMatchObject({ requests: 2, promptTokens: 3000, hitTokens: 1500 });
        expect(origins[1].hitRate).toBe(0);
    });
});

describe('usage statistics — by configuration', () => {
    it('orders configurations by ghosting state, batch size and keep-recent, unknown last', () => {
        const rows = summarizeByConfiguration([
            record({ configuration: { ghostEnabled: true, ghostBatchSize: 30, ghostKeepRecent: 10 } }),
            record({ recordId: 'rec-2', configuration: { ghostEnabled: false, ghostBatchSize: 30, ghostKeepRecent: 10 } }),
            record({ recordId: 'rec-3', configuration: { ghostEnabled: true, ghostBatchSize: 1, ghostKeepRecent: 5 } }),
            record({ recordId: 'rec-4', configuration: { ghostEnabled: true, ghostBatchSize: 1, ghostKeepRecent: 10 } }),
            record({ recordId: 'rec-5', configuration: null }),
        ]);

        expect(rows.map((entry) => entry.configuration && [
            entry.configuration.ghostEnabled,
            entry.configuration.ghostBatchSize,
            entry.configuration.ghostKeepRecent,
        ])).toEqual([
            [false, 30, 10],
            [true, 1, 5],
            [true, 1, 10],
            [true, 30, 10],
            null,
        ]);
    });

    it('averages prompt over counted requests and cost over priced requests', () => {
        const configuration = { ghostEnabled: true, ghostBatchSize: 30, ghostKeepRecent: 10 };
        const [summary] = summarizeByConfiguration([
            record({ promptTokens: 1000, hitTokens: 500, configuration }),
            record({ recordId: 'rec-2', provider: 'custom', model: 'no-price', promptTokens: 100, hitTokens: 0, configuration }),
            record({
                recordId: 'rec-3',
                status: 'no-usage',
                usageSource: 'estimated',
                promptTokens: null,
                hitTokens: null,
                missTokens: null,
                estimatedPromptTokens: 500,
                configuration,
            }),
        ], { prices: createDefaultUsagePrices() });

        expect(summary.requests).toBe(3);
        expect(summary.averagePromptTokens).toBeCloseTo(1600 / 3, 10);
        expect(summary.averagePromptSource).toBe('estimated');
        expect(summary.costedRequests).toBe(1);
        expect(summary.costPerRequest).toBeCloseTo(summary.cost, 10);
        expect(summary.costPerRequestSource).toBe('estimated');
    });
});
