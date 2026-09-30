import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted lifts these so that the (also-hoisted) vi.mock factories can reference them.
const mocks = vi.hoisted(() => ({
    setExtensionPrompt: vi.fn(),
    getChatUUID: vi.fn(() => 'uuid-1'),
    getVectorizationTip: vi.fn(),
    getWorldInfoSettings: vi.fn(() => ({})),
    getSortedEntries: vi.fn(async () => []),
    getContext: vi.fn(() => ({ chat: [], symbols: { ignore: Symbol('ignore') } })),
}));

vi.mock('../../../../../script.js', () => ({ setExtensionPrompt: mocks.setExtensionPrompt }));
// Host modules ST provides at runtime but that don't exist in the repo — stub the
// import graph the same way summarizer-injection.test.js does.
vi.mock('../../../../secrets.js', () => ({ SECRET_KEYS: {} }));
vi.mock('../../../../textgen-settings.js', () => ({ textgen_types: {}, textgenerationwebui_settings: {} }));
vi.mock('../../../../extensions.js', () => ({ getContext: mocks.getContext }));
vi.mock('../../../../world-info.js', () => ({
    getWorldInfoSettings: mocks.getWorldInfoSettings,
    getSortedEntries: mocks.getSortedEntries,
}));
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: vi.fn(async () => ({ listChunks: vi.fn(async () => []) })),
}));
vi.mock('../core/collection-ids.js', () => ({ getChatUUID: mocks.getChatUUID }));
vi.mock('../core/eventbase-store.js', () => ({
    resolveActiveEventBaseCollection: vi.fn(),
    getVectorizationTip: mocks.getVectorizationTip,
}));
vi.mock('../core/log.js', () => ({
    log: { warn() {}, error() {}, domain() {}, trace() {}, verbose() {}, lifecycle() {}, enabled: () => false },
}));
vi.mock('../core/constants.js', () => ({ EXTENSION_PROMPT_TAG: '3_vectfox' }));

import { applyGhosting } from '../core/summarizer-injection.js';

/** Build a prompt-array of n content-bearing messages. */
function makeChat(n) {
    return Array.from({ length: n }, (_, i) => ({ mes: `Message ${i}`, extra: {} }));
}

/**
 * Point getContext at a full chat of `n` non-system messages so applyGhosting's
 * index-space translation counts them as vectorized.
 */
function contextWith(n) {
    mocks.getContext.mockReturnValue({
        chat: makeChat(n),
        symbols: { ignore: Symbol('ignore') },
    });
}

describe('applyGhosting — batching regression (step = 1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', {});
        mocks.getWorldInfoSettings.mockReturnValue({});
    });

    it('keeps today\'s rolling boundary when step is 1', () => {
        const chat = makeChat(20);
        contextWith(20);
        mocks.getVectorizationTip.mockReturnValue(20);

        const settings = {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 1,
        };

        // keepFloor = max(10, 1, 0) = 10; cutoff = min(20, 20 - 10) = 10.
        const result = applyGhosting(chat, settings);

        expect(result.wiped).toBe(10);
        for (let i = 0; i < 10; i++) expect(chat[i].mes).toBe('');
        for (let i = 10; i < 20; i++) expect(chat[i].mes).toBe(`Message ${i}`);
    });

    it('falls back to rolling when step is missing or invalid', () => {
        for (const step of [0, -5, NaN, 'abc', undefined]) {
            const chat = makeChat(20);
            contextWith(20);
            mocks.getVectorizationTip.mockReturnValue(20);

            const result = applyGhosting(chat, {
                eventbase_ghost_enabled: true,
                summarizer_injection_enabled: true,
                eventbase_ghost_keep_recent: 10,
                eventbase_ghost_step: step,
            });

            expect(result.wiped, `step=${String(step)}`).toBe(10);
        }
    });
});

describe('applyGhosting — batched boundary (step > 1)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('window', {});
        mocks.getWorldInfoSettings.mockReturnValue({});
    });

    it('snaps the wipe boundary down and publishes the raw-window readout', () => {
        const chat = makeChat(25);
        contextWith(25);
        mocks.getVectorizationTip.mockReturnValue(25);

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(10);
        expect(chat.slice(0, 10).every(m => m.mes === '')).toBe(true);
        expect(chat.slice(10).every((m, i) => m.mes === `Message ${i + 10}`)).toBe(true);
        expect(window.VectFox_LastGhost).toMatchObject({ step: 10, cutoff: 10, rawKept: 15, nextJumpIn: 5 });
    });

    it('waits for the first full batch before wiping', () => {
        const chat = makeChat(19);
        contextWith(19);
        mocks.getVectorizationTip.mockReturnValue(19);

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(0);
        expect(chat.every((m, i) => m.mes === `Message ${i}`)).toBe(true);
        expect(window.VectFox_LastGhost).toMatchObject({ cutoff: 0, rawKept: 19, nextJumpIn: 1 });
    });

    it('never wipes beyond the vectorization tip or the recent keep floor', () => {
        const chat = makeChat(40);
        contextWith(40);
        mocks.getVectorizationTip.mockReturnValue(27);

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(20);
        expect(chat.slice(20, 27).every((m, i) => m.mes === `Message ${i + 20}`)).toBe(true);
        expect(chat.slice(30).every((m, i) => m.mes === `Message ${i + 30}`)).toBe(true);
    });

    it('does not wipe any messages needed by an uncapped World Info scan', () => {
        const chat = makeChat(30);
        contextWith(30);
        mocks.getVectorizationTip.mockReturnValue(30);
        mocks.getWorldInfoSettings.mockReturnValue({ world_info_min_activations: 1, world_info_min_activations_depth_max: 0 });

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(0);
        expect(window.VectFox_LastGhost.nextJumpIn).toBeNull();
    });

    it('never wipes the current turn, even when keep-recent is zero', () => {
        const chat = makeChat(25);
        contextWith(25);
        mocks.getVectorizationTip.mockReturnValue(25);

        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: true,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 0,
            eventbase_ghost_step: 10,
        });

        expect(result.wiped).toBe(20);
        expect(chat.at(-1).mes).toBe('Message 24');
    });

    it('leaves the input untouched when disabled', () => {
        const chat = makeChat(20);
        const original = chat.map(m => ({ ...m }));
        const result = applyGhosting(chat, {
            eventbase_ghost_enabled: false,
            summarizer_injection_enabled: true,
            eventbase_ghost_keep_recent: 10,
            eventbase_ghost_step: 10,
        });

        expect(result).toEqual({ wiped: 0, charsRemoved: 0 });
        expect(chat).toEqual(original);
    });
});
