/**
 * ============================================================================
 * VECTFOX CHUNK METADATA FIELDS
 * ============================================================================
 * One definition of what a chunk-metadata field is, of when a field holds a
 * value, and of which part of a listing item is the chunk hash. Two modules
 * read the same payload shape and must agree:
 *
 *   - core/chunk-meta-store.js   strips payload data keys and merges reads
 *   - core/chunk-meta-sweep.js   compares a settings entry with a payload to
 *                                decide redundant / needs-patching
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
    const fields = chunkMetadataFromPayload(metadata);
    for (const field of clientOnlyFields) delete fields[field];
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
