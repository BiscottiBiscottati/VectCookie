/**
 * ============================================================================
 * USAGE ESTIMATOR
 * ============================================================================
 * Prompt-token estimates for providers that omit usage, plus the per-message
 * counts the prefix fingerprint needs. The observer calls these only after the
 * response, and cache hit is never estimated. No prompt text is stored.
 * ============================================================================
 */

import { messageText } from './usage-message.js';

/**
 * Builds the estimator the usage observer runs after a usage-less response.
 *
 * @param {object} [options]
 * @param {() => (object|Promise<object>|null)} [options.loadTokenizer] Lazily
 *   imports SillyTavern's tokenizer module; a failure leaves estimates
 *   unavailable instead of breaking capture.
 * @returns {(messages: object[]) => Promise<number|null>}
 */
export function createPromptTokenEstimator({ loadTokenizer = () => null } = {}) {
    const load = createTokenizerLoader(loadTokenizer);

    return async function estimatePromptTokens(messages) {
        if (!Array.isArray(messages)) return null;
        const tokenizer = await load();
        if (typeof tokenizer?.getTokenCountAsync !== 'function') return null;

        let total = 0;
        for (const message of messages) {
            const text = messageText(message);
            if (!text) continue;
            try {
                total += await tokenizer.getTokenCountAsync(text);
            } catch {
                return null;
            }
        }
        return total > 0 ? total : null;
    };
}

/**
 * Builds the per-message estimator behind the prefix fingerprint. Unlike the
 * prompt total, an empty message is a measured zero here: it is a real
 * position in the shared prefix. A failure anywhere leaves the whole array
 * unavailable, so a missing count can never be summed as zero.
 *
 * @param {object} [options]
 * @param {() => (object|Promise<object>|null)} [options.loadTokenizer] Lazily
 *   imports SillyTavern's tokenizer module.
 * @returns {(messages: object[]) => Promise<(number|null)[]|null>}
 */
export function createMessageTokenEstimator({ loadTokenizer = () => null } = {}) {
    const load = createTokenizerLoader(loadTokenizer);

    return async function estimateMessageTokens(messages) {
        if (!Array.isArray(messages)) return null;
        const tokenizer = await load();
        if (typeof tokenizer?.getTokenCountAsync !== 'function') return null;

        const counts = [];
        for (const message of messages) {
            const text = messageText(message);
            if (!text) {
                counts.push(0);
                continue;
            }
            try {
                counts.push(await tokenizer.getTokenCountAsync(text));
            } catch {
                return null;
            }
        }
        return counts;
    };
}

/**
 * One lazy tokenizer import per factory, shared by repeated estimates.
 *
 * @param {() => (object|Promise<object>|null)} loadTokenizer
 * @returns {() => Promise<object|null>}
 */
function createTokenizerLoader(loadTokenizer) {
    let tokenizerPromise = null;
    return () => {
        if (!tokenizerPromise) {
            tokenizerPromise = Promise.resolve()
                .then(() => loadTokenizer())
                .catch(() => null);
        }
        return tokenizerPromise;
    };
}
