/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA TRANSFER (export / import parity)
 * ============================================================================
 * The two decisions a collection file makes about per-chunk metadata, in one
 * host-free place so both directions of the round trip agree:
 *
 *   - Export reads each chunk's metadata from the collection being exported:
 *     the payload metadata its own listing already returned, with the legacy
 *     settings entry filling the fields the payload lacks. It never asks the
 *     store's hash-only read, because that resolves through whatever collection
 *     happens to be open and the same content hash can live in several
 *     collections (ADR-0003 decision 8).
 *   - Import writes the metadata to the best store this install has: the insert
 *     carries it into the payload on the payload path, and settings is written
 *     directly otherwise. Client-only fields (`summaries`) have no payload
 *     representation and always go to settings, so a payload-path import mints
 *     a settings entry only for the chunks that actually carry one.
 *
 * Settings entries the exported collection no longer contains are not silently
 * dropped: their count goes into the file's report, and the hashes go to the
 * caller so the export can name them in a warning. Only the count is persisted:
 * the settings namespace is global, so those hashes usually belong to other
 * collections, and an export file (including the shareable PNG form) must not
 * carry another collection's content hashes. Even the count is not a claim of
 * orphanhood — only the Size Inspector's dry run can prove a hash exists in no
 * registered collection.
 *
 * Pure: no DOM, no settings, no requests, no logging. Callers own the stores and
 * the reporting.
 * ============================================================================
 */

import {
    chunkHashOf,
    chunkMetadataFromPayload,
    hasValue,
    mergeChunkMetadata,
    splitForPayload,
} from './chunk-meta-fields.js';

/** Whether a metadata object holds any field at all. */
function hasAnyField(metadata) {
    return Boolean(metadata) && Object.keys(metadata).length > 0;
}

/**
 * The fields of a resolved metadata view worth writing to an export file. The
 * export listing hands every chunk a `keywords: []` (fetchPortableChunks fills
 * the default), but an empty array is an absence by the same contract reads
 * use — carrying it would put a `chunkMeta` on every chunk in the file. Falsy
 * values that mean something (`false`, `0`) survive.
 * @param {object|null|undefined} metadata
 * @returns {object|null}
 */
function carriedFields(metadata) {
    if (!metadata) return null;
    const fields = {};
    for (const [field, value] of Object.entries(metadata)) {
        if (hasValue(value)) fields[field] = value;
    }
    return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * Attaches each collection chunk's metadata to the portable export shape, read
 * per field from the payload metadata the listing returned and from the legacy
 * settings entries. A chunk with no metadata in either store keeps no
 * `chunkMeta` key — and neither does one whose only fields are empty values,
 * because an empty field is an absence, not an edit.
 *
 * The payload metadata is already part of each chunk's `metadata` in the export
 * file; `chunkMeta` is the resolved view the import restores, which is why the
 * round trip is stable even for a field only one store held.
 *
 * @param {object} input
 * @param {Array<{ hash: string|number, metadata?: object }>} [input.chunks]
 *     Portable chunks as the export fetched them.
 * @param {Object<string, object>} [input.legacyEntries] Hash -> settings entry.
 * @returns {{
 *   chunks: Array<object>,
 *   report: {
 *     chunks: number,
 *     attached: number,
 *     unmatchedSettingsEntries: { count: number },
 *   },
 *   unmatchedSettingsHashes: string[],
 * }}
 *     `report` is what the file carries (the count, never the hashes);
 *     `unmatchedSettingsHashes` is for the caller's warning.
 */
export function attachCollectionChunkMetadata({ chunks = [], legacyEntries = {} } = {}) {
    const collectionHashes = new Set();
    const attachedChunks = [];
    let attached = 0;

    for (const chunk of chunks) {
        const hash = chunkHashOf(chunk);
        if (hash !== null) collectionHashes.add(hash);
        const payload = chunkMetadataFromPayload(chunk?.metadata);
        const legacy = hash === null ? null : legacyEntries?.[hash] || null;
        const merged = carriedFields(mergeChunkMetadata(payload, legacy));
        if (!merged) {
            attachedChunks.push(chunk);
            continue;
        }
        attachedChunks.push({ ...chunk, chunkMeta: merged });
        attached += 1;
    }

    const unmatchedSettingsHashes = [];
    for (const hash of Object.keys(legacyEntries || {})) {
        if (!collectionHashes.has(String(hash))) unmatchedSettingsHashes.push(String(hash));
    }

    return {
        chunks: attachedChunks,
        report: {
            chunks: chunks.length,
            attached,
            // Entries this collection has no chunk for. The count is reported
            // rather than dropped; the hash list stays out of the file (it is
            // usually other collections' content) and goes to the warning.
            unmatchedSettingsEntries: {
                count: unmatchedSettingsHashes.length,
            },
        },
        unmatchedSettingsHashes,
    };
}

/**
 * Decides where each imported chunk's metadata is written.
 *
 * On the payload path the file's payload fields are merged into the metadata the
 * insert already sends, so the collection write is the insert itself and no
 * settings copy is minted — the growth this feature exists to stop. Client-only
 * fields still go to settings, and on a no-plugin install every field does,
 * byte-identical to the pre-store import. The split between the two halves is
 * splitForPayload's single definition (ticket 07), which also means bookkeeping
 * (`updatedAt`) travels with the payload fields rather than being dropped.
 *
 * @param {object} input
 * @param {Array<{ metadata?: object, chunkMeta?: object }>} [input.chunks]
 *     The import's validated chunks, in file order.
 * @param {boolean} [input.isPayloadStore] Whether the chunk payload is this
 *     install's metadata store.
 * @param {Iterable<string>} [input.clientOnlyFields] Fields the payload can
 *     never carry (see CLIENT_ONLY_CHUNK_FIELDS in core/collection-metadata.js).
 * @returns {{
 *   entries: Array<{ metadata: object, settings: object|null }>,
 *   counts: { payloadChunks: number, settingsChunks: number },
 * }}
 */
export function planChunkMetaImport({ chunks = [], isPayloadStore = false, clientOnlyFields = [] } = {}) {
    const entries = [];
    let payloadChunks = 0;
    let settingsChunks = 0;

    for (const chunk of chunks) {
        const chunkMeta = chunk?.chunkMeta;
        if (!isPayloadStore) {
            // No payload to write to: settings is the store, exactly as before.
            const settings = hasAnyField(chunkMeta) ? chunkMeta : null;
            entries.push({ metadata: { ...(chunk?.metadata || {}) }, settings });
            if (settings) settingsChunks += 1;
            continue;
        }

        const { payload, clientOnly } = splitForPayload(chunkMeta, clientOnlyFields);
        const settings = hasAnyField(clientOnly) ? clientOnly : null;
        entries.push({
            metadata: { ...(chunk?.metadata || {}), ...(payload || {}) },
            settings,
        });
        if (payload) payloadChunks += 1;
        if (settings) settingsChunks += 1;
    }

    return { entries, counts: { payloadChunks, settingsChunks } };
}
