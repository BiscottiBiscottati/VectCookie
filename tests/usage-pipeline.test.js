/**
 * Usage pipeline — the observer/ledger seam.
 *
 * Drives the real observer over a fake fetch and a real in-memory ledger, the
 * same way the extension installs it over window.fetch. Asserts only what the
 * caller receives and what reaches the ledger.
 */

import { describe, it, expect, vi } from 'vitest';

import { installUsageObserver } from '../core/usage-observer.js';
import { UsageLedger } from '../core/usage-ledger.js';

const ENDPOINT = '/api/backends/chat-completions/generate';

function jsonResponse(body, { status = 200 } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function chatBody(overrides = {}) {
    return {
        chat_completion_source: 'openrouter',
        model: 'deepseek/deepseek-v3',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
        ...overrides,
    };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function installOver(fetchMock, { enabled = true, chatId = 'chat-1' } = {}) {
    const target = { fetch: fetchMock };
    const ledger = new UsageLedger();
    installUsageObserver({
        target,
        isEnabled: () => enabled,
        getChatId: () => chatId,
        handleRecord: (record) => ledger.add(record),
        now: () => 1_700_000_000_000,
    });
    return { target, ledger };
}

describe('usage pipeline — pass-through', () => {
    it('leaves requests untouched and records nothing while tracking is off', async () => {
        const response = jsonResponse({ usage: { prompt_tokens: 10 } });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock, { enabled: false });

        const returned = await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });

        expect(returned).toBe(response);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(ledger.recordsFor('chat-1')).toEqual([]);
    });
});

describe('usage pipeline — non-streamed capture', () => {
    it('turns one JSON usage response into one record for the active chat', async () => {
        const payload = {
            id: 'gen-1',
            model: 'deepseek/deepseek-v3',
            usage: {
                prompt_tokens: 1200,
                completion_tokens: 100,
                total_tokens: 1300,
                prompt_tokens_details: { cached_tokens: 900 },
            },
        };
        const response = jsonResponse(payload);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        const returned = await target.fetch(`${ENDPOINT}?some=query`, {
            method: 'POST',
            body: JSON.stringify(chatBody()),
        });

        expect(returned).toBe(response);
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        const [record] = ledger.recordsFor('chat-1');
        expect(record).toMatchObject({
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
        });
        expect(typeof record.recordId).toBe('string');
        expect(record.recordId.length).toBeGreaterThan(0);

        // The caller still gets the provider body, byte for byte.
        await expect(returned.json()).resolves.toEqual(payload);
    });
});

describe('usage pipeline — what the observer ignores', () => {
    it('leaves a non-chat-completion URL alone', async () => {
        const response = jsonResponse({ usage: { prompt_tokens: 10 } });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        const returned = await target.fetch('/api/backends/text-completions/generate', {
            method: 'POST',
            body: JSON.stringify(chatBody()),
        });

        expect(returned).toBe(response);
        await settle();
        expect(ledger.recordsFor('chat-1')).toEqual([]);
    });

    it('skips a streamed request so the later ticket owns SSE parsing', async () => {
        const response = new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
            headers: { 'Content-Type': 'text/event-stream' },
        });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        const returned = await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true })),
        });

        expect(returned).toBe(response);
        await settle();
        expect(ledger.recordsFor('chat-1')).toEqual([]);
    });

    it('skips a non-string body instead of guessing at a Request object', async () => {
        const response = jsonResponse({ usage: { prompt_tokens: 10 } });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, { method: 'POST', body: new FormData() });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        await settle();
        expect(ledger.recordsFor('chat-1')).toEqual([]);
    });
});

describe('usage pipeline — missing usage', () => {
    it('records unavailable rather than zero when the provider sends no usage', async () => {
        const response = jsonResponse({ id: 'gen-2', choices: [{ message: { content: 'hi' } }] });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'no-usage',
            usageSource: 'unavailable',
            promptTokens: null,
            hitTokens: null,
            missTokens: null,
            totalTokens: null,
        });
    });
});

describe('usage pipeline — observer safety', () => {
    it('never rejects the caller when the sink throws', async () => {
        const response = jsonResponse({ usage: { prompt_tokens: 10 } });
        const fetchMock = vi.fn(async () => response);
        const target = { fetch: fetchMock };
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {
                throw new Error('sink exploded');
            },
        });

        await expect(target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody()),
        })).resolves.toBe(response);
        await settle();
    });

    it('wraps fetch once and lets a reinstalled sink take over', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 5 } }));
        const target = { fetch: fetchMock };
        const first = [];
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: (record) => first.push(record),
        });
        const second = [];
        const returnedWrapper = installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: (record) => second.push(record),
        });

        expect(returnedWrapper).toBe(target.fetch);
        await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });
        await vi.waitFor(() => expect(second).toHaveLength(1));
        expect(first).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('usage pipeline — per-chat ledger', () => {
    it('files each record under the chat that was active when it was sent', async () => {
        let chatId = 'chat-a';
        const target = { fetch: vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 7 } })) };
        const ledger = new UsageLedger();
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => chatId,
            handleRecord: (record) => ledger.add(record),
        });

        await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-a')).toHaveLength(1));
        chatId = 'chat-b';
        await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-b')).toHaveLength(1));

        expect(ledger.recordsFor('chat-a')).toHaveLength(1);
        expect(ledger.recordsFor('chat-b')).toHaveLength(1);
    });
});

describe('usage pipeline — request-time ownership', () => {
    it('files a slow response under the chat that was active when it was sent', async () => {
        let resolveResponse;
        const pending = new Promise((resolve) => {
            resolveResponse = resolve;
        });
        let chatId = 'chat-a';
        const target = { fetch: vi.fn(() => pending) };
        const ledger = new UsageLedger();
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => chatId,
            handleRecord: (record) => ledger.add(record),
        });

        const call = target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });
        chatId = 'chat-b';
        resolveResponse(jsonResponse({ usage: { prompt_tokens: 7 } }));

        await call;
        await vi.waitFor(() => expect(ledger.recordsFor('chat-a')).toHaveLength(1));
        expect(ledger.recordsFor('chat-b')).toEqual([]);
    });
});

describe('usage pipeline — partial usage', () => {
    it('keeps status and source in agreement when a usage object omits the prompt count', async () => {
        const response = jsonResponse({ usage: { completion_tokens: 50, total_tokens: 50 } });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'ok',
            usageSource: 'measured',
            promptTokens: null,
            hitTokens: null,
            totalTokens: 50,
        });
    });
});
