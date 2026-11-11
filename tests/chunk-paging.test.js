/**
 * Chunk listing pagination — the rule hydration and the sweep scan share.
 *
 * The safety property that matters: a listing is reported complete only when it
 * provably reached the backend's reported total. An unseen chunk hash is later
 * treated as an orphan, so a truncated listing must never look complete; but a
 * duplicate hash or a hashless item must not make a complete listing look
 * truncated either (which would block deletion forever).
 *
 * Seam: `listAllChunkItems(listChunks, collection, { pageSize })`.
 */

import { describe, it, expect, vi } from 'vitest';

import { listAllChunkItems } from '../core/chunk-paging.js';

/** A paging backend over fixed chunks, with optional backend behaviours. */
function backend(chunks, { total = false, ignoreOffset = false, pageCap = null } = {}) {
    const calls = [];
    const listChunks = vi.fn(async (_collection, { offset = 0, limit = 100 } = {}) => {
        calls.push({ offset, limit });
        const limitApplied = pageCap === null ? limit : Math.min(limit, pageCap);
        const rows = ignoreOffset ? chunks.slice(0, limitApplied) : chunks.slice(offset, offset + limitApplied);
        const page = {
            items: rows.map(([hash, metadata = {}]) => ({ hash, metadata })),
        };
        if (total) {
            page.total = chunks.length;
            page.hasMore = ignoreOffset ? true : offset + limitApplied < chunks.length;
        }
        return page;
    });
    return { listChunks, calls };
}

const CHUNKS = [['h1'], ['h2'], ['h3'], ['h4'], ['h5']];

describe('chunk listing pagination — reaching the end', () => {
    it('walks pages by the reported total even when the server caps the page size', async () => {
        const { listChunks, calls } = backend(CHUNKS, { total: true, pageCap: 2 });

        const result = await listAllChunkItems(listChunks, 'A', { pageSize: 5 });

        expect(calls.map(call => call.offset)).toEqual([0, 2, 4]);
        expect(result.items).toHaveLength(5);
        expect(result.complete).toBe(true);
        expect(result.total).toBe(5);
    });

    it('stops on a short page when the backend reports no total', async () => {
        const { listChunks, calls } = backend(CHUNKS.slice(0, 2));

        const result = await listAllChunkItems(listChunks, 'A', { pageSize: 10 });

        expect(calls).toHaveLength(1);
        expect(result.complete).toBe(true);
    });

    it('reports an empty collection as complete', async () => {
        const { listChunks } = backend([], { total: true });

        const result = await listAllChunkItems(listChunks, 'A', { pageSize: 10 });

        expect(result.items).toEqual([]);
        expect(result.complete).toBe(true);
        expect(result.total).toBe(0);
    });
});

describe('chunk listing pagination — refusing a truncated listing', () => {
    it('does not call a listing complete when the backend ignores offset before its total', async () => {
        const { listChunks } = backend(CHUNKS, { total: true, ignoreOffset: true, pageCap: 2 });

        const result = await listAllChunkItems(listChunks, 'A', { pageSize: 5 });

        expect(result.items).toHaveLength(2);
        expect(result.complete).toBe(false);
    });

    it('does not call a listing complete when an empty page arrives before the total', async () => {
        const listChunks = vi.fn(async () => ({ items: [], total: 5 }));

        const result = await listAllChunkItems(listChunks, 'A', { pageSize: 5 });

        expect(result.complete).toBe(false);
    });
});

describe('chunk listing pagination — item identity does not affect completeness', () => {
    it('stays complete when the backend returns the same hash on two pages', async () => {
        // The total counts items; deduplication is the caller's concern.
        const pages = [
            [{ hash: 'h1' }, { hash: 'h2' }],
            [{ hash: 'h2' }, { hash: 'h3' }],
        ];
        let call = 0;
        const listChunks = vi.fn(async () => {
            const items = pages[call] || [];
            call += 1;
            return { items, total: 4, hasMore: call < pages.length };
        });

        const result = await listAllChunkItems(listChunks, 'A', { pageSize: 2 });

        expect(result.items.map(item => item.hash)).toEqual(['h1', 'h2', 'h3']);
        expect(result.complete).toBe(true);
    });

    it('stays complete when an item has no hash', async () => {
        const pages = [
            [{ hash: 'h1' }, { metadata: {} }],
            [{ hash: 'h2' }, { hash: 'h3' }],
        ];
        let call = 0;
        const listChunks = vi.fn(async () => {
            const items = pages[call] || [];
            call += 1;
            return { items, total: 4, hasMore: call < pages.length };
        });

        const result = await listAllChunkItems(listChunks, 'A', { pageSize: 2 });

        expect(result.items.map(item => item.hash)).toEqual(['h1', 'h2', 'h3']);
        expect(result.complete).toBe(true);
    });

    it('requires a listing function', async () => {
        await expect(listAllChunkItems(undefined, 'A')).rejects.toThrow(TypeError);
    });
});
