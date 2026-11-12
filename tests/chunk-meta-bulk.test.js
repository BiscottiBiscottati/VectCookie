/**
 * Tests: bulk chunk-metadata writes (core/chunk-meta-bulk.js).
 *
 * Behaviour at the seam: the caller passes the chunks it just inserted plus the
 * three injected collaborators, and the test observes what was written where and
 * whether the current-collection pointer was dropped. No backend, no globals.
 */

import { describe, it, expect, vi } from 'vitest';
import { persistBulkChunkKeywords } from '../core/chunk-meta-bulk.js';

const chunks = [
    { hash: 1, keywords: [{ text: 'dragon', weight: 1.5 }] },
    { hash: 2, keywords: [] },
    { hash: 3 },
    { hash: 4, keywords: [{ text: 'lantern', weight: 2 }] },
];

function deps(overrides = {}) {
    const saveChunkMetadata = vi.fn();
    const clearActiveCollection = vi.fn();
    return {
        isPayloadStore: vi.fn(() => true),
        clearActiveCollection,
        saveChunkMetadata,
        ...overrides,
    };
}

describe('bulk keyword persistence — payload path', () => {
    it('writes nothing to settings and mints no key per inserted chunk', () => {
        const d = deps();

        const result = persistBulkChunkKeywords(chunks, d);

        expect(d.saveChunkMetadata).not.toHaveBeenCalled();
        expect(result).toEqual({ skipped: true, saved: 0 });
    });

    it('still drops the current-collection pointer (a bulk write is not an edit)', () => {
        const d = deps();

        persistBulkChunkKeywords(chunks, d);

        expect(d.clearActiveCollection).toHaveBeenCalledTimes(1);
    });
});

describe('bulk keyword persistence — settings path', () => {
    it('persists the chunks that have keywords, and only those', () => {
        const d = deps({ isPayloadStore: vi.fn(() => false) });

        const result = persistBulkChunkKeywords(chunks, d);

        expect(d.clearActiveCollection).toHaveBeenCalledTimes(1);
        expect(d.saveChunkMetadata.mock.calls).toEqual([
            ['1', { keywords: [{ text: 'dragon', weight: 1.5 }] }],
            ['4', { keywords: [{ text: 'lantern', weight: 2 }] }],
        ]);
        expect(result).toEqual({ skipped: false, saved: 2 });
    });

    it('treats a missing or empty batch as a no-op', () => {
        const d = deps({ isPayloadStore: vi.fn(() => false) });

        expect(persistBulkChunkKeywords([], d)).toEqual({ skipped: false, saved: 0 });
        expect(persistBulkChunkKeywords(null, d)).toEqual({ skipped: false, saved: 0 });
        expect(d.saveChunkMetadata).not.toHaveBeenCalled();
    });
});
