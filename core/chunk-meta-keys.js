/**
 * ============================================================================
 * VECTFOX LEGACY CHUNK-METADATA SETTINGS KEYS
 * ============================================================================
 * One definition of the settings namespace that holds per-chunk metadata:
 * `extension_settings.vectfox["vectfox_chunk_meta_<hash>"]`.
 *
 * The keys are the legacy store of ADR-0003 — still the only store for installs
 * without the Similharity plugin, and the redundant copy that the sweep removes
 * on installs with it. A real library accumulated 17,104 of them (9.45 MiB), so
 * more than one module needs to recognise them by name:
 *
 * Only the key shape lives here. The values — the metadata itself — are read,
 * written and normalized by core/collection-metadata.js, which re-exports the
 * public functions other modules call.
 *
 *   - core/collection-metadata.js reads and writes them (the legacy store)
 *   - core/storage-health.js counts and sizes them for the Size Inspector
 *
 * Kept dependency-free on purpose: the Size Inspector's measurement must be
 * importable without the SillyTavern host modules, or it could not be tested
 * against a plain settings object.
 * ============================================================================
 */

/** Settings key prefix for legacy per-chunk metadata. */
export const LEGACY_CHUNK_META_PREFIX = 'vectfox_chunk_meta_';

/**
 * Settings key that holds one chunk's metadata.
 * @param {string|number} hash Chunk hash
 * @returns {string}
 */
export function chunkMetaSettingsKey(hash) {
    return `${LEGACY_CHUNK_META_PREFIX}${hash}`;
}

/**
 * Whether a settings key belongs to the legacy chunk-metadata namespace.
 * @param {string} key
 * @returns {boolean}
 */
export function isChunkMetaSettingsKey(key) {
    return typeof key === 'string' && key.startsWith(LEGACY_CHUNK_META_PREFIX);
}

/**
 * The chunk hash held by a legacy settings key, or null for any other key.
 * @param {string} key
 * @returns {string|null}
 */
export function chunkHashFromSettingsKey(key) {
    return isChunkMetaSettingsKey(key) ? key.slice(LEGACY_CHUNK_META_PREFIX.length) : null;
}
