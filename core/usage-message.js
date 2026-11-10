/**
 * ============================================================================
 * USAGE MESSAGE
 * ============================================================================
 * How one request message's content is flattened to text. Both the prompt
 * estimate and the prefix fingerprint read a message through this function so
 * they always agree on what a message "says". No text is stored.
 * ============================================================================
 */

/**
 * Flattens a request message's content to its text parts.
 *
 * @param {{content?: string|object[]}} message
 * @returns {string}
 */
export function messageText(message) {
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
