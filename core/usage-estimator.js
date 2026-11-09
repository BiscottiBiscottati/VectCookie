/**
 * ============================================================================
 * USAGE ESTIMATOR
 * ============================================================================
 * Prompt-token estimates for providers that omit usage. The observer calls
 * this only after a usage-less response, and only prompt tokens are estimated:
 * cache hit stays unavailable. No prompt text is stored.
 * ============================================================================
 */

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
    let tokenizerPromise = null;

    const load = () => {
        if (!tokenizerPromise) {
            tokenizerPromise = Promise.resolve()
                .then(() => loadTokenizer())
                .catch(() => null);
        }
        return tokenizerPromise;
    };

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

function messageText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .filter(Boolean)
            .join('\n');
    }
    return '';
}
