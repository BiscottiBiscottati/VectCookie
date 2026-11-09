/**
 * ============================================================================
 * USAGE LEDGER
 * ============================================================================
 * Per-chat store for observed usage records and measurement runs.
 *
 * In-memory only in this slice; durable persistence (chat metadata, all-time
 * buckets, retention) arrives with its own ticket.
 * ============================================================================
 */

let _runSequence = 0;

export class UsageLedger {
    /** @type {Map<string|null, object[]>} */
    #byChat = new Map();
    /** @type {Map<string|null, object[]>} */
    #runsByChat = new Map();
    /** @type {Map<string|null, string>} */
    #currentRunByChat = new Map();

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

    /**
     * Opens a measurement run: a labelled window of records used to compare a
     * configuration before and after a change. Opening a run closes the
     * previous one but keeps it available.
     *
     * @param {string|null} chatId
     * @param {object} [options]
     * @param {number} [options.now] Clock, injected for tests.
     * @returns {{runId: string, label: string, startedAt: number, endedAt: number|null}}
     */
    startRun(chatId, { now = Date.now() } = {}) {
        const key = chatId ?? null;
        const runs = this.#runsByChat.get(key) ?? [];
        const previousId = this.#currentRunByChat.get(key);
        if (previousId) {
            const previous = runs.find((run) => run.runId === previousId);
            if (previous && previous.endedAt == null) previous.endedAt = now;
        }

        const run = {
            runId: createRunId(now),
            label: `Run ${runs.length + 1}`,
            startedAt: now,
            endedAt: null,
        };
        runs.push(run);
        this.#runsByChat.set(key, runs);
        this.#currentRunByChat.set(key, run.runId);
        return { ...run };
    }

    /**
     * The run id stamped on new records for this chat, or null when no run is
     * open.
     *
     * @param {string|null} chatId
     * @returns {string|null}
     */
    currentRunIdFor(chatId) {
        return this.#currentRunByChat.get(chatId ?? null) ?? null;
    }

    /**
     * Newest-first run markers for one chat. Old runs stay available after a
     * new one is started.
     *
     * @param {string|null} chatId
     * @returns {object[]}
     */
    runsFor(chatId) {
        return [...(this.#runsByChat.get(chatId ?? null) ?? [])]
            .reverse()
            .map((run) => ({ ...run }));
    }
}

function createRunId(now) {
    _runSequence += 1;
    const stamp = Number.isFinite(now) ? Math.floor(now).toString(36) : Date.now().toString(36);
    return `run-${stamp}-${_runSequence}`;
}
