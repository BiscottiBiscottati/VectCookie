/**
 * ============================================================================
 * VECTFOX CHUNK METADATA FIELDS
 * ============================================================================
 * One definition of what a chunk-metadata field is, of when a field holds a
 * value, and of which part of a listing item is the chunk hash. Every module
 * that reads the same payload shape builds on these predicates:
 *
 *   - core/chunk-meta-store.js     strips payload data keys and merges reads
 *   - core/chunk-meta-transfer.js  resolves a collection's metadata for export
 *                                  and splits it for import
 *   - core/chunk-meta-sweep.js     compares a settings entry with a payload to
 *                                  decide redundant / needs-patching
 *
 * Dependency-free by construction (no SillyTavern host imports, no logging) so
 * the sweep planner can be tested as a pure function against plain objects, and
 * so a rule change lands in one place instead of drifting between the write
 * path and the migration planner (ADR-0003).
 * ============================================================================
 */

/** Payload keys that are chunk data, not chunk metadata; never treated as metadata. */
const PAYLOAD_DATA_KEYS = new Set(['hash', 'text', 'index', 'vector']);

/**
 * Bookkeeping keys that both stores write but that carry no user metadata. They
 * are not compared when deciding whether a payload lacks a field: timestamps
 * always differ between the two stores, and patching one across would be work
 * with no benefit.
 */
export const BOOKKEEPING_META_FIELDS = ['updatedAt'];

/**
 * Whether two stored field values are the same value. Metadata values are small
 * JSON structures (strings, numbers, arrays of keyword objects), so a
 * serialized comparison is enough; a value that cannot be serialized (a cycle)
 * is never treated as equal. Shared by the merge/prune paths so "the value did
 * not change" means one thing.
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameStoredValue(left, right) {
    if (left === right) return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch (_) {
        return false;
    }
}

/**
 * Identity of one chunk's metadata: one hash in one collection. The store's
 * in-memory maps and the durable retry records must agree on identity, so both
 * build it here rather than spelling the composite key twice.
 * @param {string} collectionId
 * @param {string|number} hash
 * @returns {string}
 */
export function chunkMetadataKey(collectionId, hash) {
    return `${collectionId}\u0000${hash}`;
}

/**
 * A chunk's hash, from whichever part of a listing item carries it, as the
 * string every store keys on. Null when the item has no hash (nothing can
 * address it).
 * @param {object|null|undefined} item A `/chunks/list` item.
 * @returns {string|null}
 */
export function chunkHashOf(item) {
    const hash = item?.hash ?? item?.metadata?.hash;
    return hash === undefined || hash === null ? null : String(hash);
}

/**
 * A collection's identity for scanning: its registry key (`backend:collectionId`)
 * when the registry form is known, its bare id otherwise. Registry key, not bare
 * id, because the same collection id can exist on two backends and two entries
 * must never be collapsed into one scan or one report row.
 * @param {{ registryKey?: string, collectionId?: string }|null|undefined} collection
 * @returns {string}
 */
export function collectionKeyOf(collection) {
    return String(collection?.registryKey || collection?.collectionId || '');
}

/**
 * A chunk's metadata, with payload data keys removed. Shared by hydration and
 * by the sweep scan so both see the same field set.
 * @param {object|null|undefined} rawMetadata Payload metadata as the backend returns it.
 * @returns {object} Metadata fields only.
 */
export function chunkMetadataFromPayload(rawMetadata) {
    const metadata = {};
    for (const [field, value] of Object.entries(rawMetadata || {})) {
        if (PAYLOAD_DATA_KEYS.has(field)) continue;
        metadata[field] = value;
    }
    return metadata;
}

/**
 * "Holds a value" for merge purposes. Empty strings, empty arrays and empty
 * objects are absences, not values — matching the read-source contract the
 * visualizer already applies (an explicitly blanked field falls back). `false`
 * and `0` are values.
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasValue(value) {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

/**
 * One chunk's metadata resolved per field: the payload wins where it holds a
 * value, the legacy settings entry fills the fields it lacks. A field neither
 * store holds is simply absent. Null means neither store has the chunk.
 *
 * The priority rule has exactly one definition (ADR-0003): the store's read
 * path and the export's collection-scoped read both call this, so "which store
 * wins" cannot drift between them. The sweep asks the other direction — which
 * fields a payload lacks (see missingPayloadFields) — and builds on the same
 * predicates rather than on this merge.
 * @param {object|null|undefined} payload Payload metadata, data keys already stripped.
 * @param {object|null|undefined} legacy Settings entry for the same chunk.
 * @returns {object|null} Merged metadata.
 */
export function mergeChunkMetadata(payload, legacy) {
    if (!payload) return legacy ? { ...legacy } : null;
    if (!legacy) return { ...payload };
    const merged = { ...legacy };
    for (const [field, value] of Object.entries(payload)) {
        if (hasValue(value) || !(field in merged)) merged[field] = value;
    }
    return merged;
}

/**
 * One save split into the part the payload stores and the part only settings can
 * hold. Both halves come from one walk, so a field is classified once and the
 * two stores can never disagree about which fields are theirs.
 * @param {object} metadata A save or a settings entry.
 * @param {Iterable<string>} clientOnlyFields Fields with no payload representation.
 * @returns {{ payload: object|null, clientOnly: object }} The payload fields
 *   (null when the save carries only client-only bookkeeping, so it produces no
 *   pointless payload request) and the client-only fields present in the save.
 */
export function splitForPayload(metadata, clientOnlyFields) {
    const exclusive = new Set(clientOnlyFields || []);
    const payload = {};
    const clientOnly = {};
    for (const [field, value] of Object.entries(metadata || {})) {
        if (exclusive.has(field)) clientOnly[field] = value;
        else if (!PAYLOAD_DATA_KEYS.has(field)) payload[field] = value;
    }
    const persistable = Object.keys(payload).some(
        field => !BOOKKEEPING_META_FIELDS.includes(field),
    );
    return { payload: persistable ? payload : null, clientOnly };
}

/**
 * Whether a settings entry holds a field the payload can never hold (for
 * example the dual-vector `summaries` list). Such an entry must be kept in
 * settings: deleting it would discard data no payload carries.
 * @param {object} metadata Settings entry.
 * @param {Iterable<string>} clientOnlyFields Fields with no payload representation.
 * @returns {boolean}
 */
export function carriesClientOnlyMetadata(metadata, clientOnlyFields) {
    for (const field of clientOnlyFields) {
        if (hasValue(metadata?.[field])) return true;
    }
    return false;
}

/**
 * The fields of a settings entry that a payload is expected to hold, with
 * client-only and bookkeeping fields removed. Payload data keys (`text`, `hash`)
 * are stripped as well: they belong to the chunk, never to a metadata patch.
 * @param {object} metadata Settings entry.
 * @param {Iterable<string>} clientOnlyFields Fields with no payload representation.
 * @returns {object}
 */
export function transferableMetadata(metadata, clientOnlyFields) {
    // The split itself stays splitForPayload's job (ticket 07); this asks the
    // same question and then drops the bookkeeping fields a patch never carries.
    const { payload } = splitForPayload(metadata, clientOnlyFields);
    const fields = { ...(payload || {}) };
    for (const field of BOOKKEEPING_META_FIELDS) delete fields[field];
    return fields;
}

/**
 * The fields a settings entry holds that its payload lacks. A field counts as
 * missing when the entry holds a value for it and the payload does not — the
 * same "holds a value" rule the read path uses.
 * @param {object} entry Settings entry.
 * @param {object|null|undefined} payloadMetadata The payload's metadata for the same chunk.
 * @param {Iterable<string>} clientOnlyFields Fields with no payload representation.
 * @returns {object} Missing fields, ready to be patched; empty when nothing is missing.
 */
export function missingPayloadFields(entry, payloadMetadata, clientOnlyFields) {
    const missing = {};
    const payload = payloadMetadata || {};
    for (const [field, value] of Object.entries(transferableMetadata(entry, clientOnlyFields))) {
        if (hasValue(value) && !hasValue(payload[field])) {
            missing[field] = value;
        }
    }
    return missing;
}
