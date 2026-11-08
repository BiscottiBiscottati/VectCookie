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
 * @param {() => number} [options.now] Clock, injected for tests.
 * @returns {Function|null} The installed fetch wrapper, or null when the
 *   target has no fetch to wrap.
 */
export function installUsageObserver({
    target = globalThis,
    isEnabled = () => false,
    getChatId = () => null,
    handleRecord = () => {},
    now = () => Date.now(),
} = {}) {
    if (!target || typeof target.fetch !== 'function') return null;

    target[USAGE_SINK_KEY] = { isEnabled, getChatId, handleRecord, now };

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

        const startedAt = sink.now();
        // Chat ownership is decided when the request is sent, not when its
        // response lands — a chat switch mid-flight must not move the record.
        const chatId = readChatId(sink);
        const response = await originalFetch(input, init);
        const latencyMs = Math.max(0, sink.now() - startedAt);

        try {
            if (!isChatCompletionRequest(input)) return response;
            // SSE capture is its own slice; a streamed response must not
            // surface as a "no usage" row that looks like a provider failure.
            if (isEventStream(response)) return response;
            // Clone before returning: the caller's body must stay untouched.
            // Everything else (including parsing the request body) runs in the
            // floating continuation, after the caller has its response.
            const clone = response.clone();
            captureRecord({ sink, input, init, chatId, response, clone, startedAt, latencyMs }).catch(() => {});
        } catch {
            /* observer must never replace or delay the caller's response */
        }

        return response;
    };
    target[USAGE_OBSERVER_MARKER] = true;

    return target.fetch;
}

function readChatId(sink) {
    try {
        return sink.getChatId?.() ?? null;
    } catch {
        return null;
    }
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
 * Only a JSON string body; a Request object or a stream request is skipped.
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
    if (body.stream === true) return null;

    return body;
}

async function captureRecord({ sink, input, init, chatId, response, clone, startedAt, latencyMs }) {
    let data = null;
    try {
        // Await the clone before parsing the prompt body: the response promise
        // resolves first, so the caller is never held up by capture work.
        data = await clone.json();
    } catch {
        data = null;
    }

    const body = readChatCompletionBody(init);
    if (!body) return;

    const usage = data && typeof data === 'object' ? data.usage : null;
    sink.handleRecord(buildRecord({ body, chatId, response, data, usage, startedAt, latencyMs }));
}

function buildRecord({ body, chatId, response, data, usage, startedAt, latencyMs }) {
    const hasUsage = !!usage && typeof usage === 'object';
    const promptTokens = toCount(usage?.prompt_tokens);
    const completionTokens = toCount(usage?.completion_tokens);
    const hitTokens = toCount(usage?.prompt_tokens_details?.cached_tokens);
    const reportedTotal = toCount(usage?.total_tokens);
    const totalTokens = reportedTotal ?? (
        promptTokens != null && completionTokens != null ? promptTokens + completionTokens : null
    );

    return {
        recordId: createRecordId(),
        timestamp: startedAt,
        chatId,
        provider: body.chat_completion_source || 'unknown',
        model: body.model || data?.model || 'unknown',
        stream: body.stream === true,
        status: hasUsage ? 'ok' : 'no-usage',
        httpStatus: response?.status ?? null,
        latencyMs,
        messageCount: Array.isArray(body.messages) ? body.messages.length : null,
        promptTokens,
        hitTokens,
        missTokens: promptTokens != null && hitTokens != null
            ? Math.max(0, promptTokens - hitTokens)
            : null,
        completionTokens,
        totalTokens,
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
