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
