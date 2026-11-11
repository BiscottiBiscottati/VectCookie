/**
 * ============================================================================
 * VECTFOX CHUNK LISTING PAGINATION
 * ============================================================================
 * Walks `/chunks/list` pages until the whole collection has been read. Two
 * callers depend on the same termination rules, so they live here once:
 *
 *   - core/chunk-meta-store.js   hydrating a collection's payload metadata
 *   - core/chunk-meta-sweep.js   scanning every registered collection for the
 *                                dry run and the sweep
 *
 * The backend reports `total` and `hasMore` alongside each page (the plugin
 * does), so the walk uses those when present and never treats a short page as
 * the end on its own — a server that caps the page size would otherwise
 * truncate the scan silently, and an unseen hash would later look like an
 * orphan. When neither field is present (older/native fallbacks) a short page
 * is the only end signal available.
 *
 * `complete` says whether the listing provably reached the end. A caller that is
 * about to delete data must refuse when it is false.
 *
 * Chunks without a hash are skipped (nothing can address them), and a hash seen
 * on an earlier page is only kept once.
 * ============================================================================
 */

import { chunkHashOf } from './chunk-meta-fields.js';

/**
 * @param {(collection: any, options: { offset: number, limit: number }) => Promise<{ items?: object[], total?: number, hasMore?: boolean }>} listChunks
 *     One page of one collection. The collection argument is passed through
 *     untouched, so callers can route by registry key or bare ID.
 * @param {any} collection What the caller's listChunks expects.
 * @param {object} [options]
 * @param {number} [options.pageSize] Requested page size.
 * @returns {Promise<{ items: object[], complete: boolean, total: number|null }>}
 *     Every chunk in the collection (deduplicated by hash), whether the whole
 *     collection was read, and the total the backend reported (or null).
 */
export async function listAllChunkItems(listChunks, collection, { pageSize = 500 } = {}) {
    if (typeof listChunks !== 'function') {
        throw new TypeError('listAllChunkItems requires a listChunks function');
    }
    const items = [];
    const seen = new Set();
    let reportedTotal = null;
    let complete = true;
    let offset = 0;

    for (;;) {
        const page = await listChunks(collection, { offset, limit: pageSize });
        const pageItems = Array.isArray(page?.items) ? page.items : [];
        if (typeof page?.total === 'number' && Number.isFinite(page.total)) {
            reportedTotal = page.total;
        }
        const hasMore = typeof page?.hasMore === 'boolean' ? page.hasMore : null;

        let added = 0;
        for (const item of pageItems) {
            const key = chunkHashOf(item);
            if (key === null) continue;
            if (seen.has(key)) continue;
            seen.add(key);
            items.push(item);
            added += 1;
        }

        // Position, not deduplicated size: a duplicate hash or a hashless item
        // must not make a complete listing look truncated.
        const reachedReportedTotal = reportedTotal !== null && offset + pageItems.length >= reportedTotal;
        // A short page is the end only when the backend gave us no other signal.
        const shortPageEnds = reportedTotal === null && hasMore === null && pageItems.length < pageSize;

        if (pageItems.length === 0) {
            // An empty page is the end unless the backend had already told us a
            // total it did not deliver.
            complete = reportedTotal === null || offset >= reportedTotal;
            break;
        }
        if (hasMore === false || reachedReportedTotal || shortPageEnds) break;
        if (added === 0) {
            // The backend ignored `offset` (the native hashes-only fallback
            // returns the whole list every time). Without a total there is no
            // proof of truncation; with one, the walk fell short.
            complete = reportedTotal === null;
            break;
        }
        offset += pageItems.length;
    }

    return { items, complete, total: reportedTotal };
}
