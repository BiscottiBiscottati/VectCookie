/**
 * Usage pipeline — the observer/ledger seam.
 *
 * Drives the real observer over a fake fetch and a real in-memory ledger, the
 * same way the extension installs it over window.fetch. Asserts only what the
 * caller receives and what reaches the ledger.
 */

import { describe, it, expect, vi } from 'vitest';

import { installUsageObserver, getUsageObserverHealth } from '../core/usage-observer.js';
import { UsageLedger } from '../core/usage-ledger.js';
import {
    noteGenerationStarted,
    noteGenerationEnded,
    beginInternalCall,
    endInternalCall,
    resetUsageAttribution,
} from '../core/usage-attribution.js';

const ENDPOINT = '/api/backends/chat-completions/generate';

function jsonResponse(body, { status = 200 } = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function sseResponse(parts, { status = 200 } = {}) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            for (const part of parts) controller.enqueue(encoder.encode(part));
            controller.close();
        },
    });
    return new Response(stream, {
        status,
        headers: { 'Content-Type': 'text/event-stream' },
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

function installOver(fetchMock, { enabled = true, chatId = 'chat-1', ...observerOptions } = {}) {
    const target = { fetch: fetchMock };
    const ledger = new UsageLedger();
    installUsageObserver({
        target,
        isEnabled: () => enabled,
        getChatId: () => chatId,
        handleRecord: (record) => ledger.add(record),
        now: () => 1_700_000_000_000,
        ...observerOptions,
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

describe('usage pipeline — streamed capture', () => {
    it('captures the terminal usage chunk of a streamed reply', async () => {
        const chunks = [
            'data: {"id":"gen-9","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
            'data: {"id":"gen-9","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1200,"completion_tokens":80,"total_tokens":1280,"prompt_cache_hit_tokens":900,"prompt_cache_miss_tokens":300,"prompt_tokens_details":{"cached_tokens":900}}}\n\n',
            'data: [DONE]\n\n',
        ];
        const response = sseResponse(chunks);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);
        const secret = 'PROMPT-TEXT-MARKER';

        const returned = await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({
                stream: true,
                chat_completion_source: 'deepseek',
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: secret }],
            })),
        });

        expect(returned).toBe(response);
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        const [record] = ledger.recordsFor('chat-1');
        expect(record).toMatchObject({
            chatId: 'chat-1',
            provider: 'deepseek',
            model: 'deepseek-chat',
            responseId: 'gen-9',
            stream: true,
            status: 'ok',
            httpStatus: 200,
            promptTokens: 1200,
            hitTokens: 900,
            missTokens: 300,
            completionTokens: 80,
            totalTokens: 1280,
            usageSource: 'measured',
        });
        expect(record).not.toHaveProperty('messages');
        expect(JSON.stringify(record)).not.toContain(secret);

        // The caller's body is still the provider's bytes, untouched.
        await expect(returned.text()).resolves.toBe(chunks.join(''));
    });

    it('keeps OpenRouter cache-write tokens and its reported cost', async () => {
        const chunks = [
            'data: {"id":"gen-11","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
            'data: {"id":"gen-11","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":194,"completion_tokens":2,"total_tokens":196,"prompt_tokens_details":{"cached_tokens":80,"cache_write_tokens":100},"cost":0.95}}\n\n',
            'data: [DONE]\n\n',
        ];
        const response = sseResponse(chunks);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true, chat_completion_source: 'openrouter' })),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'ok',
            hitTokens: 80,
            missTokens: 114,
            cacheWriteTokens: 100,
            cost: 0.95,
            usageSource: 'measured',
        });
    });

    it('returns the streamed response before the stream ends', async () => {
        const encoder = new TextEncoder();
        let controller;
        const stream = new ReadableStream({
            start(streamController) {
                controller = streamController;
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
            },
        });
        const response = new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        const returned = await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true })),
        });

        expect(returned).toBe(response);
        expect(ledger.recordsFor('chat-1')).toEqual([]);

        controller.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":9,"completion_tokens":1,"total_tokens":10}}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();

        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));
        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'ok',
            promptTokens: 9,
            completionTokens: 1,
            totalTokens: 10,
        });
    });

    it('records a completed stream without usage as no-usage', async () => {
        const response = sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
            'data: [DONE]\n\n',
        ]);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true })),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'no-usage',
            usageSource: 'unavailable',
            promptTokens: null,
            hitTokens: null,
        });
    });

    it('records a stream that ends without a terminal marker as error', async () => {
        const response = sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
        ]);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true })),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'error',
            usageSource: 'unavailable',
        });
    });

    it('records an error frame as error', async () => {
        const response = sseResponse([
            'data: {"error":{"message":"upstream failed"}}\n\n',
            'data: [DONE]\n\n',
        ]);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true })),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'error',
            usageSource: 'unavailable',
        });
    });

    it('records a malformed SSE payload as error while keeping a later usage', async () => {
        const response = sseResponse([
            'data: not-json\n\n',
            'data: {"usage":{"prompt_tokens":10,"total_tokens":10}}\n\n',
            'data: [DONE]\n\n',
        ]);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true })),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'error',
            promptTokens: 10,
            usageSource: 'measured',
        });
    });

    it('keeps the last non-null usage chunk', async () => {
        const response = sseResponse([
            'data: {"usage":{"prompt_tokens":10,"total_tokens":10}}\n\n',
            'data: {"usage":null}\n\n',
            'data: {"usage":{"prompt_tokens":20,"total_tokens":20}}\n\n',
            'data: [DONE]\n\n',
        ]);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true })),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'ok',
            promptTokens: 20,
            totalTokens: 20,
        });
    });

    it('parses a usage event split across chunks', async () => {
        const full = [
            'data: {"id":"gen-10","model":"deepseek-chat","choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
            'data: {"id":"gen-10","choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":5,"total_tokens":55,"prompt_tokens_details":{"cached_tokens":20}}}\n\n',
            'data: [DONE]\n\n',
        ].join('');
        const cuts = [17, 61, 140];
        const chunks = [
            full.slice(0, cuts[0]),
            full.slice(cuts[0], cuts[1]),
            full.slice(cuts[1], cuts[2]),
            full.slice(cuts[2]),
        ];
        const response = sseResponse(chunks);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true, chat_completion_source: 'deepseek', model: 'deepseek-chat' })),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'ok',
            promptTokens: 50,
            hitTokens: 20,
            missTokens: 30,
            totalTokens: 55,
        });
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

describe('usage pipeline — failed requests', () => {
    it('records a JSON error body as error', async () => {
        const response = jsonResponse({ error: { message: 'upstream failed' } });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody()),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'error',
            httpStatus: 200,
            usageSource: 'unavailable',
        });
    });

    it('records an aborted request and hands the caller the original rejection', async () => {
        const abortError = new DOMException('The user aborted a request.', 'AbortError');
        const fetchMock = vi.fn(async () => {
            throw abortError;
        });
        const target = { fetch: fetchMock };
        const ledger = new UsageLedger();
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: (record) => ledger.add(record),
        });
        const controller = new AbortController();
        controller.abort();

        await expect(target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody()),
            signal: controller.signal,
        })).rejects.toBe(abortError);

        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));
        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'aborted',
            httpStatus: null,
            promptTokens: null,
            hitTokens: null,
            missTokens: null,
            usageSource: 'unavailable',
            stream: false,
        });
    });
});

describe('usage pipeline — HTTP errors', () => {
    it('records an HTTP error as a status and leaves the response untouched', async () => {
        const payload = { error: { message: 'rate limited' } };
        const response = jsonResponse(payload, { status: 429 });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        const returned = await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody()),
        });

        expect(returned).toBe(response);
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));
        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'error',
            httpStatus: 429,
            stream: false,
            promptTokens: null,
            hitTokens: null,
            usageSource: 'unavailable',
        });
        await expect(returned.json()).resolves.toEqual(payload);
    });
});

describe('usage pipeline — aborted stream', () => {
    it('records an aborted stream as aborted and keeps what was measured', async () => {
        const encoder = new TextEncoder();
        const controller = new AbortController();
        const stream = new ReadableStream({
            start(streamController) {
                streamController.enqueue(encoder.encode('data: {"usage":{"prompt_tokens":10,"total_tokens":10}}\n\n'));
                // Abort after the usage chunk has been read, as a stop button would.
                setTimeout(() => {
                    controller.abort();
                    streamController.error(new DOMException('The user aborted a request.', 'AbortError'));
                }, 5);
            },
        });
        const response = new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
        });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock);

        const returned = await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true })),
            signal: controller.signal,
        });

        expect(returned).toBe(response);
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'aborted',
            stream: true,
            httpStatus: 200,
            promptTokens: 10,
            totalTokens: 10,
            usageSource: 'measured',
        });
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

describe('usage pipeline — origins', () => {
    async function recordOne({ prepare, installOptions = {} } = {}) {
        const fetchMock = vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 10 } }));
        const target = { fetch: fetchMock };
        const ledger = new UsageLedger();
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: (record) => ledger.add(record),
            ...installOptions,
        });
        prepare?.();
        const returned = await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody()),
        });
        prepare?.afterResponse?.();
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));
        return { record: ledger.recordsFor('chat-1')[0], returned };
    }

    it('tags a normal generation as story, decided when the request is sent', async () => {
        resetUsageAttribution();
        noteGenerationStarted('normal');

        const { record } = await recordOne({
            prepare: Object.assign(
                () => {},
                { afterResponse: () => noteGenerationEnded() },
            ),
        });

        expect(record).toMatchObject({ origin: 'story', featureLabel: null });
    });

    it('tags a quiet generation as quiet', async () => {
        resetUsageAttribution();
        noteGenerationStarted('quiet');

        const { record } = await recordOne();

        expect(record).toMatchObject({ origin: 'quiet', featureLabel: null });
    });

    it('tags a request outside any generation as worker-profile', async () => {
        resetUsageAttribution();

        const { record } = await recordOne();

        expect(record).toMatchObject({ origin: 'worker-profile', featureLabel: null });
    });

    it('lets the internal-call flag win over an in-flight generation', async () => {
        resetUsageAttribution();
        noteGenerationStarted('normal');
        const call = beginInternalCall('EventBase');

        const { record } = await recordOne({
            prepare: () => {},
        });
        endInternalCall(call);

        expect(record).toMatchObject({ origin: 'vectfox-internal', featureLabel: 'EventBase' });
    });

    it('tags a quiet-to-loud generation as story because its result is posted', async () => {
        resetUsageAttribution();
        noteGenerationStarted('quiet', { quietToLoud: true });

        const { record } = await recordOne();

        expect(record).toMatchObject({ origin: 'story', featureLabel: null });
    });

    it('does not let a dry run make the next worker request look like story', async () => {
        resetUsageAttribution();
        noteGenerationStarted('normal', { dryRun: true });

        const { record } = await recordOne();

        expect(record).toMatchObject({ origin: 'worker-profile', featureLabel: null });
    });

    it('reads origin through the current sink after a reinstall', async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 10 } }));
        const target = { fetch: fetchMock };
        const second = [];
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {},
            getOrigin: () => ({ origin: 'quiet', featureLabel: null }),
        });
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: (record) => second.push(record),
            getOrigin: () => ({ origin: 'vectfox-internal', featureLabel: 'Summarizer' }),
        });

        await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });
        await vi.waitFor(() => expect(second).toHaveLength(1));
        expect(second[0]).toMatchObject({ origin: 'vectfox-internal', featureLabel: 'Summarizer' });
    });

    it('tags an unrecognised generation type as unknown', async () => {
        resetUsageAttribution();
        noteGenerationStarted('mystery-mode');

        const { record } = await recordOne();

        expect(record).toMatchObject({ origin: 'unknown', featureLabel: null });
    });
});

describe('usage pipeline — configuration snapshot', () => {
    it('stamps the ghosting configuration active when the request was sent', async () => {
        let config = { ghostEnabled: true, ghostBatchSize: 30, ghostKeepRecent: 10 };
        const fetchMock = vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 10 } }));
        const target = { fetch: fetchMock };
        const ledger = new UsageLedger();
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: (record) => ledger.add(record),
            getConfig: () => config,
        });

        const call = target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });
        // A setting change after the request went out must not rewrite history.
        config = { ghostEnabled: false, ghostBatchSize: 1, ghostKeepRecent: 0 };
        await call;

        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));
        expect(ledger.recordsFor('chat-1')[0].configuration).toEqual({
            ghostEnabled: true,
            ghostBatchSize: 30,
            ghostKeepRecent: 10,
        });
    });
});

describe('usage pipeline — observer health', () => {
    const HEALTHY = { matched: 0, captured: 0, skipped: 0, errors: 0 };

    it('reports no requests captured yet before anything was sent', () => {
        const target = { fetch: vi.fn(async () => jsonResponse({})) };
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {},
        });

        expect(getUsageObserverHealth(target)).toEqual(HEALTHY);
    });

    it('returns null when no observer is installed', () => {
        expect(getUsageObserverHealth({})).toBeNull();
    });

    it('counts captured requests and never counts a non-target fetch', async () => {
        const target = { fetch: vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 10 } })) };
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {},
        });

        await target.fetch('/api/backends/text-completions/generate', { method: 'POST', body: '{}' });
        await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });

        await vi.waitFor(() => expect(getUsageObserverHealth(target).captured).toBe(1));
        expect(getUsageObserverHealth(target)).toEqual({ ...HEALTHY, matched: 1, captured: 1 });
    });

    it('counts a request with no readable body as skipped, not captured', async () => {
        const target = { fetch: vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 10 } })) };
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {},
        });

        await target.fetch(ENDPOINT, { method: 'POST', body: new FormData() });

        await vi.waitFor(() => expect(getUsageObserverHealth(target).skipped).toBe(1));
        expect(getUsageObserverHealth(target)).toMatchObject({ matched: 1, captured: 0 });
    });

    it('counts a failed capture as an observer error without failing the caller', async () => {
        const response = jsonResponse({ usage: { prompt_tokens: 10 } });
        const target = { fetch: vi.fn(async () => response) };
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {
                throw new Error('ledger exploded');
            },
        });

        await expect(target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) })).resolves.toBe(response);

        await vi.waitFor(() => expect(getUsageObserverHealth(target).errors).toBe(1));
        expect(getUsageObserverHealth(target)).toMatchObject({ matched: 1, captured: 0 });
    });
});

describe('usage pipeline — capture settlement', () => {
    it('notifies after a successful capture so the panel can refresh', async () => {
        const onSettle = vi.fn();
        const target = { fetch: vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 10 } })) };
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {},
            onSettle,
        });

        await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });

        await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1));
    });

    it('notifies after a skipped body, because the health line changed', async () => {
        const onSettle = vi.fn();
        const target = { fetch: vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 10 } })) };
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {},
            onSettle,
        });

        await target.fetch(ENDPOINT, { method: 'POST', body: new FormData() });

        await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1));
    });

    it('notifies after a capture failure, because the health line changed', async () => {
        const onSettle = vi.fn();
        const target = { fetch: vi.fn(async () => jsonResponse({ usage: { prompt_tokens: 10 } })) };
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {
                throw new Error('ledger exploded');
            },
            onSettle,
        });

        await target.fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(chatBody()) });

        await vi.waitFor(() => expect(onSettle).toHaveBeenCalledTimes(1));
    });

    it('does not notify for a non-target fetch', async () => {
        const onSettle = vi.fn();
        const target = { fetch: vi.fn(async () => jsonResponse({})) };
        installUsageObserver({
            target,
            isEnabled: () => true,
            getChatId: () => 'chat-1',
            handleRecord: () => {},
            onSettle,
        });

        await target.fetch('/api/backends/text-completions/generate', { method: 'POST', body: '{}' });
        await settle();

        expect(onSettle).not.toHaveBeenCalled();
    });
});


describe('usage pipeline — estimate fallback', () => {
    it('estimates prompt tokens from the request messages when JSON usage is missing', async () => {
        const estimator = vi.fn(async (messages) => messages.length * 120);
        const response = jsonResponse({ id: 'gen-1', choices: [] });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock, { estimatePromptTokens: estimator });

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({
                chat_completion_source: 'custom',
                messages: [
                    { role: 'system', content: 'a longer prompt' },
                    { role: 'user', content: 'hello' },
                ],
            })),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(estimator).toHaveBeenCalledWith([
            { role: 'system', content: 'a longer prompt' },
            { role: 'user', content: 'hello' },
        ]);
        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'no-usage',
            usageSource: 'estimated',
            promptTokens: null,
            estimatedPromptTokens: 240,
            hitTokens: null,
            missTokens: null,
        });
    });

    it('estimates a completed stream that carried no usage', async () => {
        const estimator = vi.fn(async () => 75);
        const response = sseResponse([
            'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n',
            'data: [DONE]\n\n',
        ]);
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock, { estimatePromptTokens: estimator });

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody({ stream: true })),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'no-usage',
            usageSource: 'estimated',
            estimatedPromptTokens: 75,
            hitTokens: null,
        });
    });

    it('does not estimate when the provider reported usage', async () => {
        const estimator = vi.fn(async () => 999);
        const response = jsonResponse({ usage: { prompt_tokens: 10, completion_tokens: 2 } });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock, { estimatePromptTokens: estimator });

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody()),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(estimator).not.toHaveBeenCalled();
        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'ok',
            usageSource: 'measured',
            promptTokens: 10,
            estimatedPromptTokens: null,
        });
    });

    it('keeps the row available but unestimated when the estimator fails', async () => {
        const estimator = vi.fn(async () => {
            throw new Error('tokenizer unavailable');
        });
        const response = jsonResponse({ id: 'gen-1', choices: [] });
        const fetchMock = vi.fn(async () => response);
        const { target, ledger } = installOver(fetchMock, { estimatePromptTokens: estimator });

        await target.fetch(ENDPOINT, {
            method: 'POST',
            body: JSON.stringify(chatBody()),
        });
        await vi.waitFor(() => expect(ledger.recordsFor('chat-1')).toHaveLength(1));

        expect(ledger.recordsFor('chat-1')[0]).toMatchObject({
            status: 'no-usage',
            usageSource: 'unavailable',
            promptTokens: null,
            estimatedPromptTokens: null,
            hitTokens: null,
        });
    });
});
