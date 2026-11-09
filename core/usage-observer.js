/**
 * ============================================================================
 * USAGE OBSERVER
 * ============================================================================
 * One page-lifetime fetch observer for chat-completion usage. Read-only: it
 * clones the response and returns the caller's response untouched.
 *
 * Off by default. While tracking is off the wrapper is a pass-through; the
 * extension only installs it when tracking is on and never removes it.
 * ============================================================================
 */

import { resolveUsageOrigin } from './usage-attribution.js';

export const USAGE_CHAT_COMPLETION_PATH = '/api/backends/chat-completions/generate';
export const USAGE_OBSERVER_MARKER = '__vectfox_usage_observer__';
export const USAGE_SINK_KEY = '__vectfox_usage_sink__';

let _recordSequence = 0;

/**
 * Installs (once) the usage observer over target.fetch and publishes the sink
 * the wrapper reads. A second install in a reloaded module instance replaces
 * the sink instead of wrapping fetch twice.
 *
 * @param {object} [options]
 * @param {object} [options.target] Object owning fetch (window in production, a
 *   plain object in tests).
 * @param {() => boolean} [options.isEnabled] Read at request time; false makes
 *   the wrapper a pass-through.
 * @param {() => (string|null)} [options.getChatId] Chat active when the request
 *   was sent.
 * @param {(record: object) => void} [options.handleRecord] Sink that receives
 *   one normalized record per observed request.
 * @param {() => ({origin: string, featureLabel: string|null})} [options.getOrigin]
 *   Origin attribution, read synchronously when the request is sent. Passed
 *   through the sink so a reloaded module instance keeps the old wrapper
 *   reading the new attribution state.
 * @param {() => (object|null)} [options.getConfig] Ghosting configuration
 *   snapshot, read synchronously when the request is sent.
 * @param {() => void} [options.onSettle] Called after every observed request's
 *   capture attempt finishes, including a skipped body or a capture failure, so
 *   the health line can refresh without a record.
 * @param {() => number} [options.now] Clock, injected for tests.
 * @returns {Function|null} The installed fetch wrapper, or null when the
 *   target has no fetch to wrap.
 */
export function installUsageObserver({
    target = globalThis,
    isEnabled = () => false,
    getChatId = () => null,
    handleRecord = () => {},
    getOrigin = resolveUsageOrigin,
    getConfig = () => null,
    onSettle = () => {},
    now = () => Date.now(),
} = {}) {
    if (!target || typeof target.fetch !== 'function') return null;

    // Health belongs to the sink, so a re-enable starts from a clean baseline
    // while a reloaded module instance replaces it without wrapping fetch twice.
    target[USAGE_SINK_KEY] = {
        isEnabled,
        getChatId,
        handleRecord,
        getOrigin,
        getConfig,
        onSettle,
        now,
        health: createHealth(),
    };

    if (target[USAGE_OBSERVER_MARKER]) return target.fetch;

    const originalFetch = target.fetch;
    target.fetch = async function observedUsageFetch(input, init) {
        const sink = target[USAGE_SINK_KEY];
        let enabled = false;
        try {
            enabled = !!(sink && sink.isEnabled && sink.isEnabled());
        } catch {
            enabled = false;
        }
        if (!enabled) return originalFetch(input, init);

        // Only chat-completion requests are observed; leaving every other fetch
        // on the original path keeps the wrapper invisible to the extension.
        let isTarget = false;
        try {
            isTarget = isChatCompletionRequest(input);
        } catch {
            isTarget = false;
        }
        if (!isTarget) return originalFetch(input, init);

        // Origin and configuration are decided when the request is sent, not
        // when its (deferred) capture runs: a generation can end in between.
        const origin = readOrigin(sink);
        const configuration = readConfiguration(sink);
        noteHealth(sink, 'matched');

        const startedAt = sink.now();
        // Chat ownership is decided when the request is sent, not when its
        // response lands — a chat switch mid-flight must not move the record.
        const chatId = readChatId(sink);
        let response;
        try {
            response = await originalFetch(input, init);
        } catch (error) {
            startCapture(sink, () => captureRejectedRequest({
                sink,
                init,
                chatId,
                origin,
                configuration,
                startedAt,
                error,
            }));
            throw error;
        }
        const latencyMs = Math.max(0, sink.now() - startedAt);

        try {
            if (!response.ok) {
                startCapture(sink, () => captureHttpErrorRecord({
                    sink,
                    init,
                    chatId,
                    origin,
                    configuration,
                    httpStatus: response.status,
                    startedAt,
                    latencyMs,
                }));
                return response;
            }
            // Clone before returning: the caller's body must stay untouched.
            // Everything else (including parsing the request body) runs in the
            // floating continuation, after the caller has its response.
            const clone = response.clone();
            const captured = {
                sink,
                init,
                chatId,
                origin,
                configuration,
                clone,
                startedAt,
                latencyMs,
                httpStatus: response.status,
            };
            if (isEventStream(response)) {
                startCapture(sink, () => captureStreamedRecord(captured));
            } else {
                startCapture(sink, () => captureJsonRecord(captured));
            }
        } catch {
            noteHealth(sink, 'errors');
            /* observer must never replace or delay the caller's response */
        }

        return response;
    };
    target[USAGE_OBSERVER_MARKER] = true;

    return target.fetch;
}

/**
 * Health of the installed observer, or null when none is installed.
 *
 * @param {object} [target] Object owning fetch (window in production).
 * @returns {{matched: number, captured: number, skipped: number, errors: number}|null}
 */
export function getUsageObserverHealth(target = globalThis) {
    try {
        const health = target?.[USAGE_SINK_KEY]?.health;
        return health ? { ...health } : null;
    } catch {
        return null;
    }
}

function createHealth() {
    return { matched: 0, captured: 0, skipped: 0, errors: 0 };
}

function noteHealth(sink, field) {
    try {
        if (sink?.health && typeof sink.health[field] === 'number') sink.health[field] += 1;
    } catch {
        /* health reporting must never affect capture */
    }
}

/**
 * Where the request body carries no JSON string, the request is uncapturable.
 * Counted in the health line rather than guessed at.
 */
function readBodyOrCountSkipped(sink, init) {
    const body = readChatCompletionBody(init);
    if (!body) noteHealth(sink, 'skipped');
    return body;
}

function readChatId(sink) {
    try {
        return sink.getChatId?.() ?? null;
    } catch {
        return null;
    }
}

/**
 * Attribution is read through the sink so the wrapper installed by an earlier
 * module instance uses the reloaded instance's generation state.
 */
function readOrigin(sink) {
    try {
        const origin = sink.getOrigin?.();
        if (origin && typeof origin === 'object') return origin;
    } catch {
        /* attribution must never break capture */
    }
    return { origin: 'unknown', featureLabel: null };
}

/**
 * Snapshots the configuration the extension was running when the request went
 * out. The wiring owns the shape and normalization; the observer stores the
 * values opaquely so it cannot disagree with the ghosting code about them.
 */
function readConfiguration(sink) {
    try {
        const config = sink.getConfig?.();
        return config && typeof config === 'object' ? { ...config } : null;
    } catch {
        return null;
    }
}

/**
 * Defers capture to the next macrotask: the caller's response continuation
 * must run before any capture work, including parsing the request body.
 * Capture errors are swallowed — the observer never surfaces them.
 */
function startCapture(sink, run) {
    const start = () => {
        let pending;
        try {
            pending = Promise.resolve(run());
        } catch {
            noteHealth(sink, 'errors');
            notifySettled(sink);
            return;
        }
        pending
            .catch(() => noteHealth(sink, 'errors'))
            .finally(() => notifySettled(sink));
    };
    try {
        setTimeout(start, 0);
    } catch {
        start();
    }
}

/**
 * Tells the wiring the capture attempt is over, so the health line refreshes
 * even when no record was written (skipped body, failed capture).
 */
function notifySettled(sink) {
    try {
        sink.onSettle?.();
    } catch {
        /* a UI refresh must never affect capture */
    }
}

function captureRejectedRequest({ sink, init, chatId, origin, configuration, startedAt, error }) {
    const body = readBodyOrCountSkipped(sink, init);
    if (!body) return;

    emitRecord(sink, buildRecord({
        body,
        chatId,
        origin,
        configuration,
        httpStatus: null,
        usage: null,
        status: usageStatus({ aborted: isAbortError(error, init?.signal), error: true }),
        startedAt,
        latencyMs: Math.max(0, sink.now() - startedAt),
    }));
}

function emitRecord(sink, record) {
    sink.handleRecord(record);
    noteHealth(sink, 'captured');
}

function usageStatus({ aborted = false, error = false, usage = null } = {}) {
    if (aborted) return 'aborted';
    if (error) return 'error';
    return usage && typeof usage === 'object' ? 'ok' : 'no-usage';
}

function isAbortError(error, signal) {
    try {
        if (signal?.aborted) return true;
    } catch {
        /* an unreadable signal is treated as not aborted */
    }
    return error?.name === 'AbortError';
}

function isChatCompletionRequest(input) {
    const url = typeof input === 'string' ? input : input?.url ?? String(input ?? '');
    if (!url) return false;

    try {
        return new URL(url, 'http://localhost').pathname === USAGE_CHAT_COMPLETION_PATH;
    } catch {
        return false;
    }
}

function isEventStream(response) {
    try {
        return String(response?.headers?.get?.('content-type') ?? '').includes('text/event-stream');
    } catch {
        return false;
    }
}

/**
 * Reads the request shape the observer needs, without keeping the prompt.
 * Only a JSON string body; a Request object or a non-string body is skipped.
 */
function readChatCompletionBody(init) {
    const rawBody = init?.body;
    if (typeof rawBody !== 'string') return null;

    let body;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return null;
    }
    if (!body || typeof body !== 'object') return null;

    return body;
}

/**
 * Records a non-2xx request without reading the response body: the caller's
 * error response must stay untouched, and there is no usage to find there.
 */
async function captureHttpErrorRecord({ sink, init, chatId, origin, configuration, httpStatus, startedAt, latencyMs }) {
    const body = readBodyOrCountSkipped(sink, init);
    if (!body) return;

    emitRecord(sink, buildRecord({
        body,
        chatId,
        origin,
        configuration,
        httpStatus,
        usage: null,
        status: usageStatus({ error: true }),
        startedAt,
        latencyMs,
    }));
}

/**
 * Reads a non-streamed response's JSON usage. Runs after the caller has the
 * response; a parse failure or provider error is a status, never a throw.
 */
async function captureJsonRecord({ sink, init, chatId, origin, configuration, clone, startedAt, latencyMs, httpStatus }) {
    let data = null;
    try {
        data = await clone.json();
    } catch {
        data = null;
    }

    const body = readBodyOrCountSkipped(sink, init);
    if (!body) return;

    const usage = data && typeof data === 'object' ? data.usage : null;
    emitRecord(sink, buildRecord({
        body,
        chatId,
        origin,
        configuration,
        httpStatus,
        responseModel: data?.model ?? null,
        responseId: data?.id ?? null,
        cacheDiscount: toCount(data?.cache_discount),
        usage,
        status: usageStatus({ error: !!data?.error, usage }),
        startedAt,
        latencyMs,
    }));
}

/**
 * Decodes a cloned SSE body incrementally, keeping only the last non-null
 * usage and stopping at `[DONE]`. The caller's branch of the cloned stream is
 * never awaited here.
 */
async function captureStreamedRecord({ sink, init, chatId, origin, configuration, clone, startedAt, latencyMs, httpStatus }) {
    const body = readBodyOrCountSkipped(sink, init);
    if (!body) {
        // Nothing to attribute: release the cloned branch instead of letting
        // the tee buffer the rest of the stream for an unread reader.
        cancelReader(clone?.body?.getReader?.());
        return;
    }

    const { reader, ...result } = await readSseCapture(clone, init?.signal);
    try {
        emitRecord(sink, buildRecord({
            body,
            chatId,
            origin,
            configuration,
            httpStatus,
            responseId: result.responseId,
            cacheDiscount: result.cacheDiscount,
            usage: result.usage,
            status: usageStatus(result),
            startedAt,
            latencyMs,
        }));
    } finally {
        // Record first, then cancel: cancelling is fire-and-forget because a
        // tee-branch cancel can stay pending until the caller's branch drains.
        if (reader) cancelReader(reader);
    }
}

const MAX_SSE_CARRY = 1_000_000;

async function readSseCapture(clone, signal) {
    const result = { usage: null, responseId: null, cacheDiscount: null, sawDone: false, aborted: false, error: false, reader: null };
    const body = clone?.body;
    if (!body || typeof body.getReader !== 'function') {
        result.error = true;
        return result;
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let carry = '';

    try {
        while (!result.sawDone) {
            const { done, value } = await reader.read();
            if (done) break;
            carry += decoder.decode(value, { stream: true });
            carry = drainSseLines(carry, result);
            if (carry.length > MAX_SSE_CARRY) carry = '';
        }
    } catch (error) {
        if (isAbortError(error, signal)) result.aborted = true;
        else result.error = true;
    }

    // A stream that ends without its terminal marker and without usage was
    // cut off; do not let it pass as a completed request with no usage.
    if (!result.sawDone && !result.usage && !result.aborted) result.error = true;

    if (result.sawDone) result.reader = reader;

    return result;
}

function cancelReader(reader) {
    try {
        reader.cancel().catch(() => {});
    } catch {
        /* already closed */
    }
}

function drainSseLines(carry, result) {
    let newline;
    while ((newline = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newline).replace(/\r$/, '');
        carry = carry.slice(newline + 1);
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
            result.sawDone = true;
            break;
        }
        if (!payload) continue;

        let chunk;
        try {
            chunk = JSON.parse(payload);
        } catch {
            result.error = true;
            continue;
        }
        if (!chunk || typeof chunk !== 'object') continue;

        if (chunk.error) result.error = true;
        if (chunk.usage && typeof chunk.usage === 'object') result.usage = chunk.usage;
        if (typeof chunk.id === 'string') result.responseId = chunk.id;
        const discount = toCount(chunk.cache_discount);
        if (discount != null) result.cacheDiscount = discount;
    }
    return carry;
}

function buildRecord({
    body,
    chatId,
    origin,
    configuration,
    httpStatus,
    responseModel = null,
    responseId = null,
    cacheDiscount = null,
    usage = null,
    status,
    startedAt,
    latencyMs,
}) {
    const hasUsage = !!usage && typeof usage === 'object';
    const promptTokens = toCount(usage?.prompt_tokens);
    const completionTokens = toCount(usage?.completion_tokens);
    const reportedHit = toCount(usage?.prompt_cache_hit_tokens);
    const cachedTokens = toCount(usage?.prompt_tokens_details?.cached_tokens);
    const hitTokens = reportedHit ?? cachedTokens;
    const reportedMiss = toCount(usage?.prompt_cache_miss_tokens);
    const reportedTotal = toCount(usage?.total_tokens);
    const totalTokens = reportedTotal ?? (
        promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null
    );

    return {
        recordId: createRecordId(),
        timestamp: startedAt,
        chatId,
        origin: origin?.origin ?? 'unknown',
        featureLabel: origin?.featureLabel ?? null,
        configuration: configuration ?? null,
        provider: body.chat_completion_source || 'unknown',
        model: body.model || responseModel || 'unknown',
        responseId,
        stream: body.stream === true,
        status,
        httpStatus,
        latencyMs,
        messageCount: Array.isArray(body.messages) ? body.messages.length : null,
        promptTokens,
        hitTokens,
        missTokens: reportedMiss ?? (
            promptTokens != null && hitTokens != null ? Math.max(0, promptTokens - hitTokens) : null
        ),
        cacheWriteTokens: toCount(usage?.prompt_tokens_details?.cache_write_tokens)
            ?? toCount(usage?.cache_write_tokens),
        completionTokens,
        reasoningTokens: toCount(usage?.completion_tokens_details?.reasoning_tokens),
        totalTokens,
        cost: toCount(usage?.cost),
        cacheDiscount: cacheDiscount ?? toCount(usage?.cache_discount),
        usageSource: hasUsage ? 'measured' : 'unavailable',
    };
}

function toCount(value) {
    return Number.isFinite(value) ? value : null;
}

function createRecordId() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    } catch {
        /* fall through to the sequence */
    }
    _recordSequence += 1;
    return `usage-${Date.now().toString(36)}-${_recordSequence}`;
}
