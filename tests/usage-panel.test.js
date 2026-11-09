/**
 * Usage panel — the view-model seam.
 *
 * Pure formatting is tested directly; one jsdom smoke proves the panel mounts,
 * renders a row and reflects the toggle. Layout stays manually verified.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { buildUsageView, initializeUsagePanel } from '../ui/usage-panel.js';

function measuredRecord(overrides = {}) {
    return {
        recordId: 'rec-1',
        timestamp: 1_700_000_000_000,
        chatId: 'chat-1',
        provider: 'openrouter',
        model: 'deepseek/deepseek-v3',
        stream: false,
        status: 'ok',
        httpStatus: 200,
        promptTokens: 1200,
        hitTokens: 900,
        missTokens: 300,
        completionTokens: 100,
        totalTokens: 1300,
        usageSource: 'measured',
        ...overrides,
    };
}

describe('usage view model', () => {
    it('explains how to enable tracking when it is off and there is nothing recorded', () => {
        const view = buildUsageView({ records: [], trackingEnabled: false });

        expect(view.empty).toBe(true);
        expect(view.rows).toEqual([]);
        expect(view.emptyMessage).toMatch(/tracking is off/i);
        expect(view.emptyMessage).toMatch(/turn on/i);
    });
});

describe('usage view model — rows', () => {
    it('formats a measured record as one row with readable token counts', () => {
        const view = buildUsageView({
            records: [measuredRecord()],
            trackingEnabled: true,
        });

        expect(view.empty).toBe(false);
        expect(view.rows).toHaveLength(1);
        expect(view.rows[0]).toMatchObject({
            providerModel: 'openrouter / deepseek/deepseek-v3',
            promptLabel: '1,200',
            hitLabel: '900',
            missLabel: '300',
            totalLabel: '1,300',
            sourceLabel: 'measured',
        });
        expect(view.rows[0].timeLabel).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    });

    it('labels an unavailable record instead of showing a zero cache hit', () => {
        const [row] = buildUsageView({
            records: [measuredRecord({
                usageSource: 'unavailable',
                status: 'no-usage',
                promptTokens: null,
                hitTokens: null,
                missTokens: null,
                completionTokens: null,
                totalTokens: null,
            })],
            trackingEnabled: true,
        }).rows;

        expect(row.sourceLabel).toBe('unavailable');
        expect(row.hitLabel).not.toBe('0');
        expect(row.promptLabel).toBe('—');
    });
});

describe('usage panel — jsdom smoke', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('renders a row, reflects the toggle and falls back to the empty state', () => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
        const settings = { usage_tracking_enabled: true };
        const ledger = { recordsFor: () => [measuredRecord()] };
        const onTrackingChange = vi.fn();

        const refresh = initializeUsagePanel({
            settings,
            ledger,
            getChatId: () => 'chat-1',
            onTrackingChange,
        });

        const panel = document.getElementById('VectFox_usage_panel');
        expect(panel.querySelectorAll('.vectfox-usage-requests-table tbody tr')).toHaveLength(1);
        expect(panel.textContent).toContain('openrouter / deepseek/deepseek-v3');
        expect(panel.querySelector('#VectFox_usage_tracking_enabled').checked).toBe(true);

        const toggle = panel.querySelector('#VectFox_usage_tracking_enabled');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));

        expect(onTrackingChange).toHaveBeenCalledWith(false);
        expect(settings.usage_tracking_enabled).toBe(false);

        ledger.recordsFor = () => [];
        refresh();
        expect(panel.querySelectorAll('.vectfox-usage-requests-table tbody tr')).toHaveLength(0);
        expect(panel.textContent).toMatch(/tracking is off/i);
    });
});

describe('usage view model — origins', () => {
    it('makes each origin distinguishable in the row', () => {
        const rows = buildUsageView({
            records: [
                measuredRecord({ origin: 'story' }),
                measuredRecord({ origin: 'quiet' }),
                measuredRecord({ origin: 'worker-profile' }),
                measuredRecord({ origin: 'vectfox-internal', featureLabel: 'EventBase' }),
                measuredRecord({ origin: 'unknown' }),
            ],
            trackingEnabled: true,
        }).rows;

        expect(rows.map((row) => row.originLabel)).toEqual([
            'story',
            'quiet',
            'worker',
            'VectFox · EventBase',
            'unknown',
        ]);
    });

    it('falls back to unknown when a record predates origins', () => {
        const [row] = buildUsageView({ records: [measuredRecord()], trackingEnabled: true }).rows;
        expect(row.originLabel).toBe('unknown');
    });
});

describe('usage view model — observer health', () => {
    it('says tracking is off when the observer is not installed', () => {
        const view = buildUsageView({ records: [], trackingEnabled: false });

        expect(view.health.state).toBe('off');
        expect(view.health.label).toMatch(/tracking is off/i);
    });

    it('distinguishes "no requests captured yet" from an observer error', () => {
        const idle = buildUsageView({
            records: [],
            trackingEnabled: true,
            health: { matched: 0, captured: 0, skipped: 0, errors: 0 },
        });
        expect(idle.health.state).toBe('idle');
        expect(idle.health.label).toMatch(/no requests captured yet/i);

        const failed = buildUsageView({
            records: [],
            trackingEnabled: true,
            health: { matched: 3, captured: 2, skipped: 0, errors: 1 },
        });
        expect(failed.health.state).toBe('error');
        expect(failed.health.label).toMatch(/observer error/i);
        expect(failed.health.label).not.toMatch(/no requests captured yet/i);
    });

    it('reports how many requests were captured while healthy', () => {
        const view = buildUsageView({
            records: [measuredRecord({ origin: 'story' })],
            trackingEnabled: true,
            health: { matched: 2, captured: 2, skipped: 0, errors: 0 },
        });

        expect(view.health.state).toBe('ok');
        expect(view.health.label).toMatch(/2 requests captured/i);
    });

    it('mentions skipped requests without calling them errors', () => {
        const view = buildUsageView({
            records: [],
            trackingEnabled: true,
            health: { matched: 1, captured: 0, skipped: 1, errors: 0 },
        });

        expect(view.health.state).toBe('idle');
        expect(view.health.label).toMatch(/1 request skipped/i);
    });
});

describe('usage panel — health and origin smoke', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('renders the health line and each row origin', () => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
        const settings = { usage_tracking_enabled: true };
        const ledger = {
            recordsFor: () => [measuredRecord({ origin: 'vectfox-internal', featureLabel: 'EventBase' })],
        };

        initializeUsagePanel({
            settings,
            ledger,
            getChatId: () => 'chat-1',
            getHealth: () => ({ matched: 1, captured: 1, skipped: 0, errors: 0 }),
        });

        const panel = document.getElementById('VectFox_usage_panel');
        expect(panel.textContent).toMatch(/1 request captured/i);
        expect(panel.textContent).toMatch(/VectFox · EventBase/);
    });
});

const deepseekPrices = {
    currency: 'USD',
    updated: '2026-07-31',
    entries: [
        { provider: 'deepseek', model: 'deepseek-v4-flash', hit: 0.003, miss: 0.15, output: 0.6, cacheWrite: 0.15 },
    ],
};

function deepseekRecord(overrides = {}) {
    return measuredRecord({
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        promptTokens: 1200,
        hitTokens: 900,
        missTokens: 300,
        completionTokens: 100,
        ...overrides,
    });
}

describe('usage view model — summary cards', () => {
    it('shows weighted totals for all requests and for each origin', () => {
        const view = buildUsageView({
            records: [
                deepseekRecord({ origin: 'story', promptTokens: 1000, hitTokens: 100, missTokens: 900 }),
                deepseekRecord({ recordId: 'rec-2', origin: 'worker-profile', promptTokens: 10, hitTokens: 10, missTokens: 0 }),
            ],
            trackingEnabled: true,
            prices: deepseekPrices,
        });

        expect(view.cards.map((card) => card.scope)).toEqual(['all', 'story', 'worker-profile']);

        const all = view.cards[0];
        expect(all).toMatchObject({
            title: 'All requests',
            requestsLabel: '2 requests',
            promptLabel: '1,010',
            hitLabel: '110',
            hitRateLabel: '10.9%',
            coverageLabel: '100.0%',
            costSource: 'estimated',
            savingSource: 'estimated',
        });
        expect(all.costLabel).toMatch(/^\$/);
        expect(all.savingLabel).toMatch(/^\$/);

        expect(view.cards[1]).toMatchObject({ title: 'story', requestsLabel: '1 request' });
        expect(view.cards[2]).toMatchObject({ title: 'worker', requestsLabel: '1 request' });
    });

    it('labels provider-reported cost and saving as measured', () => {
        const view = buildUsageView({
            records: [measuredRecord({ cost: 0.95, cacheDiscount: 0.25 })],
            trackingEnabled: true,
            prices: deepseekPrices,
        });

        expect(view.cards[0]).toMatchObject({
            costLabel: '0.95 reported',
            costSource: 'measured',
            savingLabel: '0.25 reported',
            savingSource: 'measured',
        });
        expect(view.rows[0]).toMatchObject({
            costLabel: '0.95 reported',
            costSource: 'measured',
            savingLabel: '0.25 reported',
            savingSource: 'measured',
        });
    });

    it('does not tag a coverage value as measured when no token count exists', () => {
        const view = buildUsageView({
            records: [measuredRecord({
                status: 'no-usage',
                usageSource: 'unavailable',
                promptTokens: null,
                hitTokens: null,
                missTokens: null,
                completionTokens: null,
                totalTokens: null,
            })],
            trackingEnabled: true,
        });

        expect(view.cards[0]).toMatchObject({
            coverageLabel: '0.0%',
            coverageSource: 'unavailable',
            promptSource: 'unavailable',
        });
    });

    it('labels cost unavailable without a report or a price entry', () => {
        const view = buildUsageView({
            records: [measuredRecord({ provider: 'custom', model: 'no-price', cost: null, cacheDiscount: null })],
            trackingEnabled: true,
            prices: deepseekPrices,
        });

        expect(view.cards[0]).toMatchObject({
            costLabel: '—',
            costSource: 'unavailable',
            savingLabel: '—',
            savingSource: 'unavailable',
        });
    });
});

describe('usage view model — estimates and labels', () => {
    it('shows an estimated prompt in the card when nothing was measured', () => {
        const view = buildUsageView({
            records: [measuredRecord({
                status: 'no-usage',
                usageSource: 'estimated',
                promptTokens: null,
                hitTokens: null,
                missTokens: null,
                completionTokens: null,
                estimatedPromptTokens: 240,
            })],
            trackingEnabled: true,
        });

        expect(view.cards[0]).toMatchObject({
            promptLabel: '~240',
            promptSource: 'estimated',
            hitLabel: '—',
            hitRateLabel: '—',
        });
    });

    it('shows an estimated prompt and an unavailable hit for a usage-less provider', () => {
        const [row] = buildUsageView({
            records: [measuredRecord({
                status: 'no-usage',
                usageSource: 'estimated',
                promptTokens: null,
                hitTokens: null,
                missTokens: null,
                completionTokens: null,
                estimatedPromptTokens: 240,
            })],
            trackingEnabled: true,
        }).rows;

        expect(row.promptLabel).toBe('~240');
        expect(row.hitLabel).toBe('—');
        expect(row.hitRateLabel).toBe('—');
        expect(row.sourceLabel).toBe('estimated');
    });

    it('discloses when the hit rate covers only part of the prompt tokens', () => {
        const view = buildUsageView({
            records: [
                deepseekRecord({ promptTokens: 1000, hitTokens: 500, missTokens: 500 }),
                deepseekRecord({ recordId: 'rec-2', promptTokens: 100, hitTokens: null, missTokens: null }),
            ],
            trackingEnabled: true,
            prices: deepseekPrices,
        });

        expect(view.cards[0].hitRateNote).toBe('1,000 of 1,100 prompt tokens');
    });

    it('adds a per-row hit percentage, cost and saving', () => {
        const [row] = buildUsageView({
            records: [deepseekRecord()],
            trackingEnabled: true,
            prices: deepseekPrices,
        }).rows;

        expect(row.hitRateLabel).toBe('75.0%');
        expect(row.costLabel).toBe('$0.00010770');
        expect(row.costSource).toBe('estimated');
        expect(row.savingLabel).toBe('$0.00013230');
        expect(row.savingSource).toBe('estimated');
    });
});

describe('usage panel — editable price table', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('updates the saving without a reload when a price changes', () => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
        const settings = {
            usage_tracking_enabled: true,
            usage_prices: structuredClone(deepseekPrices),
        };
        const ledger = { recordsFor: () => [deepseekRecord()] };
        const onPricesChange = vi.fn();

        initializeUsagePanel({
            settings,
            ledger,
            getChatId: () => 'chat-1',
            onPricesChange,
        });

        const panel = document.getElementById('VectFox_usage_panel');
        const savingBefore = panel.querySelector('[data-usage-card="all"] [data-usage-metric="saving"]').textContent;

        const hitInput = panel.querySelector('[data-usage-price-index="0"][data-usage-price-field="hit"]');
        const nextInput = panel.querySelector('[data-usage-price-index="0"][data-usage-price-field="miss"]');
        nextInput.focus();
        hitInput.value = '0.1';
        hitInput.dispatchEvent(new Event('change', { bubbles: true }));

        // The in-place results refresh must not replace the price editor and
        // steal focus from the field the user tabbed into.
        expect(document.activeElement).toBe(nextInput);

        expect(settings.usage_prices.entries[0].hit).toBe(0.1);
        expect(onPricesChange).toHaveBeenCalled();
        const savingAfter = panel.querySelector('[data-usage-card="all"] [data-usage-metric="saving"]').textContent;
        expect(savingAfter).not.toBe(savingBefore);
        expect(savingAfter).toContain('$0.00004500');
    });
});
