/**
 * ============================================================================
 * VECTFOX BULK CHUNK-METADATA WRITES
 * ============================================================================
 * The keyword save that follows a bulk insert (chat, document, lorebook), with
 * the store policy in one testable place instead of open-coded after the insert.
 *
 * Two rules live here:
 *
 *   - A bulk write is never a collection edit, so it clears the store's
 *     "current collection" pointer first (ADR-0003 decision 8). Without that, a
 *     hash-only write from another path could borrow the collection a visualizer
 *     happens to have open.
 *   - On the payload path there is nothing to persist: the insert already wrote
 *     each chunk's keywords into its payload, and one settings key per inserted
 *     chunk is exactly what grew the settings object to 17,104 entries. Without
 *     the plugin the same call keeps writing settings, byte-identical to before.
 *
 * Host-free: the policy, the pointer clear and the save are injected, so the
 * decision is unit-testable with no backend and no SillyTavern globals.
 * ============================================================================
 */

/**
 * @param {Iterable<{ hash: string|number, keywords?: unknown[] }>} chunks
 *   The chunks just inserted.
 * @param {object} deps Required, not defaulted: a caller that forgets one would
 *   otherwise report a successful no-op. Every dependency is a one-line closure
 *   at the call site.
 * @param {() => boolean} deps.isPayloadStore Whether chunk metadata lives in the
 *   chunk payload for this install.
 * @param {() => void} deps.clearActiveCollection Drops the current-collection
 *   pointer before this bulk write.
 * @param {(hash: string, metadata: object) => void} deps.saveChunkMetadata
 *   The settings write used when the payload is not the store.
 * @returns {{ skipped: boolean, saved: number }} Whether the settings write was
 *   skipped, and how many chunks were persisted when it was not.
 */
export function persistBulkChunkKeywords(chunks, {
    isPayloadStore,
    clearActiveCollection,
    saveChunkMetadata,
}) {
    // Always first: this is a bulk write, not an edit scoped to an open collection.
    clearActiveCollection();

    if (isPayloadStore()) {
        return { skipped: true, saved: 0 };
    }

    let saved = 0;
    for (const chunk of chunks || []) {
        if (!(chunk?.keywords?.length > 0)) continue;
        saveChunkMetadata(String(chunk.hash), { keywords: chunk.keywords });
        saved += 1;
    }
    return { skipped: false, saved };
}
