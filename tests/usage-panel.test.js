/**
 * Usage panel — the view-model seam.
 *
 * Pure formatting is tested directly; thin jsdom smokes prove the panel mounts,
 * renders rows and reflects the toggle, run filter and price editor. Layout
 * stays manually verified.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { buildUsageView, initializeUsagePanel } from '../ui/usage-panel.js';
import { usageAccumulator as accumulator, usageRecord } from './fixtures/usage.js';

function measuredRecord(overrides = {}) {
    return usageRecord({
        provider: 'openrouter',
        model: 'deepseek/deepseek-v3',
        promptTokens: 1200,
        hitTokens: 900,
        missTokens: 300,
        completionTokens: 100,
        totalTokens: 1300,
        stream: false,
        httpStatus: 200,
        ...overrides,
    });
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

const runsFixture = [
    { runId: 'run-b', label: 'Run 2', startedAt: 1_700_000_060_000, endedAt: null },
    { runId: 'run-a', label: 'Run 1', startedAt: 1_700_000_000_000, endedAt: 1_700_000_060_000 },
];
const batchOne = { ghostEnabled: true, ghostBatchSize: 1, ghostKeepRecent: 10 };
const batchThirty = { ghostEnabled: true, ghostBatchSize: 30, ghostKeepRecent: 10 };

describe('usage view model — measurement runs', () => {
    it('filters rows, cards and configurations to the selected run, keeping every run selectable', () => {
        const records = [
            measuredRecord({ recordId: 'rec-b', runId: 'run-b', configuration: batchThirty, promptTokens: 1000, hitTokens: 900, missTokens: 100 }),
            measuredRecord({ recordId: 'rec-a2', runId: 'run-a', configuration: batchOne, promptTokens: 1000, hitTokens: 500, missTokens: 500 }),
            measuredRecord({ recordId: 'rec-a1', runId: 'run-a', configuration: batchOne, promptTokens: 1000, hitTokens: 500, missTokens: 500 }),
        ];

        const view = buildUsageView({
            records,
            trackingEnabled: true,
            runs: runsFixture,
            currentRunId: 'run-b',
            selectedRunId: 'run-a',
            prices: deepseekPrices,
        });

        expect(view.rows.map((row) => row.recordId)).toEqual(['rec-a2', 'rec-a1']);
        expect(view.cards[0]).toMatchObject({ requestsLabel: '2 requests', hitRateLabel: '50.0%' });
        expect(view.configurations).toHaveLength(1);
        expect(view.configurations[0]).toMatchObject({ requestsLabel: '2 requests', hitRateLabel: '50.0%' });
        expect(view.run).toMatchObject({
            currentRunId: 'run-b',
            currentLabel: 'Run 2',
            selectedRunId: 'run-a',
        });
        expect(view.run.options.map((option) => option.runId)).toEqual(['', 'run-b', 'run-a']);
        expect(view.run.options.find((option) => option.runId === 'run-a').selected).toBe(true);
        expect(view.run.options[0].optionLabel).toMatch(/All runs · 3 records$/);
        expect(view.run.options[1].optionLabel).toMatch(/Run 2 · .* \u00b7 1 record$/);
        expect(view.run.options[2].optionLabel).toMatch(/Run 1 · .* \u00b7 2 records$/);
    });

    it('explains an empty selected run instead of showing the tracking empty state', () => {
        const view = buildUsageView({
            records: [measuredRecord({ recordId: 'rec-a', runId: 'run-a' })],
            trackingEnabled: true,
            runs: runsFixture,
            selectedRunId: 'run-b',
        });

        expect(view.empty).toBe(true);
        expect(view.emptyMessage).toMatch(/no requests in this measurement run/i);
    });

    it('shows an empty run bar when the chat has no measurement runs', () => {
        const view = buildUsageView({ records: [], trackingEnabled: true, runs: [] });

        expect(view.run).toMatchObject({
            currentRunId: '',
            currentLabel: 'No measurement run',
            selectedRunId: '',
        });
        expect(view.run.options).toHaveLength(1);
        expect(view.run.options[0]).toMatchObject({ runId: '', selected: true });
        expect(view.run.options[0].optionLabel).toBe('All runs · 0 records');
    });

    it('shows every run together by default so old runs stay available', () => {
        const records = [
            measuredRecord({ recordId: 'rec-b', runId: 'run-b' }),
            measuredRecord({ recordId: 'rec-a', runId: 'run-a' }),
        ];

        const view = buildUsageView({ records, trackingEnabled: true, runs: runsFixture, currentRunId: 'run-b' });

        expect(view.run.selectedRunId).toBe('');
        expect(view.rows).toHaveLength(2);
        expect(view.run.currentLabel).toBe('Run 2');
        expect(view.run.options.find((option) => option.runId === '')).toMatchObject({
            label: 'All runs',
            selected: true,
        });
        expect(view.run.options.map((option) => option.label)).toEqual(['All runs', 'Run 2', 'Run 1']);
    });
});

describe('usage view model — by configuration', () => {
    it('groups requests by ghosting state, batch size and keep-recent', () => {
        const view = buildUsageView({
            records: [
                deepseekRecord({ recordId: 'b2', configuration: batchThirty, promptTokens: 1000, hitTokens: 900, missTokens: 100, completionTokens: 100 }),
                deepseekRecord({ recordId: 'b1', configuration: batchThirty, promptTokens: 1000, hitTokens: 900, missTokens: 100, completionTokens: 100 }),
                deepseekRecord({ recordId: 'a2', configuration: batchOne, promptTokens: 1000, hitTokens: 500, missTokens: 500, completionTokens: 100 }),
                deepseekRecord({ recordId: 'a1', configuration: batchOne, promptTokens: 1000, hitTokens: 500, missTokens: 500, completionTokens: 100 }),
            ],
            trackingEnabled: true,
            prices: deepseekPrices,
        });

        expect(view.configurations.map((entry) => entry.label)).toEqual([
            'Ghosting on · batch 1 · keep 10',
            'Ghosting on · batch 30 · keep 10',
        ]);

        expect(view.configurations[0]).toMatchObject({
            requestsLabel: '2 requests',
            averagePromptLabel: '1,000',
            averagePromptSource: 'measured',
            hitRateLabel: '50.0%',
            costPerRequestLabel: '$0.00013650',
            costPerRequestSource: 'estimated',
            savingLabel: '$0.00014700',
            savingSource: 'estimated',
        });
        expect(view.configurations[1]).toMatchObject({
            hitRateLabel: '90.0%',
            costPerRequestLabel: '$0.00007770',
            savingLabel: '$0.00026460',
        });
    });

    it('compares two measurement runs at batch size 1 and batch size 30 without export', () => {
        const records = [
            measuredRecord({
                recordId: 'rec-b',
                runId: 'run-b',
                configuration: batchThirty,
                provider: 'deepseek',
                model: 'deepseek-v4-flash',
                promptTokens: 1000,
                hitTokens: 900,
                missTokens: 100,
                completionTokens: 100,
            }),
            measuredRecord({
                recordId: 'rec-a',
                runId: 'run-a',
                configuration: batchOne,
                provider: 'deepseek',
                model: 'deepseek-v4-flash',
                promptTokens: 1000,
                hitTokens: 500,
                missTokens: 500,
                completionTokens: 100,
            }),
        ];

        const allRuns = buildUsageView({ records, trackingEnabled: true, runs: runsFixture, prices: deepseekPrices });
        expect(allRuns.configurations.map((entry) => [entry.label, entry.hitRateLabel])).toEqual([
            ['Ghosting on · batch 1 · keep 10', '50.0%'],
            ['Ghosting on · batch 30 · keep 10', '90.0%'],
        ]);

        const onlyFirstRun = buildUsageView({
            records,
            trackingEnabled: true,
            runs: runsFixture,
            selectedRunId: 'run-a',
            prices: deepseekPrices,
        });
        expect(onlyFirstRun.configurations).toHaveLength(1);
        expect(onlyFirstRun.configurations[0].label).toBe('Ghosting on · batch 1 · keep 10');
    });

    it('labels an estimated average prompt and an unavailable hit rate honestly', () => {
        const view = buildUsageView({
            records: [
                measuredRecord({
                    status: 'no-usage',
                    usageSource: 'estimated',
                    promptTokens: null,
                    hitTokens: null,
                    missTokens: null,
                    completionTokens: null,
                    estimatedPromptTokens: 480,
                    configuration: batchOne,
                }),
                measuredRecord({
                    recordId: 'rec-unavailable',
                    status: 'no-usage',
                    usageSource: 'unavailable',
                    promptTokens: null,
                    hitTokens: null,
                    missTokens: null,
                    completionTokens: null,
                    configuration: batchThirty,
                }),
            ],
            trackingEnabled: true,
            prices: deepseekPrices,
        });

        expect(view.configurations[0]).toMatchObject({
            label: 'Ghosting on · batch 1 · keep 10',
            averagePromptLabel: '480',
            averagePromptSource: 'estimated',
            hitRateLabel: '—',
            hitRateSource: 'unavailable',
        });
        expect(view.configurations[1]).toMatchObject({
            label: 'Ghosting on · batch 30 · keep 10',
            averagePromptLabel: '—',
            averagePromptSource: 'unavailable',
        });
    });

    it('separates ghosting off from ghosting on and reserves a group for a missing snapshot', () => {
        const view = buildUsageView({
            records: [
                measuredRecord({
                    recordId: 'off',
                    configuration: { ghostEnabled: false, ghostBatchSize: 1, ghostKeepRecent: 10 },
                }),
                measuredRecord({ recordId: 'legacy' }),
            ],
            trackingEnabled: true,
        });

        expect(view.configurations.map((entry) => entry.label)).toEqual([
            'Ghosting off · batch 1 · keep 10',
            'Configuration unknown',
        ]);
        expect(view.configurations.map((entry) => entry.requestsLabel)).toEqual(['1 request', '1 request']);
    });

    it('notes which prompt tokens the configuration hit rate covers', () => {
        const view = buildUsageView({
            records: [
                deepseekRecord({ recordId: 'a', configuration: batchOne, promptTokens: 1000, hitTokens: 500, missTokens: 500 }),
                deepseekRecord({ recordId: 'b', configuration: batchOne, promptTokens: 100, hitTokens: null, missTokens: null }),
                deepseekRecord({
                    recordId: 'c',
                    configuration: batchOne,
                    status: 'no-usage',
                    usageSource: 'estimated',
                    promptTokens: null,
                    hitTokens: null,
                    missTokens: null,
                    completionTokens: null,
                    estimatedPromptTokens: 500,
                }),
            ],
            trackingEnabled: true,
            prices: deepseekPrices,
        });

        expect(view.configurations[0].hitRateNote).toBe('1,000 of 1,600 prompt tokens');
    });

    it('keeps failed requests out of the configuration comparison', () => {
        const view = buildUsageView({
            records: [measuredRecord({ status: 'error', configuration: batchOne })],
            trackingEnabled: true,
            prices: deepseekPrices,
        });

        expect(view.empty).toBe(false);
        expect(view.rows).toHaveLength(1);
        expect(view.configurations).toEqual([]);
    });
});

describe('usage panel — measurement runs smoke', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('resets the run filter when the active chat changes', () => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
        const settings = { usage_tracking_enabled: true };
        let chatId = 'chat-1';
        const ledger = {
            recordsFor: (chat) => chat === 'chat-1'
                ? [measuredRecord({ recordId: 'rec-a', runId: 'run-a' })]
                : [measuredRecord({ recordId: 'rec-c', runId: 'run-c' })],
            runsFor: (chat) => chat === 'chat-1'
                ? runsFixture
                : [{ runId: 'run-c', label: 'Run 1', startedAt: 1_700_000_100_000, endedAt: null }],
            currentRunIdFor: (chat) => chat === 'chat-1' ? 'run-b' : 'run-c',
        };

        const refresh = initializeUsagePanel({ settings, ledger, getChatId: () => chatId });
        const panel = document.getElementById('VectFox_usage_panel');
        const select = panel.querySelector('[data-usage-run-select]');
        select.value = 'run-a';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(panel.querySelector('.vectfox-usage-requests-table tbody')).not.toBeNull();
        expect(panel.textContent).toContain('Run 1');

        chatId = 'chat-2';
        refresh();

        const selectAfter = panel.querySelector('[data-usage-run-select]');
        expect(selectAfter.value).toBe('');
        expect(panel.querySelectorAll('.vectfox-usage-requests-table tbody tr')).toHaveLength(1);
    });

    it('starts a run and filters the request table by the selected run', () => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
        const settings = { usage_tracking_enabled: true };
        const records = [
            measuredRecord({ recordId: 'rec-b', runId: 'run-b', model: 'deepseek-batch-30', configuration: batchThirty }),
            measuredRecord({ recordId: 'rec-a', runId: 'run-a', model: 'deepseek-batch-1', configuration: batchOne }),
        ];
        const ledger = {
            recordsFor: () => records,
            runsFor: () => runsFixture,
            currentRunIdFor: () => 'run-b',
        };
        const onRunStart = vi.fn();

        initializeUsagePanel({
            settings,
            ledger,
            getChatId: () => 'chat-1',
            onRunStart,
        });

        const panel = document.getElementById('VectFox_usage_panel');
        expect(panel.querySelectorAll('.vectfox-usage-requests-table tbody tr')).toHaveLength(2);
        expect(panel.textContent).toMatch(/Run 2/);
        expect(panel.querySelectorAll('.vectfox-usage-configurations-table tbody tr')).toHaveLength(2);
        expect(panel.textContent).toContain('Avg prompt');
        expect(panel.textContent).toContain('Cost / request');
        expect(panel.textContent).toContain('Ghosting on · batch 1 · keep 10');
        expect(panel.textContent).toContain('Ghosting on · batch 30 · keep 10');

        panel.querySelector('[data-usage-run-start]').click();
        expect(onRunStart).toHaveBeenCalledTimes(1);

        const select = panel.querySelector('[data-usage-run-select]');
        select.value = 'run-a';
        select.dispatchEvent(new Event('change', { bubbles: true }));

        // Filtering updates the results, not the select the user just used.
        expect(panel.querySelector('[data-usage-run-select]')).toBe(select);
        const rows = panel.querySelectorAll('.vectfox-usage-requests-table tbody tr');
        expect(rows).toHaveLength(1);
        expect(panel.textContent).toContain('deepseek-batch-1');
        expect(panel.textContent).not.toContain('deepseek-batch-30');
        expect(panel.querySelectorAll('.vectfox-usage-configurations-table tbody tr')).toHaveLength(1);
        expect(panel.textContent).toContain('Ghosting on · batch 1 · keep 10');
        expect(panel.textContent).not.toContain('Ghosting on · batch 30 · keep 10');
    });

    it('moves a filtered view to the new run when a measurement starts', () => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
        const settings = { usage_tracking_enabled: true };
        let currentRunId = 'run-b';
        let runs = [...runsFixture];
        const records = [
            measuredRecord({ recordId: 'rec-b', runId: 'run-b', model: 'deepseek-batch-30' }),
            measuredRecord({ recordId: 'rec-a', runId: 'run-a', model: 'deepseek-batch-1' }),
        ];
        const ledger = {
            recordsFor: () => records,
            runsFor: () => runs,
            currentRunIdFor: () => currentRunId,
        };

        initializeUsagePanel({
            settings,
            ledger,
            getChatId: () => 'chat-1',
            onRunStart: () => {
                currentRunId = 'run-new';
                runs = [{ runId: 'run-new', label: 'Run 3', startedAt: 1_700_000_120_000, endedAt: null }, ...runs];
            },
        });

        const panel = document.getElementById('VectFox_usage_panel');
        const select = panel.querySelector('[data-usage-run-select]');
        select.value = 'run-a';
        select.dispatchEvent(new Event('change', { bubbles: true }));

        panel.querySelector('[data-usage-run-start]').click();

        expect(panel.querySelector('[data-usage-run-select]').value).toBe('run-new');
        expect(panel.textContent).toMatch(/no requests in this measurement run/i);
    });
});


describe('usage view model — durable totals', () => {
    it('adds the archived counters of capped rows to the cards and configurations', () => {
        const archived = {
            total: accumulator({
                requests: 1,
                measuredRequests: 1,
                ratedRequests: 1,
                coveredRequests: 1,
                promptTokens: 2000,
                hitTokens: 1000,
                ratedPromptTokens: 2000,
            }),
            byOrigin: {
                story: accumulator({
                    requests: 1,
                    measuredRequests: 1,
                    ratedRequests: 1,
                    coveredRequests: 1,
                    promptTokens: 2000,
                    hitTokens: 1000,
                    ratedPromptTokens: 2000,
                }),
            },
            byConfiguration: {
                'ghost:on:batch:30:keep:10': {
                    configuration: batchThirty,
                    accumulator: accumulator({
                        requests: 1,
                        measuredRequests: 1,
                        ratedRequests: 1,
                        coveredRequests: 1,
                        promptTokens: 2000,
                        hitTokens: 1000,
                        ratedPromptTokens: 2000,
                    }),
                },
            },
        };

        const view = buildUsageView({
            records: [deepseekRecord({ recordId: 'retained', promptTokens: 1000, hitTokens: 500, configuration: batchOne })],
            trackingEnabled: true,
            prices: deepseekPrices,
            archived,
        });

        expect(view.cards[0]).toMatchObject({
            requestsLabel: '2 requests',
            promptLabel: '3,000',
            hitLabel: '1,500',
            hitRateLabel: '50.0%',
        });
        expect(view.configurations.map((entry) => entry.label)).toEqual([
            'Ghosting on · batch 1 · keep 10',
            'Ghosting on · batch 30 · keep 10',
        ]);
        expect(view.configurations[1]).toMatchObject({ requestsLabel: '1 request', hitRateLabel: '50.0%' });
    });

    it('states the 500-record cap and that the totals include the dropped rows', () => {
        const view = buildUsageView({
            records: [measuredRecord()],
            trackingEnabled: true,
            retention: { limit: 500, retained: 1, total: 640 },
        });

        expect(view.retention).toMatchObject({ limit: 500, retained: 1, total: 640, capped: true });
        expect(view.retention.label).toMatch(/newest 500 of 640 records/i);
        expect(view.retention.label).toMatch(/exclude failed and aborted rows/i);
    });

    it('states the cap even when nothing has been dropped yet', () => {
        const view = buildUsageView({
            records: [measuredRecord()],
            trackingEnabled: true,
            retention: { limit: 500, retained: 1, total: 1 },
        });

        expect(view.retention.capped).toBe(false);
        expect(view.retention.label).toMatch(/newest 500/i);
    });

    it('shows the all-time total across chats from the stored buckets', () => {
        const view = buildUsageView({
            records: [measuredRecord()],
            trackingEnabled: true,
            prices: deepseekPrices,
            allTime: {
                totals: accumulator({
                    requests: 3,
                    measuredRequests: 3,
                    ratedRequests: 3,
                    coveredRequests: 3,
                    promptTokens: 3000,
                    hitTokens: 1500,
                    ratedPromptTokens: 3000,
                }),
                chats: 2,
            },
        });

        expect(view.allTime).toMatchObject({
            title: 'All time · all chats',
            requestsLabel: '3 requests',
            detailLabel: '2 chats · 3 requests',
            hitRateLabel: '50.0%',
        });
    });

    it('ignores archived rows under a single-run filter because they cannot be attributed to a run', () => {
        const view = buildUsageView({
            records: [measuredRecord({ recordId: 'rec-a', runId: 'run-a' })],
            trackingEnabled: true,
            runs: runsFixture,
            selectedRunId: 'run-a',
            archived: {
                total: accumulator({ requests: 1, measuredRequests: 1, coveredRequests: 1, promptTokens: 2000 }),
                byOrigin: {},
                byConfiguration: {},
            },
        });

        expect(view.cards[0].requestsLabel).toBe('1 request');
        expect(view.cards[0].promptLabel).toBe('1,200');
    });
});

describe('usage view model — durable metric labels', () => {
    it('labels an estimated-only all-time card without inventing a hit rate or a cost', () => {
        const view = buildUsageView({
            records: [],
            trackingEnabled: true,
            allTime: {
                totals: accumulator({
                    requests: 1,
                    estimatedRequests: 1,
                    estimatedPromptRequests: 1,
                    estimatedPromptTokens: 480,
                }),
                chats: 1,
            },
        });

        expect(view.allTime).toMatchObject({
            requestsLabel: '1 request',
            promptLabel: '~480',
            promptSource: 'estimated',
            hitLabel: '—',
            hitSource: 'unavailable',
            hitRateLabel: '—',
            hitRateSource: 'unavailable',
            coverageLabel: '0.0%',
            coverageSource: 'estimated',
            costLabel: '—',
            costSource: 'unavailable',
            savingLabel: '—',
            savingSource: 'unavailable',
        });
    });

    it('labels an unavailable-only all-time card with no prompt and no coverage source', () => {
        const view = buildUsageView({
            records: [],
            trackingEnabled: true,
            allTime: {
                totals: accumulator({ requests: 1, unavailableRequests: 1 }),
                chats: 1,
            },
        });

        expect(view.allTime).toMatchObject({
            promptLabel: '—',
            promptSource: 'unavailable',
            coverageLabel: '0.0%',
            coverageSource: 'unavailable',
            hitRateSource: 'unavailable',
        });
    });

    it('mixes measured and estimated archived rows and keeps every source honest', () => {
        const view = buildUsageView({
            records: [],
            trackingEnabled: true,
            prices: deepseekPrices,
            allTime: {
                totals: accumulator({
                    requests: 2,
                    measuredRequests: 1,
                    estimatedRequests: 1,
                    ratedRequests: 1,
                    coveredRequests: 1,
                    estimatedPromptRequests: 1,
                    promptTokens: 1000,
                    estimatedPromptTokens: 500,
                    hitTokens: 500,
                    ratedPromptTokens: 1000,
                    costMeasured: 0.0001,
                    costMeasuredRequests: 1,
                    costEstimated: 0.0002,
                    costEstimatedRequests: 1,
                    savingMeasured: 0.00005,
                    savingMeasuredRequests: 1,
                    savingEstimated: 0.00001,
                    savingEstimatedRequests: 1,
                }),
                chats: 1,
            },
        });

        expect(view.allTime).toMatchObject({
            promptLabel: '1,000 + ~500',
            promptSource: 'estimated',
            hitRateLabel: '50.0%',
            hitRateSource: 'measured',
            coverageLabel: '66.7%',
            coverageSource: 'estimated',
            costLabel: '$0.00030000',
            costSource: 'estimated',
            savingLabel: '$0.00006000',
            savingSource: 'estimated',
        });
    });
});

describe('usage view model — cap note under a run filter', () => {
    it('does not claim the all-record totals when one run is selected', () => {
        const view = buildUsageView({
            records: [measuredRecord({ recordId: 'rec-a', runId: 'run-a' })],
            trackingEnabled: true,
            runs: runsFixture,
            selectedRunId: 'run-a',
            retention: { limit: 500, retained: 1, total: 640 },
        });

        expect(view.retention).toMatchObject({ capped: false });
        expect(view.retention.label).toMatch(/measurement run only/i);
        expect(view.retention.label).toMatch(/cap evicted are not included/i);
        expect(view.retention.label).toMatch(/newest 500/i);
        expect(view.retention.label).not.toMatch(/640/);
    });

    it('still shows the empty-run message when the chat is over the cap', () => {
        const view = buildUsageView({
            records: [measuredRecord({ recordId: 'rec-a', runId: 'run-a' })],
            trackingEnabled: true,
            runs: runsFixture,
            selectedRunId: 'run-b',
            retention: { limit: 500, retained: 1, total: 640 },
        });

        expect(view.empty).toBe(true);
        expect(view.emptyMessage).toMatch(/no requests in this measurement run/i);
    });
});

describe('usage panel — empty run with a capped chat', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('keeps the cap disclosure when the selected run has no retained rows', () => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
        const settings = { usage_tracking_enabled: true };
        const ledger = {
            recordsFor: () => [measuredRecord({ recordId: 'rec-a', runId: 'run-a' })],
            runsFor: () => runsFixture,
            currentRunIdFor: () => 'run-b',
            retentionFor: () => ({ limit: 500, retained: 500, total: 640 }),
        };

        initializeUsagePanel({ settings, ledger, getChatId: () => 'chat-1' });

        const panel = document.getElementById('VectFox_usage_panel');
        const select = panel.querySelector('[data-usage-run-select]');
        select.value = 'run-b';
        select.dispatchEvent(new Event('change', { bubbles: true }));

        expect(panel.textContent).toMatch(/no requests in this measurement run/i);
        expect(panel.textContent).toMatch(/cap evicted are not included/i);
    });
});

describe('usage panel — durable totals smoke', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('renders the retention note, the all-time card and archived totals', () => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
        const settings = { usage_tracking_enabled: true };
        const ledger = {
            recordsFor: () => [measuredRecord()],
            runsFor: () => [],
            currentRunIdFor: () => '',
            archivedFor: () => ({
                total: accumulator({
                    requests: 1,
                    measuredRequests: 1,
                    ratedRequests: 1,
                    coveredRequests: 1,
                    promptTokens: 1000,
                    hitTokens: 500,
                    ratedPromptTokens: 1000,
                }),
                byOrigin: {},
                byConfiguration: {},
            }),
            retentionFor: () => ({ limit: 500, retained: 500, total: 640 }),
            allTimeForView: () => ({
                totals: accumulator({
                    requests: 2,
                    measuredRequests: 2,
                    ratedRequests: 2,
                    coveredRequests: 2,
                    promptTokens: 2000,
                    hitTokens: 1000,
                    ratedPromptTokens: 2000,
                }),
                chats: 1,
            }),
        };

        initializeUsagePanel({
            settings,
            ledger,
            getChatId: () => 'chat-1',
            getHealth: () => ({ matched: 2, captured: 2, skipped: 0, errors: 0 }),
        });

        const panel = document.getElementById('VectFox_usage_panel');
        expect(panel.textContent).toMatch(/newest 500 of 640 records/i);
        expect(panel.querySelector('[data-usage-alltime]')).not.toBeNull();
        expect(panel.textContent).toMatch(/All time · all chats/);
        expect(panel.textContent).toMatch(/2 requests/);
        expect(panel.querySelector('[data-usage-card="all"]').textContent).toMatch(/2 requests/);
    });
});

describe('usage view model — prefix diagnostics', () => {
    it('shows the shared-prefix tokens of a comparable row', () => {
        const [row] = buildUsageView({
            records: [measuredRecord({ sharedPrefixTokens: 2200 })],
            trackingEnabled: true,
        }).rows;

        expect(row.sharedPrefixLabel).toBe('2,200');
        expect(row.sharedPrefixSource).toBe('estimated');
        expect(row.prefixBreakerLabel).toBe('');
    });

    it('leaves the shared prefix empty when there is no comparable prior', () => {
        const [row] = buildUsageView({
            records: [measuredRecord({ sharedPrefixTokens: null })],
            trackingEnabled: true,
        }).rows;

        expect(row.sharedPrefixLabel).toBe('—');
        expect(row.sharedPrefixSource).toBe('');
    });

    it('flags a zero-hit row with a long shared prefix in words', () => {
        const [row] = buildUsageView({
            records: [measuredRecord({
                hitTokens: 0,
                sharedPrefixTokens: 2200,
                possiblePrefixBreaker: true,
            })],
            trackingEnabled: true,
        }).rows;

        expect(row.sharedPrefixLabel).toBe('2,200');
        expect(row.prefixBreakerLabel).toBe('Possible prefix breaker');
    });

    it('does not flag a zero-hit row with a short shared prefix', () => {
        const [row] = buildUsageView({
            records: [measuredRecord({ hitTokens: 0, sharedPrefixTokens: 780 })],
            trackingEnabled: true,
        }).rows;

        expect(row.prefixBreakerLabel).toBe('');
    });
});

describe('usage panel — prefix diagnostics smoke', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
    });

    it('renders the shared-prefix column and the breaker flag', () => {
        initializeUsagePanel({
            settings: { usage_tracking_enabled: true },
            ledger: {
                recordsFor: () => [measuredRecord({
                    hitTokens: 0,
                    sharedPrefixTokens: 2200,
                    possiblePrefixBreaker: true,
                })],
            },
            getChatId: () => 'chat-1',
        });

        const panel = document.getElementById('VectFox_usage_panel');
        const headers = [...panel.querySelectorAll('.vectfox-usage-requests-table thead th')]
            .map((header) => header.textContent.trim());
        expect(headers).toContain('Shared prefix');
        expect(panel.textContent).toContain('2,200');
        expect(panel.querySelector('[data-usage-prefix-flag]')).not.toBeNull();
        expect(panel.textContent).toContain('Possible prefix breaker');
    });

    it('renders an em dash when no comparable prior exists', () => {
        initializeUsagePanel({
            settings: { usage_tracking_enabled: true },
            ledger: { recordsFor: () => [measuredRecord()] },
            getChatId: () => 'chat-1',
        });

        const panel = document.getElementById('VectFox_usage_panel');
        expect(panel.querySelector('[data-usage-prefix-flag]')).toBeNull();
        const cells = [...panel.querySelectorAll('.vectfox-usage-requests-table tbody td')];
        expect(cells.some((cell) => cell.textContent.trim() === '—')).toBe(true);
    });
});

describe('usage panel — export smoke', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
    });

    it('downloads a versioned export with records, runs and aggregates but no prompt text', () => {
        const downloadFile = vi.fn();
        const ledger = {
            exportSnapshotFor: () => ({
                records: [measuredRecord({
                    sharedPrefixTokens: 2400,
                    promptText: 'SECRET PROMPT TEXT',
                })],
                runs: [{ runId: 'run-1', label: 'Run 1', startedAt: 1_700_000_000_000, endedAt: null }],
                currentRunId: 'run-1',
                archived: {
                    total: accumulator({ requests: 1 }),
                    byOrigin: {},
                    byModel: {},
                    byConfiguration: {},
                },
                retention: { limit: 500, retained: 1, total: 1 },
                allTime: {
                    totals: accumulator({ requests: 1 }),
                    buckets: { 'chat-1': accumulator({ requests: 1 }) },
                },
            }),
        };

        initializeUsagePanel({
            settings: { usage_tracking_enabled: true },
            ledger,
            getChatId: () => 'chat-1',
            downloadFile,
            now: () => Date.UTC(2026, 10, 10, 12, 34, 56),
        });

        const panel = document.getElementById('VectFox_usage_panel');
        panel.querySelector('[data-usage-export]').click();

        expect(downloadFile).toHaveBeenCalledTimes(1);
        const [filename, content] = downloadFile.mock.calls[0];
        expect(filename).toBe('vectfox-usage-chat-1-20261110-123456.json');
        expect(content).not.toContain('SECRET PROMPT TEXT');

        const exported = JSON.parse(content);
        expect(exported.version).toBe(1);
        expect(exported.chatId).toBe('chat-1');
        expect(exported.records[0]).toMatchObject({ recordId: 'rec-1', sharedPrefixTokens: 2400 });
        expect(exported.runs[0]).toMatchObject({ runId: 'run-1' });
        expect(exported.aggregates.archived.total.requests).toBe(1);
        expect(exported.aggregates.allTime.chats['chat-1'].requests).toBe(1);
        expect(exported.currentPrices.entries[0].model).toBe('deepseek-v4-flash');
    });
});

describe('usage panel — reset smoke', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
    });

    it('resets the current chat only after the confirmation accepts', () => {
        let cleared = false;
        const confirmReset = vi.fn(() => false);
        const onResetChat = vi.fn(() => {
            cleared = true;
        });
        const ledger = {
            recordsFor: () => (cleared ? [] : [measuredRecord()]),
            runsFor: () => [],
            currentRunIdFor: () => '',
        };

        initializeUsagePanel({
            settings: { usage_tracking_enabled: true },
            ledger,
            getChatId: () => 'chat-1',
            confirmReset,
            onResetChat,
        });

        const panel = document.getElementById('VectFox_usage_panel');
        panel.querySelector('[data-usage-reset="chat"]').click();

        expect(confirmReset).toHaveBeenCalledTimes(1);
        expect(confirmReset.mock.calls[0][0]).toMatch(/current chat/i);
        expect(onResetChat).not.toHaveBeenCalled();
        expect(panel.querySelectorAll('.vectfox-usage-requests-table tbody tr')).toHaveLength(1);

        confirmReset.mockReturnValue(true);
        panel.querySelector('[data-usage-reset="chat"]').click();

        expect(onResetChat).toHaveBeenCalledTimes(1);
        expect(panel.querySelectorAll('.vectfox-usage-requests-table tbody tr')).toHaveLength(0);
        expect(panel.textContent).toMatch(/tracking is on/i);
    });

    it('asks about all-time separately and never calls the chat reset', () => {
        const confirmReset = vi.fn(() => true);
        const onResetChat = vi.fn();
        const onResetAllTime = vi.fn();

        initializeUsagePanel({
            settings: { usage_tracking_enabled: true },
            ledger: { recordsFor: () => [measuredRecord()] },
            getChatId: () => 'chat-1',
            confirmReset,
            onResetChat,
            onResetAllTime,
        });

        const panel = document.getElementById('VectFox_usage_panel');
        panel.querySelector('[data-usage-reset="all-time"]').click();

        expect(confirmReset).toHaveBeenCalledTimes(1);
        expect(confirmReset.mock.calls[0][0]).toMatch(/all-time/i);
        expect(onResetAllTime).toHaveBeenCalledTimes(1);
        expect(onResetChat).not.toHaveBeenCalled();
    });
});

describe('usage panel — help smoke', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="VectFox_usage_panel"></div>';
    });

    it('explains the hit rate, the source labels and the measurement caveats', () => {
        initializeUsagePanel({
            settings: { usage_tracking_enabled: false },
            ledger: { recordsFor: () => [] },
            getChatId: () => null,
        });

        const help = document.getElementById('VectFox_usage_panel').querySelector('[data-usage-help]');
        expect(help).not.toBeNull();
        const text = help.textContent;

        expect(text).toMatch(/token-weighted/i);
        expect(text).toMatch(/measured/i);
        expect(text).toMatch(/estimated/i);
        expect(text).toMatch(/unavailable/i);
        expect(text).toMatch(/coverage/i);
        expect(text).toMatch(/expire/i);
        expect(text).toMatch(/\{\{time\}\}/);
        expect(text).toMatch(/World Info/i);
        expect(text).toMatch(/Author's Note/i);
        expect(text).toMatch(/context budget/i);
        expect(text).toMatch(/aborted/i);
        expect(text).toMatch(/full-prefix/i);
        expect(text).toMatch(/cannot produce a hit rate/i);
    });
});
