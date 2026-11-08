/**
 * ============================================================================
 * USAGE LEDGER
 * ============================================================================
 * Per-chat store for observed usage records, newest first.
 *
 * In-memory only in the tracer-bullet slice; durable persistence (chat
 * metadata, all-time buckets, retention) arrives with its own ticket.
 * ============================================================================
 */

export class UsageLedger {
    /** @type {Map<string|null, object[]>} */
    #byChat = new Map();

    /**
     * Appends one record to the bucket of the chat it was sent from.
     * @param {object} record
     */
    add(record) {
        const key = record?.chatId ?? null;
        if (!this.#byChat.has(key)) this.#byChat.set(key, []);
        this.#byChat.get(key).push(record);
    }

    /**
     * Newest-first records for one chat.
     * @param {string|null} chatId
     * @returns {object[]}
     */
    recordsFor(chatId) {
        return [...(this.#byChat.get(chatId ?? null) ?? [])].reverse();
    }
}
