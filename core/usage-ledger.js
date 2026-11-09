/**
 * ============================================================================
 * USAGE LEDGER
 * ============================================================================
 * Per-chat store for observed usage records and measurement runs, plus the
 * durable shapes around them:
 *
 * - the chat namespace, written into SillyTavern's `chat_metadata` and saved
 *   through its metadata save;
 * - a short-lived pending copy of unsaved records in local storage, replayed
 *   when a chat is opened so a switch inside the debounce cannot lose them;
 * - the all-time aggregate, one bucket per chat, kept in local storage.
 *
 * Records are capped at the newest 500 per chat. A capped row is folded into
 * archived counters (overall, by origin, model and configuration) rather than
 * dropped, so the totals keep counting.
 *
 * Lifecycle: delete removes a chat's state and bucket, rename moves both, and a
 * namespace whose owner id differs from the open chat is a copy (a branch or a
 * manual copy), so it is discarded and the chat starts clean.
 * ============================================================================
 */

import {
    addRecordToUsageAccumulator,
    addRecordToUsageArchive,
    createUsageAccumulator,
    createUsageArchive,
    isUsageAccumulatorEmpty,
    isUsageArchiveEmpty,
    mergeUsageAccumulators,
    mergeUsageArchives,
    normalizeUsageAccumulator,
    normalizeUsageArchive,
    subtractUsageAccumulators,
} from './usage-stats.js';
import { normalizeUsageConfiguration } from './usage-configuration.js';

export const USAGE_CHAT_METADATA_KEY = 'vectfox_usage';
export const USAGE_ALL_TIME_STORAGE_KEY = 'vectfox_usage_alltime';
export const USAGE_PENDING_STORAGE_KEY = 'vectfox_usage_pending';
export const USAGE_RECORD_LIMIT = 500;

const NAMESPACE_VERSION = 1;
const ALL_TIME_VERSION = 1;
const PENDING_VERSION = 1;

let _runSequence = 0;

export class UsageLedger {
    /** @type {Map<string|null, object>} */
    #byChat = new Map();
    #allTime = createAllTime();
    #pendingBackup = createPendingBackup();
    #pendingChatIds = new Set();
    #pendingTimer = null;

    #getChatId;
    #getMetadata;
    #saveMetadata;
    #storage;
    #getPrices;
    #sanitizeChatFileName;
    #now;
    #debounceMs;

    /**
     * @param {object} [options]
     * @param {() => (string|null)} [options.getChatId] Chat currently open in
     *   SillyTavern, used to decide whether a namespace can be written.
     * @param {() => (object|null)} [options.getMetadata] Live `chat_metadata`
     *   object. Without it the ledger stays in memory only.
     * @param {(() => (Promise|void))|null} [options.saveMetadata] Persists the
     *   live chat metadata. Called after the debounce and by {@link flush}.
     * @param {((name: string) => (string|Promise<string>))|null} [options.sanitizeChatFileName]
     *   Resolves SillyTavern's server-side file-name sanitization, used to key
     *   a non-open renamed chat by the name the server actually created.
     * @param {object|null} [options.storage] localStorage-like backend for the
     *   all-time aggregate and the pending-record backup.
     * @param {() => (object|null)} [options.getPrices] Price table used to
     *   resolve the cost of a row when the cap evicts it.
     * @param {() => number} [options.now] Clock, injected for tests.
     * @param {number} [options.debounceMs] Delay before a pending save runs.
     */
    constructor({
        getChatId = () => null,
        getMetadata = () => null,
        saveMetadata = null,
        storage = null,
        getPrices = () => null,
        sanitizeChatFileName = null,
        now = () => Date.now(),
        debounceMs = 1000,
    } = {}) {
        this.#getChatId = getChatId;
        this.#getMetadata = getMetadata;
        this.#saveMetadata = saveMetadata;
        this.#storage = storage;
        this.#getPrices = getPrices;
        this.#sanitizeChatFileName = sanitizeChatFileName;
        this.#now = now;
        this.#debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 1000;
        this.#allTime = readAllTime(storage);
        this.#pendingBackup = readPendingBackup(storage);
    }

    /**
     * Appends one record to the bucket of the chat it was sent from. Writes the
     * namespace through to the live chat metadata immediately (so any
     * SillyTavern chat save carries it), stages a pending copy for replay, and
     * debounces the explicit save.
     *
     * @param {object} record
     */
    add(record) {
        if (!record || typeof record !== 'object') return;
        const chatId = record.chatId ?? null;
        const state = this.#ensureState(chatId);
        const prices = this.#readPrices();

        state.records.push(record);
        state.revision += 1;
        this.#evictOverflow(state, prices);
        this.#addToAllTime(record, prices);

        if (this.#isActiveChat(chatId) && this.#getMetadata()) {
            state.ownerChatId = chatId;
            this.#writeNamespace(state);
        }
        this.#stagePendingBackup(chatId, state);
        this.#scheduleSave(chatId);
    }

    /**
     * Newest-first records for one chat.
     *
     * @param {string|null} chatId
     * @returns {object[]}
     */
    recordsFor(chatId) {
        return [...(this.#byChat.get(chatKey(chatId))?.records ?? [])].reverse();
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
    startRun(chatId, { now = this.#now() } = {}) {
        const state = this.#ensureState(chatId);
        const runs = state.runs;
        const previousId = state.currentRunId;
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
        state.currentRunId = run.runId;
        state.revision += 1;
        if (this.#isActiveChat(chatId) && this.#getMetadata()) {
            state.ownerChatId = chatId;
            this.#writeNamespace(state);
        }
        this.#stagePendingBackup(chatId, state);
        this.#scheduleSave(chatId);
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
        return this.#byChat.get(chatKey(chatId))?.currentRunId ?? null;
    }

    /**
     * Newest-first run markers for one chat. Old runs stay available after a
     * new one is started.
     *
     * @param {string|null} chatId
     * @returns {object[]}
     */
    runsFor(chatId) {
        return [...(this.#byChat.get(chatKey(chatId))?.runs ?? [])]
            .reverse()
            .map((run) => ({ ...run }));
    }

    /**
     * Archived counters for the rows the cap has evicted, shaped for the
     * summary functions in `core/usage-stats.js`.
     *
     * @param {string|null} chatId
     * @returns {{total: object, byOrigin: object, byModel: object, byConfiguration: object}}
     */
    archivedFor(chatId) {
        return normalizeUsageArchive(this.#byChat.get(chatKey(chatId))?.archived);
    }

    /**
     * How many rows the tab can show and how many the counters include.
     *
     * @param {string|null} chatId
     * @returns {{limit: number, retained: number, total: number}}
     */
    retentionFor(chatId) {
        const state = this.#byChat.get(chatKey(chatId));
        const retained = state?.records.length ?? 0;
        const evicted = state
            ? (state.archived.total.requests ?? 0) + (state.archived.total.excludedRequests ?? 0)
            : 0;
        return { limit: USAGE_RECORD_LIMIT, retained, total: retained + evicted };
    }

    /**
     * The all-time aggregate across chats, plus how many chat buckets it holds.
     *
     * @returns {{totals: object, chats: number}}
     */
    allTimeForView() {
        return {
            totals: normalizeUsageAccumulator(this.#allTime.totals),
            chats: Object.keys(this.#allTime.chats).length,
        };
    }

    /**
     * Loads (or re-adopts) one chat's namespace. A pending copy left by a save
     * that never ran is replayed when it is newer than the persisted namespace,
     * so a switch inside the debounce does not lose the records. A pending copy
     * the persisted namespace has caught up with is dropped.
     *
     * A namespace whose owner is a different chat is a copy — a branch or a
     * manual file copy — so it is removed and the chat starts clean.
     *
     * @param {string|null} chatId
     */
    loadChat(chatId) {
        const key = chatKey(chatId);
        const active = this.#isActiveChat(chatId);
        const metadata = active ? this.#getMetadata() : null;
        const raw = metadata ? metadata[USAGE_CHAT_METADATA_KEY] : null;
        const persisted = normalizeNamespace(raw);
        // The pending copy is the same shape as the namespace and carries a
        // revision, so the newer snapshot wins instead of being merged and
        // risking a double-counted archive.
        const pendingKey = bucketKeyFor(chatId);
        const pending = normalizeNamespace(this.#pendingBackup.chats[pendingKey]);
        const persistedOwned = !!persisted && persisted.ownerChatId === chatId;
        const pendingAuthoritative = !!pending
            && (!persistedOwned || pending.revision > persisted.revision);
        // Reading the namespace back at an equal-or-newer revision is the only
        // reliable proof that the chat file actually saved it.
        if (persistedOwned && pending && persisted.revision >= pending.revision) {
            delete this.#pendingBackup.chats[pendingKey];
            this.#persistPendingBackup();
        }
        const existing = this.#byChat.get(key);
        let changed = false;

        if (pendingAuthoritative && pending.revision >= (existing?.revision ?? 0)) {
            this.#byChat.set(key, { ...stateFromNamespace(pending), ownerChatId: chatId });
            changed = true;
        } else if (persistedOwned) {
            if (!existing) {
                this.#byChat.set(key, { ...stateFromNamespace(persisted), ownerChatId: chatId });
            } else {
                changed = this.#mergePersistedState(existing, persisted);
                existing.ownerChatId = chatId;
            }
        } else {
            if (raw != null && metadata) {
                // Copied namespace: it belongs to another chat, so this chat
                // must not inherit it. The deletion persists with the next
                // SillyTavern chat save.
                delete metadata[USAGE_CHAT_METADATA_KEY];
            }
            if (!existing) this.#byChat.set(key, createChatState(chatId));
        }

        const state = this.#byChat.get(key);
        if (changed && active && metadata) {
            this.#writeNamespace(state);
            this.#scheduleSave(chatId);
        }
    }

    /**
     * Handles SillyTavern's chat switch. Flushes a pending all-time/metadata
     * save first, then adopts the new chat's namespace.
     *
     * @param {string|null} chatId
     */
    handleChatChanged(chatId) {
        this.flush();
        this.loadChat(chatId);
    }

    /**
     * Writes any pending save now. A namespace is only written when the chat it
     * belongs to is still the open one; the all-time aggregate and any staged
     * record copy are always flushed because they span chats.
     */
    flush() {
        this.#persistPending();
    }

    /**
     * Removes a deleted chat's in-memory state, pending copy, all-time bucket
     * and any queued save, so a queued write cannot resurrect the chat.
     *
     * @param {string|null} chatId
     */
    handleChatDeleted(chatId) {
        const key = chatKey(chatId);
        this.#pendingChatIds.delete(key);
        this.#byChat.delete(key);
        this.#deletePendingBackup(chatId);

        const bucketKey = bucketKeyFor(chatId);
        if (bucketKey && this.#allTime.chats[bucketKey]) {
            this.#allTime.totals = subtractUsageAccumulators(
                this.#allTime.totals,
                this.#allTime.chats[bucketKey],
            );
            delete this.#allTime.chats[bucketKey];
            this.#persistAllTime();
        }

        const metadata = this.#getMetadata();
        if (metadata && this.#isActiveChat(chatId)
            && metadata[USAGE_CHAT_METADATA_KEY]?.ownerChatId === chatId) {
            delete metadata[USAGE_CHAT_METADATA_KEY];
        }
    }

    /**
     * Moves a renamed chat's records, pending copy, namespace owner and
     * all-time bucket to the new id. The all-time total itself does not change.
     *
     * SillyTavern emits file names with a `.jsonl` suffix; chat ids are
     * extension-less, so the suffix is stripped here.
     *
     * The event reports the *requested* name, but the server sanitizes it and
     * the reloaded chat id is the sanitized one. When the rename targeted the
     * chat that was open, the wiring passes the ids on either side of the
     * reload so the state moves to the id the next record will actually use.
     *
     * @param {string} oldChatId
     * @param {string} newChatId
     * @param {object} [options]
     * @param {string|null} [options.previousChatId] Chat id open before the
     *   rename reload.
     * @param {string|null} [options.currentChatId] Chat id after the rename
     *   reload (the server-sanitized name for the open chat).
     */
    async handleChatRenamed(oldChatId, newChatId, { previousChatId = null, currentChatId = null } = {}) {
        const oldId = stripChatFileExtension(oldChatId);
        if (!oldId) return;
        const previousId = stripChatFileExtension(previousChatId);
        const activeId = stripChatFileExtension(currentChatId);
        const eventId = stripChatFileExtension(newChatId);
        // The open chat was reloaded under the server-sanitized name before
        // this event fired, so its current id is authoritative. For a chat
        // that is not open there is no reloaded id, and the event carries the
        // requested name; ask SillyTavern how it sanitized that name.
        const openChatRenamed = previousId === oldId && activeId && activeId !== oldId;
        const newId = openChatRenamed ? activeId : (await this.#sanitizeFileName(eventId)) ?? eventId;
        if (!newId || oldId === newId) return;

        const oldKey = chatKey(oldId);
        const newKey = chatKey(newId);
        const previous = this.#byChat.get(oldKey);
        if (previous) {
            previous.ownerChatId = newId;
            this.#byChat.delete(oldKey);
            const current = this.#byChat.get(newKey);
            if (current && current !== previous) this.#mergeMovedState(current, previous);
            else this.#byChat.set(newKey, previous);
        }

        const pendingCopy = this.#pendingBackup.chats[oldId];
        let movedPending = null;
        if (pendingCopy) {
            // If the target id somehow already has a copy, merge one whole
            // snapshot into the other; keeping one revision with the other's
            // records would make the stored entry lie.
            movedPending = this.#mergePendingSnapshots(pendingCopy, this.#pendingBackup.chats[newId]);
            this.#pendingBackup.chats[newId] = movedPending;
            delete this.#pendingBackup.chats[oldId];
            this.#persistPendingBackup();
        }

        const bucket = this.#allTime.chats[oldId];
        if (bucket) {
            this.#allTime.chats[newId] = mergeUsageAccumulators(
                this.#allTime.chats[newId] ?? null,
                bucket,
            );
            delete this.#allTime.chats[oldId];
            this.#persistAllTime();
        }

        if (!this.#isActiveChat(newId)) return;
        let state = this.#byChat.get(newKey);
        const adoptedPending = movedPending ? normalizeNamespace(movedPending) : null;
        if (adoptedPending && adoptedPending.revision >= (state?.revision ?? 0)) {
            state = { ...adoptedPending, ownerChatId: newId };
            this.#byChat.set(newKey, state);
        }
        if (!state) return;
        // A non-open renamed chat cannot be written through: the renamed file
        // still owns the old id and would be discarded as a copy on open. The
        // pending copy carries the moved state until that open replays it.
        this.#stagePendingBackup(newId, state);
        if (this.#getMetadata() && this.#isActiveChat(newId)) {
            this.#writeNamespace(state);
            // A rename of the open chat arrives after SillyTavern reloaded the
            // renamed file, so the namespace must be saved now, not debounced.
            this.#saveMetadataNow();
        }
    }

    #ensureState(chatId) {
        const key = chatKey(chatId);
        if (!this.#byChat.has(key)) this.loadChat(chatId);
        return this.#byChat.get(key) ?? createChatState(chatId);
    }

    #evictOverflow(state, prices) {
        while (state.records.length > USAGE_RECORD_LIMIT) {
            const evicted = state.records.shift();
            addRecordToUsageArchive(state.archived, evicted, prices);
        }
    }

    #addToAllTime(record, prices) {
        addRecordToUsageAccumulator(this.#allTime.totals, record, prices);
        const bucketKey = bucketKeyFor(record.chatId ?? null);
        if (!bucketKey) return;
        if (!this.#allTime.chats[bucketKey]) this.#allTime.chats[bucketKey] = createUsageAccumulator();
        addRecordToUsageAccumulator(this.#allTime.chats[bucketKey], record, prices);
    }

    #writeNamespace(state) {
        const metadata = this.#getMetadata();
        if (!metadata) return;
        metadata[USAGE_CHAT_METADATA_KEY] = serializeState(state);
    }

    #scheduleSave(chatId) {
        if (!this.#saveMetadata && !this.#storage) return;
        this.#pendingChatIds.add(chatKey(chatId));
        this.#clearPendingTimer();
        this.#pendingTimer = setTimeout(() => {
            this.#pendingTimer = null;
            this.#persistPending();
        }, this.#debounceMs);
    }

    #persistPending() {
        this.#clearPendingTimer();
        const pendingIds = [...this.#pendingChatIds];
        this.#pendingChatIds.clear();
        if (this.#storage) this.#persistAllTime();
        if (pendingIds.length === 0) return;

        const chatId = this.#getChatId() ?? null;
        if (!pendingIds.includes(chatKey(chatId))) return;
        const state = this.#byChat.get(chatKey(chatId));
        const metadata = this.#getMetadata();
        if (!state || !metadata) return;
        metadata[USAGE_CHAT_METADATA_KEY] = serializeState(state);
        this.#saveMetadataNow();
    }

    #saveMetadataNow() {
        const save = this.#saveMetadata;
        if (typeof save !== 'function') return;
        try {
            // SillyTavern's saveMetadata resolves even when the underlying save
            // timed out or failed, so a resolved promise is not proof the chat
            // file has the namespace. The pending copy is cleared only when a
            // later load reads back a namespace at least as new (see loadChat).
            const result = save();
            if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch {
            /* persistence must never break capture or the UI */
        }
    }

    async #sanitizeFileName(name) {
        const sanitize = this.#sanitizeChatFileName;
        if (typeof sanitize !== 'function' || !name) return null;
        try {
            const value = await sanitize(name);
            return stripChatFileExtension(value) || null;
        } catch {
            return null;
        }
    }

    #mergePendingSnapshots(left, right) {
        if (!left) return right;
        if (!right) return left;
        const base = (right.revision ?? 0) > (left.revision ?? 0) ? right : left;
        const other = base === left ? right : left;
        const state = stateFromNamespace(base);
        const knownIds = new Set(state.records.map(recordKey).filter(Boolean));
        for (const record of other.records ?? []) {
            const key = recordKey(record);
            if (key && knownIds.has(key)) continue;
            if (key) knownIds.add(key);
            state.records.push(record);
        }
        this.#evictOverflow(state, this.#readPrices());
        state.archived = mergeUsageArchives(state.archived, other.archived);
        const knownRuns = new Set(state.runs.map((run) => run.runId));
        for (const run of other.runs ?? []) {
            if (!knownRuns.has(run.runId)) state.runs.push(run);
        }
        if (!state.currentRunId) state.currentRunId = other.currentRunId;
        state.revision = Math.max(left.revision ?? 0, right.revision ?? 0);
        return serializeState(state);
    }

    #stagePendingBackup(chatId, state) {
        if (!this.#storage || typeof this.#saveMetadata !== 'function') return;
        const key = bucketKeyFor(chatId);
        if (!key) return;
        this.#pendingBackup.chats[key] = serializeState({ ...state, ownerChatId: chatId });
        this.#persistPendingBackup();
    }

    #deletePendingBackup(chatId) {
        const key = bucketKeyFor(chatId);
        if (!key || !this.#pendingBackup.chats[key]) return;
        delete this.#pendingBackup.chats[key];
        this.#persistPendingBackup();
    }

    #persistAllTime() {
        if (!this.#storage) return;
        try {
            this.#storage.setItem(USAGE_ALL_TIME_STORAGE_KEY, JSON.stringify({
                version: ALL_TIME_VERSION,
                updatedAt: this.#now(),
                totals: normalizeUsageAccumulator(this.#allTime.totals),
                chats: Object.fromEntries(Object.entries(this.#allTime.chats).map(([chatId, counters]) => [
                    chatId,
                    normalizeUsageAccumulator(counters),
                ])),
            }));
        } catch {
            /* a full or disabled storage must not break the ledger */
        }
    }

    #persistPendingBackup() {
        if (!this.#storage) return;
        try {
            this.#storage.setItem(USAGE_PENDING_STORAGE_KEY, JSON.stringify({
                version: PENDING_VERSION,
                chats: this.#pendingBackup.chats,
            }));
        } catch {
            /* a full or disabled storage must not break capture */
        }
    }

    #clearPendingTimer() {
        if (this.#pendingTimer) {
            clearTimeout(this.#pendingTimer);
            this.#pendingTimer = null;
        }
    }

    #isActiveChat(chatId) {
        return (this.#getChatId() ?? null) === (chatId ?? null);
    }

    #readPrices() {
        try {
            return this.#getPrices?.() ?? null;
        } catch {
            return null;
        }
    }

    #mergePersistedState(existing, persisted) {
        const changed = this.#mergeRecordsInto(existing, persisted.records);
        // A state that was already adopted includes the persisted archive;
        // merging it again would double count.
        if (isUsageArchiveEmpty(existing.archived) && !isUsageArchiveEmpty(persisted.archived)) {
            existing.archived = mergeUsageArchives(existing.archived, persisted.archived);
        }

        if (existing.runs.length === 0 && persisted.runs.length > 0) {
            existing.runs = persisted.runs;
            existing.currentRunId = persisted.currentRunId;
            changed = true;
        }
        if (persisted.revision > existing.revision) existing.revision = persisted.revision;
        return changed;
    }

    #mergeMovedState(target, source) {
        this.#mergeRecordsInto(target, source.records);
        if (isUsageArchiveEmpty(target.archived) && !isUsageArchiveEmpty(source.archived)) {
            target.archived = mergeUsageArchives(target.archived, source.archived);
        }
        const knownRuns = new Set(target.runs.map((run) => run.runId));
        for (const run of source.runs) {
            if (!knownRuns.has(run.runId)) target.runs.push(run);
        }
        if (!target.currentRunId) target.currentRunId = source.currentRunId;
        target.ownerChatId = source.ownerChatId;
        target.revision = Math.max(target.revision, source.revision);
    }

    #mergeRecordsInto(state, records) {
        let changed = false;
        const knownIds = new Set(state.records.map(recordKey).filter(Boolean));
        for (const record of records ?? []) {
            const key = recordKey(record);
            if (key && knownIds.has(key)) continue;
            if (key) knownIds.add(key);
            state.records.push(record);
            changed = true;
        }
        if (changed) this.#evictOverflow(state, this.#readPrices());
        return changed;
    }
}

const CHAT_STATE_FIELDS = ['ownerChatId', 'records', 'archived', 'runs', 'currentRunId', 'revision'];

function createChatState(chatId) {
    return stateFromNamespace({
        ownerChatId: chatId ?? null,
        records: [],
        archived: createUsageArchive(),
        runs: [],
        currentRunId: null,
        revision: 0,
    });
}

function stateFromNamespace(namespace) {
    const state = {};
    for (const field of CHAT_STATE_FIELDS) state[field] = namespace?.[field] ?? null;
    state.records = Array.isArray(state.records) ? state.records : [];
    state.archived = state.archived ?? createUsageArchive();
    state.runs = Array.isArray(state.runs) ? state.runs : [];
    state.revision = Number.isFinite(state.revision) ? state.revision : 0;
    return state;
}

function serializeState(state) {
    const snapshot = { version: NAMESPACE_VERSION };
    for (const field of CHAT_STATE_FIELDS) snapshot[field] = state[field] ?? null;
    return snapshot;
}

const CHAT_STATE_NORMALIZERS = {
    ownerChatId: (value) => (typeof value === 'string' || value === null ? value : null),
    records: (value) => (Array.isArray(value)
        ? value.filter((record) => record && typeof record === 'object')
        : []),
    archived: (value) => normalizeUsageArchive(value),
    runs: (value) => normalizeRuns(value),
    currentRunId: (value) => (typeof value === 'string' ? value : null),
    revision: (value) => (Number.isFinite(value) ? value : 0),
};

function normalizeNamespace(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.version !== NAMESPACE_VERSION) return null;

    const normalized = {};
    for (const field of CHAT_STATE_FIELDS) {
        normalized[field] = CHAT_STATE_NORMALIZERS[field](raw[field]);
    }
    return { version: NAMESPACE_VERSION, ...normalized };
}

function normalizeRuns(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((run) => run && typeof run === 'object' && typeof run.runId === 'string' && run.runId)
        .map((run) => ({
            runId: run.runId,
            label: typeof run.label === 'string' ? run.label : run.runId,
            startedAt: Number.isFinite(run.startedAt) ? run.startedAt : null,
            endedAt: Number.isFinite(run.endedAt) ? run.endedAt : null,
        }));
}

function createAllTime() {
    return { totals: createUsageAccumulator(), chats: {} };
}

function createPendingBackup() {
    return { chats: {} };
}

function readAllTime(storage) {
    const empty = createAllTime();
    if (!storage) return empty;
    try {
        const parsed = JSON.parse(storage.getItem(USAGE_ALL_TIME_STORAGE_KEY) ?? 'null');
        if (!parsed || typeof parsed !== 'object' || parsed.version !== ALL_TIME_VERSION) return empty;
        const allTime = createAllTime();
        allTime.totals = normalizeUsageAccumulator(parsed.totals);
        for (const [chatId, counters] of Object.entries(parsed.chats ?? {})) {
            const normalized = normalizeUsageAccumulator(counters);
            if (!isUsageAccumulatorEmpty(normalized)) allTime.chats[chatId] = normalized;
        }
        return allTime;
    } catch {
        return empty;
    }
}

function readPendingBackup(storage) {
    const empty = createPendingBackup();
    if (!storage) return empty;
    try {
        const parsed = JSON.parse(storage.getItem(USAGE_PENDING_STORAGE_KEY) ?? 'null');
        if (!parsed || typeof parsed !== 'object' || parsed.version !== PENDING_VERSION) return empty;
        const backup = createPendingBackup();
        for (const [chatId, entry] of Object.entries(parsed.chats ?? {})) {
            const namespace = normalizeNamespace(entry);
            if (!namespace) continue;
            if (namespace.records.length === 0 && namespace.runs.length === 0) continue;
            backup.chats[chatId] = { ...namespace, ownerChatId: namespace.ownerChatId ?? chatId };
        }
        return backup;
    } catch {
        return empty;
    }
}

function bucketKeyFor(chatId) {
    return typeof chatId === 'string' && chatId ? chatId : null;
}

function chatKey(chatId) {
    return chatId ?? null;
}

function recordKey(record) {
    return typeof record?.recordId === 'string' && record.recordId ? record.recordId : null;
}

function stripChatFileExtension(name) {
    if (typeof name !== 'string' || !name) return null;
    return name.replace(/\.jsonl$/i, '');
}

function createRunId(now) {
    _runSequence += 1;
    const stamp = Number.isFinite(now) ? Math.floor(now).toString(36) : Date.now().toString(36);
    return `run-${stamp}-${_runSequence}`;
}
