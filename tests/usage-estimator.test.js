/**
 * Usage estimator — prompt-token estimates for providers that omit usage.
 *
 * The observer only estimates the prompt when the provider reported no usage;
 * cache hit is never estimated. The SillyTavern tokenizer is loaded lazily and
 * through an injected loader, so an unavailable tokenizer leaves the record
 * "unavailable" instead of breaking the extension.
 */

import { describe, it, expect, vi } from 'vitest';

import { createPromptTokenEstimator } from '../core/usage-estimator.js';

function fakeTokenizer(countByText) {
    return {
        getTokenCountAsync: vi.fn(async (text) => countByText[text] ?? 0),
    };
}

describe('usage estimator', () => {
    it('counts each text message through the injected tokenizer', async () => {
        const tokenizer = fakeTokenizer({ hello: 10, world: 25 });
        const estimate = createPromptTokenEstimator({ loadTokenizer: async () => tokenizer });

        await expect(estimate([
            { role: 'system', content: 'hello' },
            { role: 'user', content: 'world' },
            { role: 'assistant', content: '' },
        ])).resolves.toBe(35);

        expect(tokenizer.getTokenCountAsync).toHaveBeenCalledTimes(2);
    });

    it('flattens multimodal message text parts', async () => {
        const tokenizer = fakeTokenizer({ 'first\nsecond': 7 });
        const estimate = createPromptTokenEstimator({ loadTokenizer: async () => tokenizer });

        await expect(estimate([
            { role: 'user', content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] },
        ])).resolves.toBe(7);
    });

    it('loads the tokenizer once for several estimates', async () => {
        const tokenizer = fakeTokenizer({ hi: 1 });
        const loadTokenizer = vi.fn(async () => tokenizer);
        const estimate = createPromptTokenEstimator({ loadTokenizer });

        await estimate([{ content: 'hi' }]);
        await estimate([{ content: 'hi' }]);

        expect(loadTokenizer).toHaveBeenCalledTimes(1);
    });

    it('stays unavailable when the tokenizer cannot load or count', async () => {
        const missing = createPromptTokenEstimator({ loadTokenizer: async () => null });
        await expect(missing([{ content: 'hi' }])).resolves.toBeNull();

        const failing = createPromptTokenEstimator({
            loadTokenizer: async () => ({
                getTokenCountAsync: async () => {
                    throw new Error('tokenizer failed');
                },
            }),
        });
        await expect(failing([{ content: 'hi' }])).resolves.toBeNull();
    });

    it('stays unavailable without messages or a usable count', async () => {
        const tokenizer = fakeTokenizer({});
        const estimate = createPromptTokenEstimator({ loadTokenizer: async () => tokenizer });

        await expect(estimate(null)).resolves.toBeNull();
        await expect(estimate([{ content: '' }])).resolves.toBeNull();
    });
});
