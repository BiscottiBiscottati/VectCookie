import { describe, it, expect, beforeEach, vi } from 'vitest';

// InlineSummary keeps its payload either inline on the message or, in the ILS
// fork, behind a ref in chat_metadata. The ref table lives on the ST host's
// chat_metadata, so stub the host module the way the other ILS-adjacent tests do.
vi.mock('../../../../../script.js', () => ({ chat_metadata: {} }));
vi.mock('../core/log.js', () => ({
    log: { warn() {}, verbose() {}, lifecycle() {}, domain() {}, error() {}, trace() {}, enabled: () => false },
}));

import { chat_metadata } from '../../../../../script.js';
import { expandILSMessages } from '../core/ils-expander.js';

/** A plain chat message. */
const msg = (text) => ({ mes: text });

/** An InlineSummary message carrying its originals inline (legacy format). */
const summary = (originals, text = 'summary') => ({
    mes: text,
    extra: { ILS_Data: { OriginalMessages: originals } },
});

/** An InlineSummary message whose originals live in chat_metadata (ILS fork format). */
const refSummary = (ref, text = 'summary') => ({
    mes: text,
    extra: { ILS_Data: { Ref: ref } },
});

/** Message texts of an expansion result, for order-sensitive assertions. */
const texts = (result) => result.expanded.map((m) => m.mes);

beforeEach(() => {
    delete chat_metadata.ILS_Originals;
});

describe('expandILSMessages — chats with no InlineSummary', () => {
    it('passes ordinary messages through in order', () => {
        const result = expandILSMessages([msg('a'), msg('b'), msg('c')]);

        expect(texts(result)).toEqual(['a', 'b', 'c']);
        expect(result.stats).toEqual({ summariesFound: 0, originalsRecovered: 0, maxDepth: 0 });
    });

    it('leaves the input array itself untouched when nothing is expanded', () => {
        const input = [msg('a'), msg('b')];

        expandILSMessages(input);

        expect(input).toEqual([msg('a'), msg('b')]);
    });
});

describe('expandILSMessages — empty input', () => {
    it('returns the input as-is with zeroed stats for null, undefined and empty arrays', () => {
        for (const input of [null, undefined, []]) {
            const result = expandILSMessages(input);

            expect(result.expanded).toBe(input);
            expect(result.stats).toEqual({ summariesFound: 0, originalsRecovered: 0, maxDepth: 0 });
        }
    });
});

describe('expandILSMessages — inline (legacy) storage', () => {
    it('replaces a summary with its originals, keeping surrounding messages in place', () => {
        const result = expandILSMessages([
            msg('before'),
            summary([msg('x'), msg('y')]),
            msg('after'),
        ]);

        expect(texts(result)).toEqual(['before', 'x', 'y', 'after']);
        expect(result.stats).toMatchObject({ summariesFound: 1, originalsRecovered: 2 });
    });

    it('skips originals that carry no text', () => {
        const result = expandILSMessages([
            summary([msg('kept'), { mes: '' }, null, undefined]),
        ]);

        expect(texts(result)).toEqual(['kept']);
        expect(result.stats.originalsRecovered).toBe(1);
    });

    it('does not mutate the input messages or the originals it copies out of them', () => {
        const original = msg('x');
        const input = [summary([original])];

        expandILSMessages(input);

        expect(input).toEqual([summary([msg('x')])]);
        expect(original).toEqual(msg('x'));
    });
});

describe('expandILSMessages — ref storage (ILS fork)', () => {
    it('resolves originals through chat_metadata', () => {
        chat_metadata.ILS_Originals = { r1: [msg('p'), msg('q')] };

        const result = expandILSMessages([refSummary('r1')]);

        expect(texts(result)).toEqual(['p', 'q']);
        expect(result.stats).toMatchObject({ summariesFound: 1, originalsRecovered: 2 });
    });

    it('keeps the summary text when the ref points at nothing', () => {
        chat_metadata.ILS_Originals = {};

        const result = expandILSMessages([refSummary('missing', 'the summary')]);

        expect(texts(result)).toEqual(['the summary']);
        expect(result.stats).toMatchObject({ summariesFound: 1, originalsRecovered: 0 });
    });
});

describe('expandILSMessages — alternate storage location', () => {
    it('recognizes ILS data stored directly on the message', () => {
        const result = expandILSMessages([
            { mes: 'summary', ILS_Data: { OriginalMessages: [msg('direct')] } },
        ]);

        expect(texts(result)).toEqual(['direct']);
        expect(result.stats.summariesFound).toBe(1);
    });
});

describe('expandILSMessages — nesting', () => {
    it('flattens a summary of summaries down to the leaf messages', () => {
        const result = expandILSMessages([
            summary([summary([msg('leaf-1'), msg('leaf-2')], 'inner'), msg('sibling')]),
        ]);

        expect(texts(result)).toEqual(['leaf-1', 'leaf-2', 'sibling']);
        expect(result.stats).toMatchObject({ summariesFound: 2, originalsRecovered: 3, maxDepth: 1 });
    });

    it('stops at the documented depth cap instead of expanding indefinitely', () => {
        // 70 nested summaries — deeper than the 64-layer cap.
        let nested = msg('leaf');
        for (let i = 0; i < 70; i++) nested = summary([nested], `s${i}`);

        const result = expandILSMessages([nested]);

        // Depth 0 is s69, so the layer that survives the cap at depth 64 is s5.
        expect(texts(result)).toEqual(['s5']);
        expect(result.stats.maxDepth).toBe(64);
    });

    it('terminates on a cyclic OriginalMessages chain', () => {
        const cyclic = { mes: 'cyclic' };
        cyclic.extra = { ILS_Data: { OriginalMessages: [cyclic] } };

        const result = expandILSMessages([cyclic]);

        expect(texts(result)).toEqual(['cyclic']);
        expect(result.stats.maxDepth).toBe(64);
    });
});
