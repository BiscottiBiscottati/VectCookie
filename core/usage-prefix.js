/**
 * ============================================================================
 * USAGE PREFIX
 * ============================================================================
 * Per-message fingerprints for prefix diagnostics.
 *
 * Each request message is reduced to a stable hash and an estimated token
 * count. Nothing here keeps, returns or accepts message text: comparison is
 * positional equality of the hashes, and the shared prefix is the token sum of
 * the messages that match from the start.
 *
 * A request is compared only with the last fingerprint of the same provider,
 * model and origin, so interleaved worker, quiet or internal calls cannot
 * displace the story baseline. A request whose matched messages have no token
 * count cannot report a shared prefix at all, so a missing count can never
 * pass as a long prefix.
 * ============================================================================
 */

import { messageText } from './usage-message.js';

/** Shared prefix at or above this many tokens makes a zero-hit row a suspect. */
const USAGE_PREFIX_BREAKER_TOKENS = 2048;

/**
 * Builds a fingerprint for one request from its messages and their per-message
 * token estimates. The text is hashed and dropped.
 *
 * @param {object} [options]
 * @param {string|null} [options.provider] Provider that received the request.
 * @param {string|null} [options.model] Model the request asked for.
 * @param {string|null} [options.origin] Origin attributed to the request.
 * @param {object[]} [options.messages] Request messages (`{role, content}`).
 * @param {(number|null)[]|null} [options.tokenCounts] Parallel per-message
 *   counts; a missing or non-finite entry is stored as null, not zero.
 * @returns {{provider: string|null, model: string|null, origin: string|null, messages: {hash: number, tokens: number|null}[]}|null}
 */
export function createPromptFingerprint({
    provider = null,
    model = null,
    origin = null,
    messages,
    tokenCounts = null,
} = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const counts = Array.isArray(tokenCounts) ? tokenCounts : [];

    return normalizePromptFingerprint({
        provider,
        model,
        origin,
        messages: messages.map((message, index) => ({
            hash: hashRequestMessage(message),
            tokens: counts[index],
        })),
    });
}

/**
 * Shared-prefix tokens between two fingerprints, or null when they are not
 * comparable or the matching counts are unavailable.
 *
 * Only the current request's counts are summed: the matched messages are
 * positionally identical, so the previous fingerprint contributes its hashes,
 * not its arithmetic.
 *
 * @param {object|null} previous Last stored fingerprint.
 * @param {object|null} current Request under comparison.
 * @returns {number|null} 0 when the first message already differs; null when
 *   there is no comparable prior or a matched count is unavailable.
 */
export function comparePromptFingerprints(previous, current) {
    if (!previous || !current) return null;
    if (promptFingerprintKey(previous) !== promptFingerprintKey(current)) return null;
    const before = previous.messages;
    const now = current.messages;
    if (!Array.isArray(before) || !Array.isArray(now)) return null;

    let shared = 0;
    for (let index = 0; index < now.length; index++) {
        if (index >= before.length || before[index].hash !== now[index].hash) break;
        const tokens = now[index].tokens;
        // A matched message without a count would understate the prefix; say
        // unavailable instead of reporting a shorter, flag-safe number.
        if (!Number.isFinite(tokens)) return null;
        shared += tokens;
    }
    return shared;
}

/**
 * The zero-hit prefix-breaker rule, beside the threshold it depends on: a
 * provider-reported zero hit count is only suspicious when the request shared
 * at least the configured threshold of estimated tokens with its comparable
 * baseline. A missing hit count is not zero and is never flagged.
 *
 * @param {object} [options]
 * @param {number|null} [options.sharedPrefixTokens]
 * @param {number|null} [options.hitTokens]
 * @returns {boolean}
 */
export function isPossiblePrefixBreaker({ sharedPrefixTokens = null, hitTokens = null } = {}) {
    return Number.isFinite(sharedPrefixTokens)
        && sharedPrefixTokens >= USAGE_PREFIX_BREAKER_TOKENS
        && hitTokens === 0;
}

/**
 * The identity a fingerprint is comparable within: provider, model and origin.
 *
 * @param {{provider?: string|null, model?: string|null, origin?: string|null}|null} fingerprint
 * @returns {string|null}
 */
export function promptFingerprintKey(fingerprint) {
    if (!fingerprint || typeof fingerprint !== 'object') return null;
    return JSON.stringify([
        fingerprint.provider ?? null,
        fingerprint.model ?? null,
        fingerprint.origin ?? null,
    ]);
}

/**
 * Consumes the transient fingerprint an observer stamped on a record and
 * removes it, so only the per-chat baseline map is persisted. The record keeps
 * its shared-prefix count and flag.
 *
 * @param {object} record
 * @returns {object|null} The normalized fingerprint, or null.
 */
export function takeRecordFingerprint(record) {
    if (!record || typeof record !== 'object') return null;
    const fingerprint = normalizePromptFingerprint(record.messageFingerprint);
    delete record.messageFingerprint;
    return fingerprint;
}

/**
 * Merges two per-identity baseline maps, keeping the local (newer) fingerprint
 * when both know the same identity.
 *
 * @param {Record<string, object>|null} local
 * @param {Record<string, object>|null} incoming
 * @returns {Record<string, object>}
 */
export function mergePromptFingerprints(local, incoming) {
    const left = local && typeof local === 'object' ? local : {};
    const right = incoming && typeof incoming === 'object' ? incoming : {};
    return { ...right, ...left };
}

/**
 * Validates a stored fingerprint. The result contains only the comparison
 * fields, so any text that drifted into a namespace is dropped on load.
 *
 * @param {object|null} raw
 * @returns {{provider: string|null, model: string|null, origin: string|null, messages: {hash: number, tokens: number|null}[]}|null}
 */
export function normalizePromptFingerprint(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const messages = Array.isArray(raw.messages)
        ? raw.messages.map(normalizeFingerprintMessage).filter(Boolean)
        : [];
    if (messages.length === 0) return null;

    return {
        provider: stringOrNull(raw.provider),
        model: stringOrNull(raw.model),
        origin: stringOrNull(raw.origin),
        messages,
    };
}

/**
 * Validates the per-chat baseline map, keeping one fingerprint per identity.
 * Corrupt entries are dropped and keys are rebuilt from the values, so a
 * hand-edited or stale map cannot smuggle text back in.
 *
 * @param {object|null} raw
 * @returns {Record<string, object>}
 */
export function normalizePromptFingerprints(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const fingerprints = {};
    for (const value of Object.values(raw)) {
        const fingerprint = normalizePromptFingerprint(value);
        // An unmeasured fingerprint is still a usable baseline: comparison
        // reads the previous hashes and the current counts, so only this
        // request's own shared-prefix value becomes unavailable.
        if (!fingerprint) continue;
        fingerprints[promptFingerprintKey(fingerprint)] = fingerprint;
    }
    return fingerprints;
}

function normalizeFingerprintMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const hash = message.hash;
    if (typeof hash !== 'number' || !Number.isFinite(hash)) return null;
    const tokens = Number.isFinite(message.tokens) && message.tokens >= 0
        ? Math.round(message.tokens)
        : null;
    return { hash, tokens };
}

function stringOrNull(value) {
    return typeof value === 'string' ? value : null;
}

/**
 * Hash of one request message: its role and flattened text, nothing else. A
 * role change therefore breaks the prefix, and two different texts do not
 * collide in practice (two packed djb2 seeds, 53 bits).
 *
 * @param {{role?: string, content?: string|object[]}} message
 * @returns {number}
 */
function hashRequestMessage(message) {
    const role = typeof message?.role === 'string' ? message.role : '';
    return hashText(`${role}\u0000${messageText(message)}`);
}

/**
 * Two packed djb2 seeds (53 bits), the same collision-avoidance shape the
 * EventBase store uses: a single 32-bit hash is too narrow for a long chat's
 * message hashes.
 *
 * @param {string} value
 * @returns {number}
 */
function hashText(value) {
    let low = 5381;
    let high = 0xABCDEF;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        low = ((low << 5) + low) ^ code;
        high = ((high << 5) + high) ^ code ^ (code << 16);
        low >>>= 0;
        high >>>= 0;
    }
    return (high >>> 11) * 4294967296 + low;
}
