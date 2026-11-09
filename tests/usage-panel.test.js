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
        expect(panel.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(panel.textContent).toContain('openrouter / deepseek/deepseek-v3');
        expect(panel.querySelector('#VectFox_usage_tracking_enabled').checked).toBe(true);

        const toggle = panel.querySelector('#VectFox_usage_tracking_enabled');
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));

        expect(onTrackingChange).toHaveBeenCalledWith(false);
        expect(settings.usage_tracking_enabled).toBe(false);

        ledger.recordsFor = () => [];
        refresh();
        expect(panel.querySelectorAll('tbody tr')).toHaveLength(0);
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
