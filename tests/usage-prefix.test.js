/**
 * Usage prefix — the pure hashing and comparison maths behind prefix
 * diagnostics.
 *
 * The fingerprint carries a stable hash per request message plus an estimated
 * token count, never the message text. Comparison is positional from the first
 * message and only across the same provider, model and origin.
 */

import { describe, it, expect } from 'vitest';

import {
    comparePromptFingerprints,
    createPromptFingerprint,
    isPossiblePrefixBreaker,
    normalizePromptFingerprint,
    normalizePromptFingerprints,
    promptFingerprintKey,
} from '../core/usage-prefix.js';

function hashOf(message) {
    return createPromptFingerprint({
        provider: 'deepseek',
        model: 'deepseek-chat',
        origin: 'story',
        messages: [message],
        tokenCounts: [1],
    }).messages[0].hash;
}

function fingerprint(overrides = {}) {
    return createPromptFingerprint({
        provider: 'deepseek',
        model: 'deepseek-chat',
        origin: 'story',
        messages: [
            { role: 'system', content: 'a stable system prompt' },
            { role: 'user', content: 'hello' },
        ],
        tokenCounts: [1500, 700],
        ...overrides,
    });
}

describe('usage prefix — message hashes', () => {
    it('hashes the same message the same way and different text differently', () => {
        const first = hashOf({ role: 'user', content: 'hello' });
        const same = hashOf({ role: 'user', content: 'hello' });
        const changed = hashOf({ role: 'user', content: 'hello!' });

        expect(first).toBe(same);
        expect(changed).not.toBe(first);
        expect(Number.isSafeInteger(first)).toBe(true);
    });

    it('includes the role in the hash so a role change breaks the match', () => {
        const user = hashOf({ role: 'user', content: 'hello' });
        const assistant = hashOf({ role: 'assistant', content: 'hello' });

        expect(assistant).not.toBe(user);
    });

    it('flattens multimodal text parts and still never keeps the text', () => {
        const textOnly = fingerprint();
        const multimodal = createPromptFingerprint({
            provider: 'deepseek',
            model: 'deepseek-chat',
            origin: 'story',
            messages: [
                { role: 'system', content: [{ type: 'text', text: 'a stable system prompt' }] },
                { role: 'user', content: [{ type: 'text', text: 'hello' }] },
            ],
            tokenCounts: [1500, 700],
        });

        expect(multimodal.messages.map((entry) => entry.hash))
            .toEqual(textOnly.messages.map((entry) => entry.hash));
        expect(JSON.stringify(multimodal)).not.toContain('a stable system prompt');
        expect(JSON.stringify(multimodal)).not.toContain('hello');
    });
});

describe('usage prefix — fingerprint shape', () => {
    it('keeps one hash and one token count per message', () => {
        const value = fingerprint();

        expect(value.provider).toBe('deepseek');
        expect(value.model).toBe('deepseek-chat');
        expect(value.origin).toBe('story');
        expect(value.messages).toHaveLength(2);
        expect(value.messages.map((entry) => entry.tokens)).toEqual([1500, 700]);
        expect(value.messages.every((entry) => typeof entry.hash === 'number')).toBe(true);
        expect(value.messages[0]).not.toHaveProperty('content');
    });

    it('leaves a missing token count unavailable instead of inventing a zero', () => {
        const [first, second] = fingerprint({ tokenCounts: [null, 700] }).messages;

        expect(first.tokens).toBeNull();
        expect(second.tokens).toBe(700);
    });

    it('refuses a fingerprint without messages', () => {
        expect(createPromptFingerprint({ provider: 'deepseek', messages: [], tokenCounts: [] })).toBeNull();
        expect(createPromptFingerprint({ provider: 'deepseek' })).toBeNull();
    });

    it('normalizes a corrupt stored value to null and strips unknown fields', () => {
        expect(normalizePromptFingerprint(null)).toBeNull();
        expect(normalizePromptFingerprint('text')).toBeNull();
        expect(normalizePromptFingerprint({ messages: [] })).toBeNull();
        expect(normalizePromptFingerprint({ messages: [{ tokens: 5 }] })).toBeNull();

        const normalized = normalizePromptFingerprint({
            provider: 'deepseek',
            model: 'deepseek-chat',
            origin: 'story',
            text: 'secret prompt',
            messages: [{ hash: 42, tokens: 10, content: 'secret prompt' }],
        });
        expect(normalized).toEqual({
            provider: 'deepseek',
            model: 'deepseek-chat',
            origin: 'story',
            messages: [{ hash: 42, tokens: 10 }],
        });
        expect(JSON.stringify(normalized)).not.toContain('secret');
    });

});

describe('usage prefix — comparability', () => {
    it('sums the leading messages that match positionally', () => {
        const previous = fingerprint();
        const current = fingerprint({
            messages: [
                { role: 'system', content: 'a stable system prompt' },
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi there' },
            ],
            tokenCounts: [1500, 700, 300],
        });

        expect(comparePromptFingerprints(previous, current)).toBe(2200);
    });

    it('stops at the first difference instead of counting a later match', () => {
        const previous = fingerprint();
        const current = fingerprint({
            messages: [
                { role: 'system', content: 'a stable system prompt' },
                { role: 'user', content: 'something else' },
                { role: 'user', content: 'hello' },
            ],
            tokenCounts: [1500, 900, 700],
        });

        expect(comparePromptFingerprints(previous, current)).toBe(1500);
    });

    it('reports a zero shared prefix when the first message already differs', () => {
        const previous = fingerprint();
        const current = fingerprint({
            messages: [
                { role: 'system', content: 'a different system prompt' },
                { role: 'user', content: 'hello' },
            ],
        });

        expect(comparePromptFingerprints(previous, current)).toBe(0);
    });

    it('clears the comparison when provider, model or origin changes', () => {
        const previous = fingerprint();

        expect(comparePromptFingerprints(previous, fingerprint({ provider: 'openrouter' }))).toBeNull();
        expect(comparePromptFingerprints(previous, fingerprint({ model: 'deepseek-v4-flash' }))).toBeNull();
        expect(comparePromptFingerprints(previous, fingerprint({ origin: 'quiet' }))).toBeNull();
    });

    it('has nothing to compare against without a prior fingerprint', () => {
        expect(comparePromptFingerprints(null, fingerprint())).toBeNull();
        expect(comparePromptFingerprints(fingerprint(), null)).toBeNull();
    });

    it('will not let missing token counts pass as a shared prefix', () => {
        const previous = fingerprint();
        const current = fingerprint({ tokenCounts: [1500, null] });

        expect(comparePromptFingerprints(previous, current)).toBeNull();
    });

});

describe('usage prefix — breaker rule', () => {
    it('flags a measured zero hit only at or above the 2048-token shared prefix', () => {
        expect(isPossiblePrefixBreaker({ sharedPrefixTokens: 2048, hitTokens: 0 })).toBe(true);
        expect(isPossiblePrefixBreaker({ sharedPrefixTokens: 2047, hitTokens: 0 })).toBe(false);
    });

    it('does not treat an unavailable hit count as zero', () => {
        expect(isPossiblePrefixBreaker({ sharedPrefixTokens: 2200, hitTokens: null })).toBe(false);
        expect(isPossiblePrefixBreaker({ sharedPrefixTokens: null, hitTokens: 0 })).toBe(false);
    });
});

describe('usage prefix — per-identity baselines', () => {
    it('keys a baseline by provider, model and origin', () => {
        const base = fingerprint();

        expect(promptFingerprintKey(base)).toBe(promptFingerprintKey(fingerprint()));
        expect(promptFingerprintKey(base)).not.toBe(promptFingerprintKey(fingerprint({ provider: 'openrouter' })));
        expect(promptFingerprintKey(base)).not.toBe(promptFingerprintKey(fingerprint({ model: 'other' })));
        expect(promptFingerprintKey(base)).not.toBe(promptFingerprintKey(fingerprint({ origin: 'quiet' })));
        expect(promptFingerprintKey(null)).toBeNull();
    });

    it('keeps one baseline per identity, including one whose counts were unavailable', () => {
        const baselines = normalizePromptFingerprints({
            story: fingerprint(),
            quiet: fingerprint({ origin: 'quiet' }),
            openrouter: fingerprint({ provider: 'openrouter' }),
            worker: fingerprint({ origin: 'worker-profile', tokenCounts: [1500, null] }),
            corrupt: 'text',
        });

        expect(Object.values(baselines)).toEqual([
            fingerprint(),
            fingerprint({ origin: 'quiet' }),
            fingerprint({ provider: 'openrouter' }),
            fingerprint({ origin: 'worker-profile', tokenCounts: [1500, null] }),
        ]);
        expect(Object.keys(baselines)).toHaveLength(4);
    });

    it('drops text that drifted into a stored baseline', () => {
        const baselines = normalizePromptFingerprints({
            story: {
                ...fingerprint(),
                messages: [{ hash: 11, tokens: 1500, content: 'SECRET PROMPT TEXT' }],
            },
        });

        expect(JSON.stringify(baselines)).not.toContain('SECRET');
        expect(Object.values(baselines)[0].messages).toEqual([{ hash: 11, tokens: 1500 }]);
    });
});
