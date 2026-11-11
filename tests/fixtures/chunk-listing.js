/**
 * Shared fake for the plugin's `/chunks/list` endpoint.
 *
 * Three test files page over the same shape — the paging tests for the helper,
 * the dry-run tests for the scan, and the Size Inspector tests for the rendered
 * report — so the fake lives here instead of being re-declared in each. It
 * records every request and exposes a patch spy, so a test can prove a read-only
 * path issued no writes.
 *
 * `chunksByCollection` is keyed by bare collection id or registry key. The fake
 * accepts either a collection object (as the planner receives) or a bare key
 * (as the transport receives).
 */

import { vi } from 'vitest';

export function createFakeChunkListing({
    chunksByCollection = {},
    failing = [],
    ignoreOffset = false,
    reportTotal = false,
    capLimit = null,
} = {}) {
    const calls = [];
    const patchCalls = [];

    const listChunks = vi.fn(async (collection, { offset = 0, limit = 100 } = {}) => {
        const id = typeof collection === 'string' ? collection : collection.collectionId;
        const registryKey = typeof collection === 'string'
            ? collection
            : (collection.registryKey || collection.collectionId);
        calls.push({ collectionId: id, registryKey, offset, limit });

        if (failing.includes(id) || failing.includes(registryKey)) {
            throw new Error(`collection ${id} is unreachable`);
        }

        const source = chunksByCollection[id] ?? chunksByCollection[registryKey] ?? {};
        const entries = Object.entries(source);
        const pageLimit = capLimit === null ? limit : Math.min(limit, capLimit);
        const page = ignoreOffset ? entries.slice(0, pageLimit) : entries.slice(offset, offset + pageLimit);

        const result = {
            items: page.map(([hash, metadata]) => ({
                hash,
                // Real listings also carry chunk data, which must be ignored.
                metadata: { ...metadata, hash, text: `text-${hash}` },
            })),
        };
        if (reportTotal) {
            result.total = entries.length;
            result.hasMore = ignoreOffset ? true : offset + pageLimit < entries.length;
        }
        return result;
    });

    const patchMetadata = vi.fn((...args) => {
        patchCalls.push(args);
    });

    return { listChunks, patchMetadata, calls, patchCalls };
}
