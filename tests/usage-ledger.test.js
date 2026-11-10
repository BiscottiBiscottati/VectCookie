/**
 * Usage ledger — the persistence and chat-lifecycle seam.
 *
 * Drives the real UsageLedger over a fake chat-metadata object, a fake
 * localStorage and an injected clock, the same way the extension wires it to
 * SillyTavern. Asserts only what a reload, a lifecycle event or the view model
 * can observe.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    UsageLedger,
    USAGE_CHAT_METADATA_KEY,
    USAGE_ALL_TIME_STORAGE_KEY,
    USAGE_PENDING_STORAGE_KEY,
    USAGE_RECORD_LIMIT,
} from '../core/usage-ledger.js';
import { usageRecord } from './fixtures/usage.js';

function memoryStorage(initial = {}) {
    const items = new Map(Object.entries(initial));
    return {
        getItem: (key) => (items.has(key) ? items.get(key) : null),
        setItem: vi.fn((key, value) => items.set(key, value)),
        removeItem: (key) => items.delete(key),
        read: (key) => items.get(key),
        readAllTime: () => JSON.parse(items.get(USAGE_ALL_TIME_STORAGE_KEY) ?? 'null'),
    };
}

function record(recordId, chatId = 'chat-1', overrides = {}) {
    return usageRecord({
        recordId,
        chatId,
        timestamp: 1_700_000_000_000 + Number(String(recordId).replace(/\D/g, '') || 0),
        runId: null,
        origin: 'story',
        cost: null,
        cacheDiscount: null,
        ...overrides,
    });
}

function harness({
    chatId = 'chat-1',
    metadata = {},
    storage = memoryStorage(),
    saveMetadata,
    prices = null,
    sanitizeChatFileName = null,
} = {}) {
    const env = { chatId, metadata, storage, prices };
    const save = saveMetadata ?? vi.fn(async () => {});
    const ledger = new UsageLedger({
        getChatId: () => env.chatId,
        getMetadata: () => env.metadata,
        saveMetadata: save,
        storage: env.storage,
        getPrices: () => env.prices,
        sanitizeChatFileName,
        now: () => 1_700_000_000_000,
        debounceMs: 1000,
    });
    return { ledger, env, save };
}

function reload(env, options = {}) {
    const ledger = new UsageLedger({
        getChatId: () => env.chatId,
        getMetadata: () => env.metadata,
        saveMetadata: options.saveMetadata ?? vi.fn(async () => {}),
        storage: env.storage,
        getPrices: () => env.prices,
        now: () => 1_700_000_000_000,
        debounceMs: 1000,
    });
    ledger.loadChat(env.chatId);
    return ledger;
}

describe('usage ledger — reload', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('restores the records and counters of the active chat from its metadata', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1'));
        ledger.add(record('r2'));
        ledger.flush();

        expect(env.metadata[USAGE_CHAT_METADATA_KEY].ownerChatId).toBe('chat-1');
        expect(env.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(2);

        const restored = reload(env);

        expect(restored.recordsFor('chat-1').map((entry) => entry.recordId)).toEqual(['r2', 'r1']);
        expect(restored.retentionFor('chat-1')).toMatchObject({ retained: 2, total: 2 });
    });

    it('restores the counters of capped rows so the totals survive a reload', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        for (let index = 0; index <= USAGE_RECORD_LIMIT; index += 1) {
            ledger.add(record(`r${index}`));
        }
        ledger.flush();

        const restored = reload(env);

        expect(restored.recordsFor('chat-1')).toHaveLength(USAGE_RECORD_LIMIT);
        expect(restored.archivedFor('chat-1').total.requests).toBe(1);
        expect(restored.retentionFor('chat-1').total).toBe(USAGE_RECORD_LIMIT + 1);
    });

    it('flushes a pending metadata save when the same chat is reloaded', () => {
        const { ledger, env, save } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1'));

        // A same-id CHAT_CHANGED (for example a reload) is the one case where
        // the live metadata object still belongs to the pending chat, so the
        // flush can actually save it.
        ledger.handleChatChanged('chat-1');

        expect(save).toHaveBeenCalledTimes(1);
        expect(env.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(1);
    });

    it('restores measurement runs so a before/after comparison survives a reload', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        const run = ledger.startRun('chat-1');
        ledger.add(record('r1', 'chat-1', { runId: run.runId }));
        ledger.flush();

        const restored = reload(env);

        expect(restored.currentRunIdFor('chat-1')).toBe(run.runId);
        expect(restored.runsFor('chat-1')).toHaveLength(1);
        expect(restored.recordsFor('chat-1')[0].runId).toBe(run.runId);
    });

    it('keeps records captured for a chat that was switched away from before the response landed', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.flush();
        const chatOneMetadata = JSON.parse(JSON.stringify(env.metadata));

        env.chatId = 'chat-2';
        env.metadata = {};
        ledger.handleChatChanged('chat-2');
        ledger.add(record('r2', 'chat-1'));

        env.chatId = 'chat-1';
        env.metadata = chatOneMetadata;
        ledger.handleChatChanged('chat-1');

        expect(ledger.recordsFor('chat-1').map((entry) => entry.recordId)).toEqual(['r2', 'r1']);
    });
});

describe('usage ledger — 500-record cap', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps the newest records while the total keeps counting', () => {
        const { ledger } = harness();
        ledger.loadChat('chat-1');

        for (let index = 0; index <= USAGE_RECORD_LIMIT; index += 1) {
            ledger.add(record(`r${index}`));
        }

        const records = ledger.recordsFor('chat-1');
        expect(records).toHaveLength(USAGE_RECORD_LIMIT);
        expect(records[0].recordId).toBe(`r${USAGE_RECORD_LIMIT}`);
        expect(records.at(-1).recordId).toBe('r1');
        expect(ledger.retentionFor('chat-1')).toMatchObject({
            limit: USAGE_RECORD_LIMIT,
            retained: USAGE_RECORD_LIMIT,
            total: USAGE_RECORD_LIMIT + 1,
        });
    });

    it('folds the evicted row into the archived counters instead of losing it', () => {
        const { ledger } = harness();
        ledger.loadChat('chat-1');

        for (let index = 0; index <= USAGE_RECORD_LIMIT; index += 1) {
            ledger.add(record(`r${index}`, 'chat-1', { origin: 'story', promptTokens: 10, hitTokens: 4 }));
        }

        const archived = ledger.archivedFor('chat-1');
        expect(archived.total.requests).toBe(1);
        expect(archived.total.promptTokens).toBe(10);
        expect(archived.total.hitTokens).toBe(4);
        expect(archived.byOrigin.story.requests).toBe(1);
    });
});

describe('usage ledger — all-time aggregate', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('increments the all-time total with each record, across chats', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.add(record('r2', 'chat-1'));

        env.chatId = 'chat-2';
        env.metadata = {};
        ledger.handleChatChanged('chat-2');
        ledger.add(record('r3', 'chat-2'));
        ledger.flush();

        expect(ledger.allTimeForView().totals.requests).toBe(3);
        expect(ledger.allTimeForView().chats).toBe(2);
    });

    it('survives a reload from local storage', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.flush();

        const restored = reload(env);

        expect(restored.allTimeForView().totals.requests).toBe(1);
        expect(restored.allTimeForView().chats).toBe(1);
    });

    it('flushes a pending all-time save when the chat changes', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));

        expect(env.storage.read(USAGE_ALL_TIME_STORAGE_KEY)).toBeUndefined();

        env.chatId = 'chat-2';
        env.metadata = {};
        ledger.handleChatChanged('chat-2');

        expect(env.storage.readAllTime().totals.requests).toBe(1);
    });
});

describe('usage ledger — pending save', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('replays a record whose save had not run when the chat changed', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));

        // Switch inside the debounce and never let the metadata save run.
        env.chatId = 'chat-2';
        env.metadata = {};
        ledger.handleChatChanged('chat-2');

        // A reload loses the in-memory state and the chat file never carried
        // the namespace; the pending copy is the only survivor.
        env.chatId = 'chat-1';
        env.metadata = {};
        const restored = reload(env);

        expect(restored.recordsFor('chat-1').map((entry) => entry.recordId)).toEqual(['r1']);
        expect(restored.allTimeForView().totals.requests).toBe(1);
        expect(restored.recordsFor('chat-2')).toEqual([]);
    });

    it('replays the archived counters too, so a capped row is not lost with the save', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        for (let index = 0; index <= USAGE_RECORD_LIMIT; index += 1) {
            ledger.add(record(`r${index}`));
        }

        env.chatId = 'chat-2';
        env.metadata = {};
        ledger.handleChatChanged('chat-2');

        env.chatId = 'chat-1';
        env.metadata = {};
        const restored = reload(env);

        expect(restored.recordsFor('chat-1')).toHaveLength(USAGE_RECORD_LIMIT);
        expect(restored.archivedFor('chat-1').total.requests).toBe(1);
        expect(restored.retentionFor('chat-1').total).toBe(USAGE_RECORD_LIMIT + 1);
        expect(restored.allTimeForView().totals.requests).toBe(USAGE_RECORD_LIMIT + 1);
    });

    it('replays a run opened before the save ran', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        const run = ledger.startRun('chat-1');

        env.chatId = 'chat-2';
        env.metadata = {};
        ledger.handleChatChanged('chat-2');

        env.chatId = 'chat-1';
        env.metadata = {};
        const restored = reload(env);

        expect(restored.currentRunIdFor('chat-1')).toBe(run.runId);
        expect(restored.runsFor('chat-1')).toHaveLength(1);
    });

    it('keeps the pending copy after a save and clears it only when a load reads it back', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1'));

        ledger.flush();
        expect(JSON.parse(env.storage.read(USAGE_PENDING_STORAGE_KEY)).chats['chat-1']).toBeTruthy();

        // The resolved save is not proof: SillyTavern's saveMetadata resolves
        // even when the write failed. Reopening and reading the namespace back
        // is the proof, and that is what clears the copy.
        ledger.loadChat('chat-1');

        expect(JSON.parse(env.storage.read(USAGE_PENDING_STORAGE_KEY)).chats['chat-1']).toBeUndefined();
    });

    it('adopts a newer pending snapshot instead of merging it with a stale namespace', () => {
        const storage = memoryStorage({
            [USAGE_PENDING_STORAGE_KEY]: JSON.stringify({
                version: 1,
                chats: {
                    'chat-1': {
                        version: 1,
                        ownerChatId: 'chat-1',
                        records: [record('r-stale'), record('r-new')],
                        runs: [],
                        currentRunId: null,
                        revision: 2,
                    },
                },
            }),
        });
        const metadata = {
            [USAGE_CHAT_METADATA_KEY]: {
                version: 1,
                ownerChatId: 'chat-1',
                records: [record('r-stale')],
                runs: [],
                currentRunId: null,
                revision: 1,
            },
        };
        const ledger = new UsageLedger({
            getChatId: () => 'chat-1',
            getMetadata: () => metadata,
            saveMetadata: vi.fn(async () => {}),
            storage,
            debounceMs: 1000,
        });

        ledger.loadChat('chat-1');

        expect(ledger.recordsFor('chat-1').map((entry) => entry.recordId)).toEqual(['r-new', 'r-stale']);
        expect(JSON.parse(storage.read(USAGE_PENDING_STORAGE_KEY)).chats['chat-1']).toBeTruthy();
    });

    it('prefers the persisted namespace once it has caught up with the pending copy', () => {
        const storage = memoryStorage({
            [USAGE_PENDING_STORAGE_KEY]: JSON.stringify({
                version: 1,
                chats: {
                    'chat-1': {
                        version: 1,
                        ownerChatId: 'chat-1',
                        records: [record('r-old')],
                        runs: [],
                        currentRunId: null,
                        revision: 1,
                    },
                },
            }),
        });
        const metadata = {
            [USAGE_CHAT_METADATA_KEY]: {
                version: 1,
                ownerChatId: 'chat-1',
                records: [record('r-old'), record('r-newer')],
                runs: [],
                currentRunId: null,
                revision: 2,
            },
        };
        const ledger = new UsageLedger({
            getChatId: () => 'chat-1',
            getMetadata: () => metadata,
            saveMetadata: vi.fn(async () => {}),
            storage,
        });

        ledger.loadChat('chat-1');

        expect(ledger.recordsFor('chat-1').map((entry) => entry.recordId)).toEqual(['r-newer', 'r-old']);
        expect(JSON.parse(storage.read(USAGE_PENDING_STORAGE_KEY)).chats['chat-1']).toBeUndefined();
    });

    it('keeps capturing when local storage rejects a write', () => {
        const storage = {
            getItem: () => null,
            setItem: () => { throw new Error('quota exceeded'); },
        };
        const { ledger, env } = harness({ storage });
        ledger.loadChat('chat-1');

        expect(() => ledger.add(record('r1'))).not.toThrow();
        expect(() => ledger.flush()).not.toThrow();
        expect(ledger.recordsFor('chat-1')).toHaveLength(1);
        expect(env.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(1);
    });

    it('does not replay a pending copy whose chat was deleted', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.handleChatDeleted('chat-1');

        env.metadata = {};
        const restored = reload(env);

        expect(restored.recordsFor('chat-1')).toEqual([]);
        expect(restored.allTimeForView().totals.requests).toBe(0);
    });
});

describe('usage ledger — mixed cap matrix', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('archives estimated, unavailable, failed and aborted rows without polluting the completed counters', () => {
        const { ledger } = harness();
        ledger.loadChat('chat-1');
        // Put the mixed rows at the oldest end so the cap pushes each branch
        // through the archive.
        ledger.add(record('estimated', 'chat-1', {
            status: 'no-usage',
            usageSource: 'estimated',
            promptTokens: null,
            hitTokens: null,
            missTokens: null,
            completionTokens: null,
            estimatedPromptTokens: 480,
        }));
        ledger.add(record('unavailable', 'chat-1', {
            status: 'no-usage',
            usageSource: 'unavailable',
            promptTokens: null,
            hitTokens: null,
            missTokens: null,
            completionTokens: null,
        }));
        ledger.add(record('failed', 'chat-1', { status: 'error' }));
        ledger.add(record('aborted', 'chat-1', { status: 'aborted' }));
        for (let index = 0; index < USAGE_RECORD_LIMIT + 4; index += 1) {
            ledger.add(record(`measured-${index}`));
        }

        const archived = ledger.archivedFor('chat-1');
        expect(archived.total).toMatchObject({
            requests: 6,
            measuredRequests: 4,
            estimatedRequests: 1,
            unavailableRequests: 1,
            excludedRequests: 2,
            estimatedPromptTokens: 480,
        });
        expect(archived.byOrigin.story.requests).toBe(6);
        expect(archived.byModel['deepseek|deepseek-v4-flash'].accumulator).toMatchObject({
            requests: 6,
            excludedRequests: 2,
        });
        expect(archived.byConfiguration['configuration-unknown'].accumulator.requests).toBe(6);
        expect(ledger.retentionFor('chat-1')).toMatchObject({
            retained: USAGE_RECORD_LIMIT,
            total: USAGE_RECORD_LIMIT + 8,
        });
    });
});

describe('usage ledger — delete and rename', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('deleting a chat removes its records, its bucket and a pending save', () => {
        const { ledger, env, save } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));

        ledger.handleChatDeleted('chat-1');
        vi.advanceTimersByTime(5000);

        expect(ledger.recordsFor('chat-1')).toEqual([]);
        expect(ledger.allTimeForView().totals.requests).toBe(0);
        expect(ledger.allTimeForView().chats).toBe(0);
        expect(env.metadata[USAGE_CHAT_METADATA_KEY]).toBeUndefined();
        expect(save).not.toHaveBeenCalled();
        expect(env.storage.readAllTime().totals.requests).toBe(0);
    });

    it('carries the archived counters of capped rows across a rename', async () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        for (let index = 0; index <= USAGE_RECORD_LIMIT; index += 1) {
            ledger.add(record(`r${index}`));
        }
        ledger.flush();

        env.chatId = 'chat-renamed';
        env.metadata = JSON.parse(JSON.stringify({
            [USAGE_CHAT_METADATA_KEY]: env.metadata[USAGE_CHAT_METADATA_KEY],
        }));
        ledger.loadChat('chat-renamed');
        await ledger.handleChatRenamed('chat-1.jsonl', 'chat-renamed.jsonl');

        expect(ledger.recordsFor('chat-renamed')).toHaveLength(USAGE_RECORD_LIMIT);
        expect(ledger.archivedFor('chat-renamed').total.requests).toBe(1);
        expect(ledger.retentionFor('chat-renamed').total).toBe(USAGE_RECORD_LIMIT + 1);
    });

    it('keys a renamed chat that is not open by the server-sanitized name', async () => {
        const { ledger, env } = harness({
            chatId: 'open-chat',
            sanitizeChatFileName: (name) => name.replace('?', ''),
        });
        ledger.loadChat('open-chat');
        // A chat that was visited earlier still has in-memory state and a
        // bucket, but it is not the one open when the rename fires.
        ledger.add(record('r1', 'A? part'));

        await ledger.handleChatRenamed('A? part.jsonl', 'A? part.jsonl', {
            previousChatId: 'open-chat',
            currentChatId: 'open-chat',
        });

        expect(ledger.recordsFor('A part').map((entry) => entry.recordId)).toEqual(['r1']);
        expect(ledger.recordsFor('A? part')).toEqual([]);
        expect(env.storage.readAllTime().chats['A part']).toBeTruthy();
        expect(env.storage.readAllTime().chats['A? part']).toBeUndefined();

        // The renamed file is not open, so it still owns the old id. The
        // staged copy is what carries the records into the first open.
        env.chatId = 'A part';
        env.metadata = {};
        const reopened = reload(env);
        expect(reopened.recordsFor('A part').map((entry) => entry.recordId)).toEqual(['r1']);
    });

    it('moves the open chat to the server-sanitized id the reload actually opened', async () => {
        const { ledger, env } = harness({ chatId: 'Part: 2' });
        ledger.loadChat('Part: 2');
        ledger.add(record('r1', 'Part: 2'));
        ledger.flush();

        // The server sanitizes 'Part: 2' to 'Part 2' and the client reloads it
        // under that id; CHAT_RENAMED still carries the requested name.
        env.chatId = 'Part 2';
        env.metadata = JSON.parse(JSON.stringify({
            [USAGE_CHAT_METADATA_KEY]: env.metadata[USAGE_CHAT_METADATA_KEY],
        }));
        ledger.loadChat('Part 2');
        await ledger.handleChatRenamed('Part: 2.jsonl', 'Part: 2.jsonl', {
            previousChatId: 'Part: 2',
            currentChatId: 'Part 2',
        });

        expect(ledger.recordsFor('Part 2').map((entry) => entry.recordId)).toEqual(['r1']);
        expect(ledger.recordsFor('Part: 2')).toEqual([]);
        expect(env.metadata[USAGE_CHAT_METADATA_KEY].ownerChatId).toBe('Part 2');
        expect(env.storage.readAllTime().chats['Part 2']).toBeTruthy();
        expect(env.storage.readAllTime().chats['Part: 2']).toBeUndefined();
    });

    it('merges both pending copies when both ids have one', async () => {
        const storage = memoryStorage({
            [USAGE_PENDING_STORAGE_KEY]: JSON.stringify({
                version: 1,
                chats: {
                    'chat-1': {
                        version: 1,
                        ownerChatId: 'chat-1',
                        records: [record('old-only')],
                        runs: [],
                        currentRunId: null,
                        revision: 1,
                    },
                    'chat-2': {
                        version: 1,
                        ownerChatId: 'chat-2',
                        records: [record('newer-a'), record('newer-b')],
                        runs: [],
                        currentRunId: null,
                        revision: 2,
                    },
                },
            }),
        });
        const ledger = new UsageLedger({
            getChatId: () => 'chat-2',
            getMetadata: () => ({}),
            saveMetadata: vi.fn(async () => {}),
            storage,
        });
        ledger.loadChat('chat-2');

        await ledger.handleChatRenamed('chat-1', 'chat-2');

        const pending = JSON.parse(storage.read(USAGE_PENDING_STORAGE_KEY)).chats['chat-2'];
        expect(pending.revision).toBe(2);
        expect(pending.records.map((entry) => entry.recordId)).toEqual(['newer-a', 'newer-b', 'old-only']);
        expect(ledger.recordsFor('chat-2').map((entry) => entry.recordId)).toEqual(['old-only', 'newer-b', 'newer-a']);
    });

    it('renaming moves the bucket and the chat records to the new id', async () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.flush();

        env.chatId = 'chat-renamed';
        env.metadata = JSON.parse(JSON.stringify({
            [USAGE_CHAT_METADATA_KEY]: env.metadata[USAGE_CHAT_METADATA_KEY],
        }));
        ledger.loadChat('chat-renamed');
        await ledger.handleChatRenamed('chat-1.jsonl', 'chat-renamed.jsonl');

        expect(ledger.recordsFor('chat-renamed').map((entry) => entry.recordId)).toEqual(['r1']);
        expect(ledger.recordsFor('chat-1')).toEqual([]);
        expect(ledger.allTimeForView().totals.requests).toBe(1);
        expect(ledger.allTimeForView().chats).toBe(1);
        expect(ledger.allTimeForView().totals).toEqual(env.storage.readAllTime().totals);
        expect(env.storage.readAllTime().chats['chat-renamed']).toBeTruthy();
        expect(env.storage.readAllTime().chats['chat-1']).toBeUndefined();
        expect(env.metadata[USAGE_CHAT_METADATA_KEY].ownerChatId).toBe('chat-renamed');
    });
});

describe('usage ledger — branch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('discards a copied namespace so a branch starts clean', () => {
        const source = harness();
        source.ledger.loadChat('chat-1');
        source.ledger.add(record('r1', 'chat-1'));
        source.ledger.flush();

        // A branch copies the parent chat's metadata into a new chat file.
        const branchHarness = harness({
            chatId: 'branch-1',
            metadata: JSON.parse(JSON.stringify(source.env.metadata)),
            storage: source.env.storage,
        });
        branchHarness.ledger.loadChat('branch-1');

        expect(branchHarness.ledger.recordsFor('branch-1')).toEqual([]);
        expect(branchHarness.ledger.retentionFor('branch-1')).toMatchObject({ retained: 0, total: 0 });
        expect(branchHarness.env.metadata[USAGE_CHAT_METADATA_KEY]).toBeUndefined();
        // The parent keeps its records and its all-time bucket.
        expect(source.ledger.recordsFor('chat-1')).toHaveLength(1);
        expect(source.ledger.allTimeForView().totals.requests).toBe(1);
    });
});

describe('usage ledger — prefix diagnostics', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function fingerprint(overrides = {}) {
        return {
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            origin: 'story',
            messages: [
                { hash: 11, tokens: 1500 },
                { hash: 22, tokens: 600 },
            ],
            ...overrides,
        };
    }

    function fingerprintWithExtraMessage(overrides = {}) {
        return fingerprint({
            messages: [
                { hash: 11, tokens: 1500 },
                { hash: 22, tokens: 600 },
                { hash: 33, tokens: 300 },
            ],
            ...overrides,
        });
    }

    it('carries the fingerprint across a reload so the next request compares', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1', { messageFingerprint: fingerprint() }));
        ledger.flush();

        const reloaded = reload(env);
        const persisted = () => Object.values(
            env.metadata[USAGE_CHAT_METADATA_KEY].promptFingerprints,
        );
        expect(persisted()).toHaveLength(1);
        expect(persisted()[0].messages).toHaveLength(2);

        const next = record('r2', 'chat-1', { hitTokens: 0, messageFingerprint: fingerprintWithExtraMessage() });
        reloaded.add(next);

        expect(next.sharedPrefixTokens).toBe(2100);
        expect(next.possiblePrefixBreaker).toBe(true);
        expect(persisted()[0].messages).toHaveLength(3);
        // The fingerprint is a comparison input, not a row field: retaining it
        // on every row would put a hash array per record in the chat file.
        expect(next.messageFingerprint).toBeUndefined();
    });

    it('loads a namespace written before the fingerprint existed', () => {
        const env = {
            chatId: 'chat-1',
            metadata: {
                [USAGE_CHAT_METADATA_KEY]: {
                    version: 1,
                    ownerChatId: 'chat-1',
                    records: [record('r1')],
                    runs: [],
                    currentRunId: null,
                    revision: 3,
                },
            },
            storage: memoryStorage(),
            prices: null,
        };
        const ledger = reload(env);

        expect(ledger.recordsFor('chat-1')).toHaveLength(1);

        const next = record('r2', 'chat-1', { messageFingerprint: fingerprint() });
        ledger.add(next);

        expect(next.sharedPrefixTokens).toBeNull();
        expect(next.possiblePrefixBreaker).toBe(false);
        expect(Object.values(env.metadata[USAGE_CHAT_METADATA_KEY].promptFingerprints))
            .toEqual([fingerprint()]);
    });

    it('does not let a failed request displace the baseline', () => {
        const { ledger } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1', { messageFingerprint: fingerprint() }));

        const failed = record('r2', 'chat-1', {
            status: 'error',
            hitTokens: 0,
            messageFingerprint: fingerprintWithExtraMessage(),
        });
        ledger.add(failed);

        // A failed row can still show what it shared; it is not a cache miss,
        // so it is never flagged, and it must not move the baseline.
        expect(failed.sharedPrefixTokens).toBe(2100);
        expect(failed.possiblePrefixBreaker).toBe(false);

        const next = record('r3', 'chat-1', { hitTokens: 0, messageFingerprint: fingerprintWithExtraMessage() });
        ledger.add(next);
        expect(next.sharedPrefixTokens).toBe(2100);
        expect(next.possiblePrefixBreaker).toBe(true);
    });

    it('compares each origin against its own baseline', () => {
        const { ledger } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1', { messageFingerprint: fingerprint() }));

        const quiet = record('r2', 'chat-1', {
            origin: 'quiet',
            hitTokens: 0,
            messageFingerprint: fingerprint({
                origin: 'quiet',
                messages: [{ hash: 91, tokens: 5000 }],
            }),
        });
        ledger.add(quiet);
        expect(quiet.sharedPrefixTokens).toBeNull();

        const next = record('r3', 'chat-1', {
            hitTokens: 0,
            messageFingerprint: fingerprintWithExtraMessage(),
        });
        ledger.add(next);
        expect(next.sharedPrefixTokens).toBe(2100);
        expect(next.possiblePrefixBreaker).toBe(true);
    });

    it('flags at exactly 2048 shared tokens and not at 2047', () => {
        const { ledger } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1', {
            messageFingerprint: fingerprint({
                messages: [{ hash: 11, tokens: 1500 }, { hash: 22, tokens: 548 }],
            }),
        }));

        const exactly = record('r2', 'chat-1', {
            hitTokens: 0,
            messageFingerprint: fingerprint({
                messages: [
                    { hash: 11, tokens: 1500 },
                    { hash: 22, tokens: 548 },
                    { hash: 33, tokens: 100 },
                ],
            }),
        });
        ledger.add(exactly);
        expect(exactly.sharedPrefixTokens).toBe(2048);
        expect(exactly.possiblePrefixBreaker).toBe(true);

        ledger.add(record('r3', 'chat-1', {
            messageFingerprint: fingerprint({
                messages: [{ hash: 11, tokens: 1500 }, { hash: 22, tokens: 547 }],
            }),
        }));
        const below = record('r4', 'chat-1', {
            hitTokens: 0,
            messageFingerprint: fingerprint({
                messages: [
                    { hash: 11, tokens: 1500 },
                    { hash: 22, tokens: 547 },
                    { hash: 33, tokens: 100 },
                ],
            }),
        });
        ledger.add(below);
        expect(below.sharedPrefixTokens).toBe(2047);
        expect(below.possiblePrefixBreaker).toBe(false);
    });

    it('replaces the baseline on a provider change so the next same-provider row compares', () => {
        const { ledger } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1', { messageFingerprint: fingerprint() }));

        const changed = record('r2', 'chat-1', {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3',
            hitTokens: 0,
            messageFingerprint: fingerprint({ provider: 'openrouter', model: 'deepseek/deepseek-v3' }),
        });
        ledger.add(changed);
        expect(changed.sharedPrefixTokens).toBeNull();
        expect(changed.possiblePrefixBreaker).toBe(false);

        const next = record('r3', 'chat-1', {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3',
            messageFingerprint: fingerprintWithExtraMessage({
                provider: 'openrouter',
                model: 'deepseek/deepseek-v3',
            }),
        });
        ledger.add(next);
        expect(next.sharedPrefixTokens).toBe(2100);
    });

    it('strips text that reached the ledger inside a fingerprint', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1', {
            messageFingerprint: {
                provider: 'deepseek',
                model: 'deepseek-v4-flash',
                origin: 'story',
                messages: [{ hash: 11, tokens: 1500, content: 'SECRET PROMPT TEXT' }],
            },
        }));
        ledger.flush();

        expect(JSON.stringify(env.metadata[USAGE_CHAT_METADATA_KEY])).not.toContain('SECRET PROMPT TEXT');
        expect(ledger.recordsFor('chat-1')[0]).not.toHaveProperty('messageFingerprint');
        expect(Object.values(env.metadata[USAGE_CHAT_METADATA_KEY].promptFingerprints)).toEqual([{
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            origin: 'story',
            messages: [{ hash: 11, tokens: 1500 }],
        }]);
    });
});

describe('usage ledger — reset', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('resets the current chat only, clearing its state, namespace, pending copy and bucket', () => {
        const { ledger, env, save } = harness();
        ledger.loadChat('chat-1');
        ledger.startRun('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.add(record('r2', 'chat-2'));

        expect(ledger.recordsFor('chat-1')).toHaveLength(1);
        expect(env.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(1);
        expect(ledger.allTimeForView().chats).toBe(2);

        ledger.resetChat('chat-1');

        expect(ledger.recordsFor('chat-1')).toEqual([]);
        expect(ledger.runsFor('chat-1')).toEqual([]);
        expect(ledger.currentRunIdFor('chat-1')).toBeNull();
        expect(ledger.retentionFor('chat-1')).toMatchObject({ retained: 0, total: 0 });
        expect(ledger.archivedFor('chat-1').total.requests).toBe(0);
        expect(env.metadata[USAGE_CHAT_METADATA_KEY]).toBeUndefined();
        expect(save).toHaveBeenCalled();

        // The other chat keeps its rows and its all-time contribution.
        expect(ledger.recordsFor('chat-2')).toHaveLength(1);
        expect(ledger.allTimeForView().totals.requests).toBe(1);
        expect(ledger.allTimeForView().chats).toBe(1);
        expect(env.storage.readAllTime().chats['chat-1']).toBeUndefined();
        expect(env.storage.readAllTime().chats['chat-2']).toBeTruthy();
        // The pending copy becomes an empty reset tombstone, not a stale row.
        const pendingAfterReset = JSON.parse(
            env.storage.read(USAGE_PENDING_STORAGE_KEY) ?? '{"chats":{}}',
        ).chats['chat-1'];
        expect(pendingAfterReset.records).toEqual([]);
        expect(pendingAfterReset.runs).toEqual([]);

        // A queued save cannot resurrect the chat after the reset.
        vi.advanceTimersByTime(5000);
        expect(env.metadata[USAGE_CHAT_METADATA_KEY]).toBeUndefined();
        expect(ledger.recordsFor('chat-1')).toEqual([]);
        expect(env.storage.readAllTime().chats['chat-1']).toBeUndefined();
    });

    it('drops the prefix baseline so the next request cannot compare with a reset row', () => {
        const fingerprint = (messages) => ({
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            origin: 'story',
            messages,
        });
        const { ledger } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1', {
            messageFingerprint: fingerprint([{ hash: 11, tokens: 1500 }, { hash: 22, tokens: 600 }]),
        }));

        ledger.resetChat('chat-1');

        const next = record('r2', 'chat-1', {
            hitTokens: 0,
            messageFingerprint: fingerprint([
                { hash: 11, tokens: 1500 },
                { hash: 22, tokens: 600 },
                { hash: 33, tokens: 300 },
            ]),
        });
        ledger.add(next);

        expect(next.sharedPrefixTokens).toBeNull();
        expect(next.possiblePrefixBreaker).toBe(false);
    });

    it('resets all-time totals without touching any chat rows or namespace', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.flush();

        ledger.resetAllTime();

        expect(ledger.allTimeForView().totals.requests).toBe(0);
        expect(ledger.allTimeForView().chats).toBe(0);
        expect(env.storage.readAllTime().totals.requests).toBe(0);
        expect(ledger.recordsFor('chat-1')).toHaveLength(1);
        expect(env.metadata[USAGE_CHAT_METADATA_KEY].records).toHaveLength(1);
    });

    it('exposes the all-time buckets so an export can carry them', () => {
        const { ledger } = harness();
        ledger.add(record('r1', 'chat-1'));
        ledger.add(record('r2', 'chat-1'));
        ledger.add(record('r3', 'chat-2'));

        const allTime = ledger.allTimeForExport();

        expect(allTime.totals.requests).toBe(3);
        expect(allTime.buckets['chat-1'].requests).toBe(2);
        expect(allTime.buckets['chat-2'].requests).toBe(1);
    });

    it('returns one normalized snapshot with records, runs, aggregates and buckets', () => {
        const { ledger } = harness();
        ledger.loadChat('chat-1');
        ledger.startRun('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.add(record('r2', 'chat-2'));

        const snapshot = ledger.exportSnapshotFor('chat-1');

        expect(snapshot.records.map((entry) => entry.recordId)).toEqual(['r1']);
        expect(snapshot.runs).toHaveLength(1);
        expect(snapshot.currentRunId).toBe(ledger.currentRunIdFor('chat-1'));
        expect(snapshot.archived.total.requests).toBe(0);
        expect(snapshot.retention).toMatchObject({ limit: USAGE_RECORD_LIMIT, retained: 1, total: 1 });
        expect(snapshot.allTime.buckets['chat-1'].requests).toBe(1);
        expect(snapshot.allTime.buckets['chat-2'].requests).toBe(1);
    });

    it('leaves an empty chat as a no-op and keeps the other bucket', () => {
        const { ledger } = harness();
        ledger.add(record('r1', 'chat-2'));

        ledger.resetChat('chat-1');

        expect(ledger.recordsFor('chat-1')).toEqual([]);
        expect(ledger.allTimeForView().totals.requests).toBe(1);
        expect(ledger.allTimeForView().chats).toBe(1);
    });

    it('keeps the tombstone through two resets so a failed save still cannot restore the rows', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.flush();
        const staleNamespace = JSON.parse(JSON.stringify(env.metadata[USAGE_CHAT_METADATA_KEY]));

        // Both saves fail, so only the pending tombstone carries the reset.
        ledger.resetChat('chat-1');
        ledger.resetChat('chat-1');

        env.metadata = { [USAGE_CHAT_METADATA_KEY]: staleNamespace };
        const restored = reload(env);

        expect(restored.recordsFor('chat-1')).toEqual([]);
        expect(restored.allTimeForView().totals.requests).toBe(0);
    });

    it('replays a reset tombstone so a failed metadata save cannot restore the rows', () => {
        const { ledger, env } = harness();
        ledger.loadChat('chat-1');
        ledger.add(record('r1', 'chat-1'));
        ledger.flush();
        // The chat file still carries this namespace when the reset's save
        // silently fails, which is what SillyTavern's saveMetadata can do.
        const staleNamespace = JSON.parse(JSON.stringify(env.metadata[USAGE_CHAT_METADATA_KEY]));

        ledger.resetChat('chat-1');
        expect(ledger.allTimeForView().totals.requests).toBe(0);

        env.metadata = { [USAGE_CHAT_METADATA_KEY]: staleNamespace };
        const restored = reload(env);

        expect(restored.recordsFor('chat-1')).toEqual([]);
        expect(restored.allTimeForView().totals.requests).toBe(0);
        expect(env.metadata[USAGE_CHAT_METADATA_KEY].records).toEqual([]);
    });
});
