/**
 * VECTFOX Collection Metadata Manager
 *
 * Manages collection-level metadata in extension_settings.vectfox.collections
 * This is the "settings layer" - user preferences for collections.
 *
 * Separation of concerns:
 * - collection-loader.js = Discovery & loading (talks to vector backends)
 * - collection-metadata.js = Settings & state (talks to extension_settings)
 */

import { extension_settings, getContext } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { parseRegistryKey, COLLECTION_PREFIXES, parseCollectionId, sanitizeHandleId } from './collection-ids.js';
import { createChunkMetaStore } from './chunk-meta-store.js';
import {
    executeCollectionChunkMetaGc,
    planCollectionChunkMetaGc,
} from './chunk-meta-collection-gc.js';
import { chunkHashFromSettingsKey, chunkMetaSettingsKey } from './chunk-meta-keys.js';
import { sameStoredValue } from './chunk-meta-fields.js';
import { log } from './log.js';

// ============================================================================
// COLLECTION METADATA CRUD
// ============================================================================

/**
 * Default metadata for a new collection
 */
const defaultCollectionMeta = {
    enabled: true,
    autoSync: false,  // Per-collection auto-sync for chat vectorization
    // `null` (not the string 'unknown'). Truthy-string defaults break the
    // `storedMeta.scope || parsedMeta.scope` fall-through pattern used by
    // the collection loader (line ~1007) — with `'unknown'` as the default,
    // the OR short-circuits and the correctly-parsed scope from the ID
    // structure is ignored, leaving collections un-lockable via the UI.
    // Surfaced 2026-05-24 by a no-plugin user whose fallback-discovered
    // EventBase collection couldn't be activated — the checkbox flipped
    // visually but `saveActivation` had no branch for scope='unknown' and
    // silently wrote nothing. See Doc/collection_helper.md.
    scope: null,
    displayName: null,
    description: '',
    tags: [],
    color: null,
    createdAt: null,
    lastUsed: null,
    queryCount: 0,

    // =========================================================================
    // ACTIVATION TRIGGERS (PRIMARY METHOD - Like Lorebook)
    // =========================================================================
    // Simple keyword-based activation. If ANY trigger matches recent messages,
    // the collection activates. This is the primary, user-friendly method.
    //
    // Priority order:
    // 1. triggers[] not empty → Match keywords in recent messages
    // 2. conditions.enabled=true → Advanced rules (secondary method)
    // 3. No triggers + no conditions → Auto-activates
    triggers: [],                  // Array of trigger keywords (case-insensitive)
    triggerMatchMode: 'any',       // 'any' = OR logic, 'all' = AND logic
    triggerCaseSensitive: false,   // Case sensitivity for trigger matching
    triggerScanDepth: 5,           // How many recent messages to scan for triggers

    // =========================================================================
    // CONDITIONAL ACTIVATION (ADVANCED METHOD - Secondary)
    // =========================================================================
    // Complex rule-based activation. Only evaluated if triggers don't match
    // or if no triggers are set. Use for sophisticated activation logic.
    conditions: {
        enabled: false,
        logic: 'AND', // 'AND' = all rules must pass, 'OR' = any rule passes
        rules: [],    // Array of condition rules
    },

    // =========================================================================
    // PROMPT CONTEXT (Per-Collection)
    // =========================================================================
    // Wraps all chunks from this collection with context/guidance for the AI.
    // Supports {{user}} and {{char}} variables.
    // Example: "Things {{char}} remembers about {{user}}:"
    context: '',      // Natural language context shown before this collection's chunks
    xmlTag: '',       // XML tag to wrap this collection's chunks (e.g., "memories")
};

/**
 * ============================================================================
 * CONDITION TYPES
 * ============================================================================
 *
 * COLLECTION & CHUNK CONDITIONS (11 types):
 * Can be used at both collection-level and chunk-level.
 * Collection-level: Determines if a collection should be queried
 * Chunk-level: Determines if a specific chunk should be included
 *
 * - pattern:          Advanced regex/pattern matching (replaces keyword)
 * - speaker:          Match by who spoke last
 * - characterPresent: Check if specific character(s) spoke recently
 * - messageCount:     Conversation length pacing (eq, gte, lte, between)
 * - isGroupChat:      Group vs 1-on-1 chat
 * - generationType:   Normal, swipe, continue, regenerate, impersonate
 * - lorebookActive:   Specific lorebook entries are triggered
 * - swipeCount:       Number of swipes on last message
 * - timeOfDay:        Real-world time window (supports midnight crossing)
 * - randomChance:     Probabilistic activation (0-100%)
 *
 * CHUNK-ONLY FEATURES:
 * Only make sense at chunk-level, not collection-level.
 *
 * - chunkLinks:       Force/soft links to other chunks ({ targetHash, mode: 'force'|'soft' })
 *                     - hard: Target chunk MUST appear if source appears
 *                     - soft: Target chunk gets score boost if source appears
 *                     Each chunk defines its own links independently.
 *                     For two-way linking, add links on both chunks.
 * - scoreThreshold:   Per-chunk minimum similarity score override
 * - recency:          Filter by message age (messagesAgo)
 * - frequency:        Limit activations (maxActivations, cooldownMessages)
 *
 * See: conditional-activation.js for full implementation.
 * ============================================================================
 */

/**
 * Condition rule structure (for reference):
 * {
 *     type: 'keyword',           // Condition type
 *     negate: false,             // Invert the result
 *     settings: {                // Type-specific settings
 *         values: ['combat'],
 *         matchMode: 'contains', // contains, exact, startsWith, endsWith
 *         caseSensitive: false,
 *     }
 * }
 */

/**
 * Ensures the collections object exists in extension_settings
 */
function ensureCollectionsObject() {
    // VEC-26: Add proper null checks to prevent crashes
    if (!extension_settings) {
        log.error('VectFox: extension_settings is null/undefined - cannot access collections');
        return false;
    }
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }
    if (!extension_settings.vectfox.collections) {
        extension_settings.vectfox.collections = {};
    }
    return true;
}


/**
 * Canonical scope resolver — returns the EFFECTIVE scope of a collection,
 * always 'chat' or 'character', never null/undefined/'unknown'.
 *
 * Use this anywhere you need to branch on scope. Never branch on bare
 * `meta.scope === 'chat'` (or compare to 'character'), because `meta.scope`
 * can be `null` (post-2026-05-24 default) or the legacy string `'unknown'`
 * (collections created before the default fix landed). Both cases would
 * silently miss every branch and write nothing — exactly the 2026-05-24
 * "lock checkbox doesn't stick" no-plugin regression.
 *
 * Resolution order:
 *   1. Stored `meta.scope` if it's a valid value ('chat' or 'character').
 *   2. Parsed from the collection ID structure (via `parseCollectionId`):
 *      - `vf_eventbase_*` / `vf_archiveevent_*` → 'chat'
 *      - `vf_character_*` / `vf_lorebook_*` / `vf_document_*` → 'character'
 *   3. Default 'character' (matches `content-vectorization.js` insert default).
 *      Only reached for unparseable IDs (parser returns 'unknown' sentinel)
 *      and legacy stored values like the retired 'global'.
 *
 * @param {string} collectionIdOrRegistryKey - bare ID or "backend:id"
 * @param {object} [meta] - already-loaded meta (avoids re-reading from storage)
 * @returns {'chat'|'character'}
 */
export function getEffectiveScope(collectionIdOrRegistryKey, meta = null) {
    // 1. Stored meta wins if it's a valid scope value.
    const stored = meta?.scope;
    if (stored === 'chat' || stored === 'character') return stored;

    // 2. Parse from the bare collection ID (strip registry-key prefix first).
    const parsed = parseRegistryKey(collectionIdOrRegistryKey);
    const bareId = parsed.collectionId || collectionIdOrRegistryKey;
    const parsedScope = parseCollectionId(bareId).scope;
    if (parsedScope === 'chat' || parsedScope === 'character') return parsedScope;

    // 3. Default — matches the content-vectorization insert default so a
    //    user creating then immediately locking lands on 'character' (the
    //    safer / wider-scope option).
    return 'character';
}

/**
 * Gets metadata for a collection.
 *
 * Auto-resolves `meta.scope` to a valid value via {@link getEffectiveScope}
 * before returning, so callers never see `null` or legacy `'unknown'` and
 * don't have to remember the defensive `scope === 'chat'` branching pattern.
 *
 * @param {string} collectionId Collection identifier
 * @returns {object} Collection metadata (with defaults applied + scope resolved)
 */
export function getCollectionMeta(collectionId) {
    // VEC-26: Add comprehensive null checks
    if (!ensureCollectionsObject()) {
        const fresh = { ...defaultCollectionMeta };
        fresh.scope = getEffectiveScope(collectionId, fresh);
        return fresh;
    }

    const stored = extension_settings.vectfox.collections[collectionId];
    const merged = stored
        ? { ...defaultCollectionMeta, ...stored }
        : { ...defaultCollectionMeta };

    // Always return a usable scope. Cheap when stored is already valid
    // (single string comparison); only parses the ID when stored is null/
    // undefined/'unknown'. This is the single place that fixes every
    // downstream consumer of meta.scope — saveActivation, refreshWIStatus,
    // the badge renderer, the activation editor — without each of them
    // needing their own defensive read.
    merged.scope = getEffectiveScope(collectionId, merged);

    return merged;
}

/**
 * Sets metadata for a collection (merges with existing)
 * @param {string} collectionId Collection identifier
 * @param {object} data Metadata to set (partial or full)
 */
export function setCollectionMeta(collectionId, data) {
    if (!collectionId) {
        log.warn('VectFox: setCollectionMeta called with null/undefined collectionId');
        return;
    }

    ensureCollectionsObject();

    const existing = extension_settings.vectfox.collections[collectionId] || {};

    extension_settings.vectfox.collections[collectionId] = {
        ...defaultCollectionMeta,
        ...existing,
        ...data,
    };

    saveSettingsDebounced();
    log.trace(`VectFox: Updated metadata for collection ${collectionId}`);
}

/**
 * Deletes metadata for a collection
 * @param {string} collectionId Collection identifier
 */
export function deleteCollectionMeta(collectionId) {
    ensureCollectionsObject();

    if (extension_settings.vectfox.collections[collectionId]) {
        delete extension_settings.vectfox.collections[collectionId];
        _updateChatLockIndex(collectionId, null, '*');
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Deleted metadata for collection ${collectionId}`);
    }
}

/**
 * Gets all collection metadata
 * @returns {object} Map of collectionId -> metadata
 */
export function getAllCollectionMeta() {
    ensureCollectionsObject();
    return extension_settings.vectfox.collections;
}

// ============================================================================
// ENABLED STATE (convenience wrappers)
// ============================================================================

/**
 * Sets whether a collection is enabled
 * @param {string} collectionId Collection identifier
 * @param {boolean} enabled Whether collection is enabled
 */
export function setCollectionEnabled(collectionId, enabled) {
    setCollectionMeta(collectionId, { enabled: enabled });
}

/**
 * Checks if a collection is enabled
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether collection is enabled (default: true)
 */
export function isCollectionEnabled(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.enabled !== false;
}

// ============================================================================
// AUTO-SYNC STATE (per-collection auto-sync for chat vectorization)
// ============================================================================

/**
 * Sets whether auto-sync is enabled for a collection
 * @param {string} collectionId Collection identifier
 * @param {boolean} autoSync Whether auto-sync is enabled
 */
export function setCollectionAutoSync(collectionId, autoSync) {
    setCollectionMeta(collectionId, { autoSync: autoSync });
}

/**
 * Checks if auto-sync is enabled for a collection
 * @param {string} collectionId Collection identifier
 * @returns {boolean} Whether auto-sync is enabled (default: false)
 */
export function isCollectionAutoSyncEnabled(collectionId) {
    if (!collectionId) {
        return false;
    }
    const meta = getCollectionMeta(collectionId);
    return meta.autoSync === true;
}

// ============================================================================
// CHUNK METADATA (per-chunk settings, stored separately)
// ============================================================================
// Chunk metadata is stored per-hash and can include:
// - conditions: { ... }     - Conditional activation rules
// - chunkLinks: []          - Soft/hard links to other chunks ({ targetHash, mode })
// - disabled: boolean       - Exclude from results
// - isSummary: boolean      - Dual-vector summary chunk
// - parentHash: string      - Parent chunk for summaries
// - context: string         - Prompt context text (supports {{user}}/{{char}})
// - xmlTag: string          - XML tag to wrap this chunk
//
// Storage is delegated to core/chunk-meta-store.js (ADR-0003): the chunk payload
// is the source of truth when the Similharity plugin is present, and this
// settings namespace is the legacy store and the only store without the plugin.
// The four public functions below stay synchronous so their call sites do not
// change; reads merge per field (payload, then these settings) and writes to the
// payload are persisted asynchronously behind them.
//
// The key shape itself lives in core/chunk-meta-keys.js so that the Size
// Inspector can count these entries without importing this host-coupled module.
// ============================================================================

/**
 * Per-chunk fields with no backend payload representation. They are persisted to
 * extension_settings only, never merged into a payload write. This is the single
 * owner of the list; ui/chunk-visualizer.js imports it for its save split.
 */
export const CLIENT_ONLY_CHUNK_FIELDS = ['summaries'];

function readLegacyChunkMetadata(hash) {
    return extension_settings?.vectfox?.[chunkMetaSettingsKey(hash)] || null;
}

function writeLegacyChunkMetadata(hash, metadata) {
    if (!extension_settings.vectfox) {
        extension_settings.vectfox = {};
    }
    extension_settings.vectfox[chunkMetaSettingsKey(hash)] = metadata;
}

/**
 * Merges fields into one chunk's settings entry, creating the entry when it is
 * absent. This module owns the entry's shape, so the store asks for a merge
 * instead of assembling one: a field only settings holds is never dropped, and a
 * payload-path save never has to know what an entry looks like.
 * @param {string} hash Chunk hash
 * @param {object} fields Fields to write; the rest of the entry is kept
 */
function mergeLegacyChunkMetadata(hash, fields) {
    writeLegacyChunkMetadata(hash, { ...(readLegacyChunkMetadata(hash) || {}), ...fields });
}

/**
 * Removes the fields a successful payload retry superseded from one settings
 * entry (ticket 09). A field goes only when its stored value still equals the
 * value the payload accepted, so a newer fallback written while the retry was in
 * flight is never dropped. The entry itself goes when nothing else remains, so a
 * client-only field such as `summaries` keeps it in settings.
 *
 * No save here: the store issues one save for the whole retry outcome.
 * @param {string} hash Chunk hash
 * @param {object} metadata Fields the payload just accepted
 * @returns {number} How many fields were removed
 */
function pruneLegacyChunkMetadata(hash, metadata) {
    const entry = readLegacyChunkMetadata(hash);
    if (!entry || typeof entry !== 'object') return 0;
    let removed = 0;
    for (const [field, value] of Object.entries(metadata || {})) {
        if (!Object.prototype.hasOwnProperty.call(entry, field)) continue;
        if (!sameStoredValue(entry[field], value)) continue;
        delete entry[field];
        removed += 1;
    }
    if (removed > 0 && Object.keys(entry).length === 0) {
        removeLegacyChunkMetadata(hash);
    }
    return removed;
}

/**
 * Deletes one legacy settings entry without saving. Callers own persistence:
 * the store's delete path saves after calling this, and the sweep and the
 * orphan deletion remove thousands of entries in one run and save once at the
 * end.
 *
 * Presence, not truthiness, decides whether there was an entry: a stored value
 * of `null`, `0` or `''` is still a key that occupies the settings payload, and
 * reporting it as "already gone" would leave it behind on every run — the
 * orphan count would never reach zero.
 * @param {string} hash Chunk hash
 * @returns {boolean} Whether an entry was there to remove
 */
export function removeLegacyChunkMetadata(hash) {
    const store = extension_settings?.vectfox;
    const key = chunkMetaSettingsKey(hash);
    if (!store || !Object.prototype.hasOwnProperty.call(store, key)) {
        return false;
    }
    delete store[key];
    return true;
}

/**
 * The legacy settings entries: hash -> metadata, read straight from
 * extension_settings with no payload overlay. The store uses it for full-map
 * reads, and the sweep's dry run uses it because it must compare these entries
 * against what the payload actually holds — merging the mirror in would make
 * every entry look redundant.
 * @returns {Object<string, object>} map of hash -> metadata
 */
export function listLegacyChunkMetadata() {
    const result = {};
    const store = extension_settings?.vectfox;
    if (!store) {
        return result;
    }
    for (const key in store) {
        const hash = chunkHashFromSettingsKey(key);
        if (hash !== null) {
            result[hash] = store[key];
        }
    }
    return result;
}

const chunkMetaStore = createChunkMetaStore({
    getSettings: () => extension_settings?.vectfox || null,
    readLegacy: readLegacyChunkMetadata,
    writeLegacy: writeLegacyChunkMetadata,
    mergeLegacy: mergeLegacyChunkMetadata,
    pruneLegacy: pruneLegacyChunkMetadata,
    deleteLegacy: removeLegacyChunkMetadata,
    listLegacy: listLegacyChunkMetadata,
    persistSettings: () => saveSettingsDebounced(),
    clientOnlyFields: CLIENT_ONLY_CHUNK_FIELDS,
});

/**
 * Gets metadata for a specific chunk. The payload value wins per field; the
 * legacy settings entry fills fields the payload lacks.
 * @param {string} hash Chunk hash
 * @returns {object|null} Chunk metadata or null if neither store has it
 */
export function getChunkMetadata(hash) {
    return chunkMetaStore.getMetadata(hash);
}

/**
 * Saves metadata for a specific chunk. On the payload path this updates the
 * in-memory mirror synchronously and persists asynchronously (coalesced per
 * hash); nothing is written to settings except the fields no payload can carry
 * (client-only `summaries`), so an edit costs one payload write and no settings
 * upload. A payload write that fails is persisted to settings instead and queued
 * for a bounded retry that repairs the payload and removes the settings copy it
 * superseded (ticket 09). Without the plugin it writes the settings entry
 * exactly as before.
 * @param {string} hash Chunk hash
 * @param {object} metadata Chunk metadata
 */
export function saveChunkMetadata(hash, metadata) {
    chunkMetaStore.saveMetadata(hash, metadata);
}

/**
 * Deletes metadata for a specific chunk from the mirror and from settings.
 * @param {string} hash Chunk hash
 */
export function deleteChunkMetadata(hash) {
    chunkMetaStore.deleteMetadata(hash);
}

/**
 * Gets all chunk metadata entries: the legacy settings map overlaid with the
 * payload mirror of the collection currently in use (if any).
 * @returns {object} Map of hash -> metadata
 */
export function getAllChunkMetadata() {
    return chunkMetaStore.getAllMetadata();
}

/**
 * Injects the plugin transport (core/chunk-meta-transport.js). Until this is
 * called, the `auto` policy resolves to settings, so installs without the plugin
 * keep their previous behaviour.
 *
 * `listCollections` is the read-only registry listing the collection garbage
 * collection reads to prove whether another collection still holds a deleted
 * chunk's text (core/collection-loader.js owns the registry; the wiring injects
 * it here so this module does not import the loader back).
 * @param {{ transport?: object|null, listCollections?: Function|null }} [options]
 */
export function configureChunkMetaStore({ transport, listCollections } = {}) {
    if (listCollections !== undefined) chunkMetaListCollections = listCollections;
    chunkMetaStore.configure({ transport });
}

/**
 * Drops the payload mirror, hydration state and pending writes. Policy and
 * settings wiring survive. Used by tests and collection-scoped cleanup.
 */
export function resetChunkMetaStore() {
    chunkMetaStore.reset();
}

/**
 * Marks a collection as in use and starts hydrating its chunk payload metadata.
 * This is the lazy-hydration entry point — call it when a collection is opened
 * or queried, never during startup. Passing null clears the active collection.
 * Synchronous callers may ignore the returned promise.
 * @param {string|null} collectionId
 * @returns {Promise<boolean>} true when the collection's mirror is hydrated
 */
export function useChunkMetaCollection(collectionId) {
    return chunkMetaStore.useCollection(collectionId);
}

/**
 * Whether this install's chunk metadata lives in the chunk payload (plugin
 * reachable, policy not rolled back to `settings`).
 *
 * Bulk writers read this before writing settings: on the payload path the
 * payload already holds what they would persist, so the settings copy is pure
 * duplication — and one new key per inserted chunk is what grew the settings
 * object to 17,104 entries. Without the plugin the same callers must write
 * settings, so they keep today's behaviour.
 * @returns {boolean}
 */
export function isChunkMetaPayloadStore() {
    return chunkMetaStore.isPayloadStore();
}

/** Persists pending payload writes now (page unload, explicit flush). */
export function flushChunkMetaWrites() {
    return chunkMetaStore.flush();
}

/**
 * The failed-write retry queue's observable state (ticket 09): how many payload
 * repairs are recorded (durable across reloads), how many are scheduled in this
 * session, the queue's bound, and how many the cap dropped here.
 * @returns {{ pending: number, queued: number, cap: number, dropped: number }}
 */
export function getChunkMetaRetryState() {
    return chunkMetaStore.getRetryState();
}

// ============================================================================
// CHUNK-METADATA GARBAGE COLLECTION (collection / chunk deletion)
// ============================================================================
// Ticket 08: a normal delete must not create an orphan. Deleting a collection,
// purging it, or deleting one chunk in the visualizer removes that chunk
// metadata from both stores — but only the copies the deletion actually killed:
//
//   - settings entries are keyed by content-derived hash, shared with every
//     collection that holds the same text, so an entry is removed only when no
//     other registered collection still holds its chunk;
//   - an entry is a candidate only when its hash was in the collection being
//     deleted (or is one of the deleted chunk's hashes), so the pre-existing
//     orphans the dry run reports are not swept up by an unrelated delete;
//   - a collection that cannot be listed blocks every removal: absence in a
//     listing that never finished is not proof. That mirrors the sweep's outage
//     guard, and it is why `chunks` reads happen *before* the backend deletion:
//     afterwards the collection is gone and there is nothing left to compare.
//
// The payload side needs no writes: the backend delete already removed the
// payload, so the store only drops its mirror (and any queued patch) for what is
// gone. One settings save follows a run that removed something; a run that
// removed nothing saves nothing.

/** Reads the registered collections; injected by index.js with the transport. */
let chunkMetaListCollections = null;

/** Every key a deleted collection may be held under (registry key and bare id). */
function collectionKeysOf(collectionKey) {
    const key = String(collectionKey || '');
    if (!key) return [];
    const bare = parseRegistryKey(key).collectionId;
    return bare && bare !== key ? [key, bare] : [key];
}

/**
 * The registry context for a deletion: everything registered, the collections
 * that are not the deleted one, and whether the registry could be read at all.
 *
 * The deleted collection is excluded so a completed purge (which leaves it
 * unlistable) cannot refuse the run by failing its own scan. Exclusion is by
 * registry key, never by bare id alone: the same collection id can exist on two
 * backends, and hiding both would let a live collection's metadata be deleted. A
 * bare key that matches several registrations is therefore not excluded at all;
 * that never deletes more (a still-existing copy keeps the entry), but the
 * already-purged copy can then fail its scan and veto the run. Callers that know
 * the registry key form should pass it.
 *
 * @param {string} collectionKey Registry key or bare id
 * @returns {{
 *   available: boolean,
 *   registered: Array<{ registryKey: string, collectionId: string }>,
 *   others: Array<{ registryKey: string, collectionId: string }>,
 * }}
 */
function registryContextFor(collectionKey) {
    if (typeof chunkMetaListCollections !== 'function') {
        return { available: false, registered: [], others: [] };
    }
    const key = String(collectionKey || '');
    const registered = (chunkMetaListCollections(extension_settings?.vectfox || null) || [])
        .filter(collection => collection?.registryKey);
    let deleted;
    if (parseRegistryKey(key).backend) {
        deleted = new Set([key]);
    } else {
        const matches = registered.filter(collection => (
            collection.registryKey === key
            || String(collection.collectionId || '') === key
        ));
        deleted = matches.length === 1 ? new Set([matches[0].registryKey]) : new Set();
    }
    return {
        available: true,
        registered,
        others: registered.filter(collection => !deleted.has(collection.registryKey)),
    };
}

/**
 * The `hashes` option as a de-duplicated list, or null for a whole-collection
 * deletion.
 * @param {Iterable<string|number>|string|null|undefined} hashes
 * @returns {string[]|null}
 */
function chunkHashesArgument(hashes) {
    if (hashes === null || hashes === undefined) return null;
    const list = typeof hashes === 'string' ? [hashes] : [...hashes];
    return [...new Set(list.map(String).filter(hash => hash.length > 0))];
}

/**
 * Removes the chunk metadata of a deletion from both stores.
 *
 * Call it with `purge` for a whole-collection deletion: the collection's chunks
 * are read first (that is the only chance to learn what it held), then the
 * backend deletion runs, and only a successful one lets anything be removed.
 * Call it with `hashes` for chunks already deleted from a collection (the
 * visualizer's delete), where there is no backend step left to run.
 *
 * Nothing is removed unless the registry proves no other collection still holds
 * the text: an unreadable or empty registry, or any unlistable registered
 * collection, refuses the cleanup instead. The entries then stay behind for the
 * dry run, which reports them; deleting them on an unverified guess could destroy
 * metadata another collection still reads.
 *
 * Never throws for a backend or store failure: it reports a status instead, so a
 * failed cleanup can never turn a completed deletion into an error.
 *
 * @param {string} collectionKey The collection being deleted, or the collection
 *     the chunks were deleted from. Registry key or bare id.
 * @param {object} [options]
 * @param {Iterable<string|number>|string|null} [options.hashes]
 *     The chunks that are gone. Omit for a whole-collection deletion.
 * @param {(() => Promise<boolean|void>)|null} [options.purge]
 *     The backend deletion to run between reading the collection and removing
 *     its metadata. Resolving `false` means the backend refused: the collection
 *     still exists, so nothing is removed and the mirror is kept. A throwing
 *     purge counts as refused.
 * @returns {Promise<{
 *   status: 'empty'|'refused'|'complete'|'aborted',
 *   purged: boolean|null,
 *   reason: 'registry-unavailable'|'registry-empty'|'collection-unlisted'|
 *     'collections-unverified'|'purge-failed'|null,
 *   counts: { candidates: number, deleted: number, skipped: number, shared: number, unverified: number },
 *   error: string|null,
 *   saveError: string|null,
 * }>}
 */
export async function deleteChunkMetadataForCollection(collectionKey, {
    hashes = null,
    purge = null,
} = {}) {
    const key = String(collectionKey || '');
    const explicit = chunkHashesArgument(hashes);
    const wholeCollection = explicit === null;
    const result = {
        status: 'empty',
        purged: null,
        reason: null,
        counts: { candidates: 0, deleted: 0, skipped: 0, shared: 0, unverified: 0 },
        error: null,
        saveError: null,
    };
    if (wholeCollection && !key) return result;

    const runPurge = async () => {
        if (typeof purge !== 'function') return null;
        try {
            return (await purge()) !== false;
        } catch (error) {
            log.warn(`VectFox: the backend deletion for ${key || 'the collection'} failed — keeping its chunk metadata: ${error?.message || error}`);
            return false;
        }
    };

    // The collection is gone (or was never deleted): drop the payload side. A
    // refused purge means it still exists, so its mirror stays valid.
    const releasePayloadSide = () => {
        if (wholeCollection) {
            for (const id of collectionKeysOf(key)) chunkMetaStore.forgetCollection(id);
        } else {
            chunkMetaStore.forgetChunks(explicit);
        }
    };

    // A refusal leaves the settings entries in place; say why, because the size
    // not dropping is otherwise indistinguishable from a no-op.
    const refuse = (reason) => {
        result.status = 'refused';
        result.reason = reason;
        log.warn(`VectFox: chunk-metadata cleanup for ${key || 'the deleted collection'} removed nothing (${reason}) — the storage dry run reports what is left.`);
        return result;
    };

    // Ends a run that removes nothing: the backend deletion still runs, and a
    // refused purge turns the run into the refusal it already is.
    const finishRun = async (status, reason) => {
        result.purged = await runPurge();
        if (result.purged !== false) releasePayloadSide();
        if (result.purged === false) return refuse('purge-failed');
        if (status === 'refused') return refuse(reason);
        result.status = status;
        result.reason = reason;
        return result;
    };

    // Nothing is stored for any chunk: no registry read, no listing, no scan, no
    // save. The backend deletion still runs and the payload side still goes.
    const entries = listLegacyChunkMetadata();
    if (Object.keys(entries).length === 0) return finishRun('empty', null);

    // The shared-hash check needs the registry. An uninjectable or empty registry
    // is the "discovery has not run" state the orphan cleanup already refuses to
    // mass-wipe on: absence there is not proof that no other collection holds the
    // text.
    const registry = registryContextFor(key);
    if (!registry.available) return finishRun('refused', 'registry-unavailable');
    if (registry.registered.length === 0) return finishRun('refused', 'registry-empty');

    // What the deletion provably covers, read before the chunks disappear.
    let covered = explicit;
    if (wholeCollection) {
        const listing = await chunkMetaStore.listCollectionHashes(key);
        if (!listing.complete) return finishRun('refused', 'collection-unlisted');
        covered = listing.hashes;
    }
    const coveredSet = new Set(covered);
    if (!Object.keys(entries).some(hash => coveredSet.has(hash))) return finishRun('empty', null);

    // The backend deletion gates every removal: a purged collection's metadata is
    // gone for good, a still-existing one's is not.
    result.purged = await runPurge();
    if (result.purged === false) return refuse('purge-failed');

    // The backend copy is gone, so the payload side goes now — before the scan.
    // A debounced payload write that fails while the scan runs can no longer mint
    // a settings entry for a chunk this deletion covers.
    releasePayloadSide();

    // Every place the deleted text can still live. The purge already ran: an
    // unexpected failure past this point can keep entries (they become orphans
    // the dry run reports), but nothing is deleted on a guess.
    let plan;
    const scans = [];
    let planned;
    try {
        for (const collection of registry.others) {
            const listing = await chunkMetaStore.listCollectionHashes(collection.registryKey);
            scans.push({
                registryKey: collection.registryKey,
                collectionId: String(collection.collectionId || ''),
                status: listing.complete ? 'ok' : 'failed',
                hashes: new Set(listing.hashes),
            });
        }
        // Re-read the settings after the scan: an entry written while the scan ran
        // must still be planned, or it becomes the orphan this action exists to
        // prevent.
        planned = listLegacyChunkMetadata();
        result.counts.candidates = Object.keys(planned).filter(hash => coveredSet.has(hash)).length;
        plan = planCollectionChunkMetaGc({
            entries: planned,
            deletedHashes: covered,
            collections: registry.others,
            scans,
        });
    } catch (error) {
        log.error(`VectFox: chunk-metadata cleanup for ${key} stopped before deleting anything: ${error?.message || error}`);
        result.error = error?.message || String(error);
        return refuse('collections-unverified');
    }

    const run = await executeCollectionChunkMetaGc({
        plan,
        deleteEntry: removeLegacyChunkMetadata,
        persistSettings: () => saveSettingsDebounced(),
    });

    result.counts.deleted = run.counts.deleted;
    result.counts.skipped = run.counts.skipped;
    result.counts.shared = plan.counts.shared;
    result.counts.unverified = plan.counts.unverified;
    result.error = run.error;
    result.saveError = run.saveError;
    if (run.status === 'refused') return refuse('collections-unverified');
    result.status = run.status;
    return result;
}


// ============================================================================
// MIGRATION & CLEANUP
// ============================================================================

/**
 * Migrates old scattered enabled keys to new collections structure
 * Old format: vectfox_collection_enabled_{collectionId} = true/false
 * New format: collections[collectionId].enabled = true/false
 */
export function migrateOldEnabledKeys() {
    if (!extension_settings.vectfox) {
        return { migrated: 0 };
    }

    ensureCollectionsObject();

    let migrated = 0;
    const keysToDelete = [];

    for (const key in extension_settings.vectfox) {
        if (key.startsWith('vectfox_collection_enabled_')) {
            const collectionId = key.replace('vectfox_collection_enabled_', '');
            const enabled = extension_settings.vectfox[key];

            // Only migrate if we don't already have metadata for this collection
            if (!extension_settings.vectfox.collections[collectionId]) {
                extension_settings.vectfox.collections[collectionId] = {
                    ...defaultCollectionMeta,
                    enabled: enabled !== false,
                };
                log.lifecycle(`VectFox: Migrated enabled key for ${collectionId}`);
            }

            keysToDelete.push(key);
            migrated++;
        }
    }

    // Delete old keys
    for (const key of keysToDelete) {
        delete extension_settings.vectfox[key];
    }

    if (migrated > 0) {
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Migrated ${migrated} old enabled keys to new collections structure`);
    }

    return { migrated };
}

/**
 * Cleans up orphaned metadata entries (collections that no longer exist)
 * @param {string[]} actualCollectionIds Array of collection IDs that actually exist
 * @returns {object} Cleanup stats
 */
export function cleanupOrphanedMeta(actualCollectionIds) {
    ensureCollectionsObject();

    const actualSet = new Set(actualCollectionIds);
    const orphaned = [];

    for (const collectionId in extension_settings.vectfox.collections) {
        if (!actualSet.has(collectionId)) {
            orphaned.push(collectionId);
        }
    }

    // Mass-wipe refusal. An empty survivor list with metadata still stored means
    // discovery found NOTHING — which in practice is an outage (plugin down,
    // Qdrant unreachable), not the user having deleted every collection at once.
    // Metadata holds the chat/character locks and triggers; deleting it here is
    // irreversible, while a stale entry costs nothing and self-corrects on the
    // next successful discovery. Refuse and say so.
    if (actualCollectionIds.length === 0 && orphaned.length > 0) {
        log.warn(`VectFox: cleanupOrphanedMeta refused — discovery returned ZERO collections while ${orphaned.length} metadata entr${orphaned.length === 1 ? 'y is' : 'ies are'} stored. This looks like a backend outage, not a real mass deletion; keeping all metadata (locks, triggers) intact.`);
        return { removed: 0, orphanedIds: [], refused: true };
    }

    for (const collectionId of orphaned) {
        delete extension_settings.vectfox.collections[collectionId];
        log.trace(`VectFox: Removed orphaned metadata for ${collectionId}`);
    }

    if (orphaned.length > 0) {
        saveSettingsDebounced();
        // warn, not lifecycle: this deletes locks/triggers with the collection.
        // When a wipe is ever wrong (see the refusal above), this line is the
        // only trace of WHAT was lost — name the entries.
        log.warn(`VectFox: Cleaned up ${orphaned.length} orphaned metadata entries: ${orphaned.join(', ')}`);
    }

    return { removed: orphaned.length, orphanedIds: orphaned, refused: false };
}

// ============================================================================
// COLLECTION LOCKING (Bind collection to one or more chats)
// ============================================================================

/**
 * Maintains the reverse index: extension_settings.vectfox.chat_lock_index[chatId] = [collectionId, ...]
 * @param {string} collectionId
 * @param {string|null} addChatId - chat to add collectionId to (null = skip)
 * @param {string|'*'|null} removeChatId - chat to remove collectionId from, '*' = remove from all, null = skip
 */
function _updateChatLockIndex(collectionId, addChatId, removeChatId) {
    const store = extension_settings?.vectfox;
    if (!store) return;
    if (!store.chat_lock_index) store.chat_lock_index = {};
    const idx = store.chat_lock_index;

    if (addChatId) {
        const key = String(addChatId);
        if (!Array.isArray(idx[key])) idx[key] = [];
        if (!idx[key].includes(collectionId)) idx[key].push(collectionId);
    }

    if (removeChatId === '*') {
        for (const key of Object.keys(idx)) {
            idx[key] = idx[key].filter(id => id !== collectionId);
            if (idx[key].length === 0) delete idx[key];
        }
    } else if (removeChatId) {
        const key = String(removeChatId);
        if (Array.isArray(idx[key])) {
            idx[key] = idx[key].filter(id => id !== collectionId);
            if (idx[key].length === 0) delete idx[key];
        }
    }
}

/**
 * Returns the collection IDs locked to a given chat (O(1) lookup).
 * Only includes collections registered via setCollectionLock after this index was introduced.
 * @param {string} chatId
 * @returns {string[]}
 */
export function getChatLockedCollections(chatId) {
    const idx = extension_settings?.vectfox?.chat_lock_index;
    if (!idx || !chatId) return [];
    return Array.isArray(idx[String(chatId)]) ? [...idx[String(chatId)]] : [];
}

/**
 * Adds a chat to the collection's lock list. Supports multiple chats per collection.
 * Stores chat IDs in metadata field `lockedToChatIds` (array).
 * Automatically migrates old single-value `lockedToChatId` to array format.
 * @param {string} collectionId
 * @param {string|null} chatId - Chat ID to lock to, or null to remove all locks
 */
export function setCollectionLock(collectionId, chatId) {
    if (!collectionId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    if (chatId === null) {
        // Clear all locks
        update.lockedToChatIds = [];
        update.lockedToChatId = null; // Clear old format for backward compat
    } else {
        chatId = String(chatId);
        let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

        // Migrate old single-value format if present
        if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
            locks.push(String(meta.lockedToChatId));
        }

        // Add chat if not already present
        if (!locks.includes(chatId)) {
            locks.push(chatId);
        }

        update.lockedToChatIds = locks;
        update.lockedToChatId = null; // Clear old format
    }

    setCollectionMeta(collectionId, update);
    _updateChatLockIndex(collectionId, chatId === null ? null : chatId, chatId === null ? '*' : null);
    log.lifecycle(`VectFox: Collection ${collectionId} locks updated:`, update.lockedToChatIds);
}

/**
 * Removes a specific chat from a collection's lock list
 * @param {string} collectionId
 * @param {string} chatId - Chat ID to remove from lock list
 */
export function removeCollectionLock(collectionId, chatId) {
    if (!collectionId || !chatId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

    // Migrate old format if present
    if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
        locks.push(String(meta.lockedToChatId));
    }

    // Remove the chat
    locks = locks.filter(id => String(id) !== String(chatId));

    update.lockedToChatIds = locks;
    update.lockedToChatId = null; // Clear old format

    setCollectionMeta(collectionId, update);
    _updateChatLockIndex(collectionId, null, chatId);
    log.lifecycle(`VectFox: Removed chat ${chatId} from collection ${collectionId} locks`);
}

/**
 * Clears all locks for a collection (removes from all chats)
 * @param {string} collectionId
 */
export function clearCollectionLock(collectionId) {
    setCollectionLock(collectionId, null);
}

/**
 * Gets the array of locked chat IDs for a collection, or empty array if not locked
 * Includes backward compatibility for old single-value `lockedToChatId` format
 * @param {string} collectionId
 * @returns {string[]}
 */
export function getCollectionLocks(collectionId) {
    const meta = getCollectionMeta(collectionId);
    let locks = Array.isArray(meta.lockedToChatIds) ? [...meta.lockedToChatIds] : [];

    // Backward compatibility: if old format exists and not already in new format, include it
    if (meta.lockedToChatId && !locks.includes(String(meta.lockedToChatId))) {
        locks.push(String(meta.lockedToChatId));
    }

    return locks;
}

/**
 * Checks whether the collection is locked to the provided chatId
 * @param {string} collectionId
 * @param {string} chatId
 * @returns {boolean}
 */
export function isCollectionLockedToChat(collectionId, chatId) {
    if (!collectionId || !chatId) return false;
    const locks = getCollectionLocks(collectionId);
    return locks.some(id => String(id) === String(chatId));
}

/**
 * Gets the count of chats this collection is locked to
 * @param {string} collectionId
 * @returns {number}
 */
export function getCollectionLockCount(collectionId) {
    return getCollectionLocks(collectionId).length;
}

// ============================================================================
// CHARACTER LOCKING (Bind collection to one or more character cards)
// ============================================================================

/**
 * Adds a character to the collection's character lock list. Supports multiple characters per collection.
 * Stores character IDs in metadata field `lockedToCharacterIds` (array).
 * @param {string} collectionId
 * @param {string} characterId - Character ID to lock to
 */
export function setCollectionCharacterLock(collectionId, characterId) {
    if (!collectionId || !characterId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    characterId = String(characterId);
    let locks = Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];

    // Add character if not already present
    if (!locks.includes(characterId)) {
        locks.push(characterId);
    }

    update.lockedToCharacterIds = locks;
    setCollectionMeta(collectionId, update);
    log.lifecycle(`VectFox: Collection ${collectionId} character locks updated:`, update.lockedToCharacterIds);
}

/**
 * Removes a specific character from a collection's character lock list
 * @param {string} collectionId
 * @param {string} characterId - Character ID to remove from lock list
 */
export function removeCollectionCharacterLock(collectionId, characterId) {
    if (!collectionId || !characterId) return;
    const meta = getCollectionMeta(collectionId);
    const update = {};

    let locks = Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];

    // Remove the character
    locks = locks.filter(id => String(id) !== String(characterId));

    update.lockedToCharacterIds = locks;
    setCollectionMeta(collectionId, update);
    log.lifecycle(`VectFox: Removed character ${characterId} from collection ${collectionId} locks`);
}

/**
 * Clears all character locks for a collection
 * @param {string} collectionId
 */
export function clearCollectionCharacterLocks(collectionId) {
    if (!collectionId) return;
    setCollectionMeta(collectionId, { lockedToCharacterIds: [] });
    log.lifecycle(`VectFox: Cleared all character locks for collection ${collectionId}`);
}

/**
 * Gets the array of locked character IDs for a collection, or empty array if not locked
 * @param {string} collectionId
 * @returns {string[]}
 */
export function getCollectionCharacterLocks(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return Array.isArray(meta.lockedToCharacterIds) ? [...meta.lockedToCharacterIds] : [];
}

/**
 * Checks whether the collection is locked to the provided character ID
 * @param {string} collectionId
 * @param {string} characterId
 * @returns {boolean}
 */
export function isCollectionLockedToCharacter(collectionId, characterId) {
    if (!collectionId || !characterId) return false;
    const locks = getCollectionCharacterLocks(collectionId);
    return locks.some(id => String(id) === String(characterId));
}

/**
 * Gets the count of characters this collection is locked to
 * @param {string} collectionId
 * @returns {number}
 */
export function getCollectionCharacterLockCount(collectionId) {
    return getCollectionCharacterLocks(collectionId).length;
}

/**
 * Single source of truth for "Active for current chat" — the UI checkbox state and the
 * listing lock badge both derive from this. Scope decides which lock list is consulted:
 *   - scope='chat'      → chat-lock list, match against current chat
 *   - scope='character' → character-lock list, match against current character
 * @param {string} collectionId
 * @param {{chatId?: string, characterId?: string|number}} context
 * @returns {boolean}
 */
export function isCollectionActiveForContext(collectionId, { chatId, characterId } = {}) {
    if (!collectionId) return false;
    const meta = getCollectionMeta(collectionId);
    // Infer missing scope from type so old collections (created before scope stamping)
    // still resolve correctly instead of silently returning false.
    const scope = (meta.scope && meta.scope !== 'unknown') ? meta.scope : (meta.type || 'chat');
    if (scope === 'chat') {
        return Boolean(chatId && isCollectionLockedToChat(collectionId, chatId));
    }
    if (scope === 'character') {
        return Boolean(characterId && isCollectionLockedToCharacter(collectionId, String(characterId)));
    }
    return false;
}

/**
 * Key-tolerant wrapper over {@link isCollectionActiveForContext} — the single
 * entry point for "is this collection active for the current chat/character?"
 * when you hold raw keys instead of a getCollectionListing entry.
 *
 * Lock + scope metadata can live under EITHER key form: the DB Browser pause
 * toggle and the registry write under the registry-key ("backend:id"), while the
 * "Active for current chat" checkbox can write under the bare collectionId. So a
 * caller that has a collection object must check both forms; this collapses that
 * into one call so the active-resolution logic stays in one place. Returns true
 * if active under ANY supplied form.
 *
 * @param {string|string[]} keys - registryKey and/or bare id (falsy entries skipped)
 * @param {{chatId?: string, characterId?: string|number}} [context]
 * @returns {boolean}
 */
export function isCollectionActiveForContextAnyKey(keys, context = {}) {
    const list = Array.isArray(keys) ? keys : [keys];
    return list.some(key => key && isCollectionActiveForContext(key, context));
}

// ============================================================================
// LOCK FACADE — getLock / setLock
// ============================================================================
// Two-function entry point for everything lock-related. Bundles:
//   1. Authorization (superadmin OR creator handle matches current persona)
//   2. Scope-aware lock list (chat vs character)
//   3. Current-context active check (locked to current chat/character)
//
// Callers MUST pass the canonical storage key (registry-key form "backend:id"
// when the collection belongs to a backend, bare ID otherwise). There is no
// auto-resolution — pass `collection.registryKey || collection.id` at call
// sites where you have the loader's collection object.

/**
 * Authorization check for lock operations. Returns true when:
 *   - settings.superadmin === true, OR
 *   - the collection's creatorHandle matches the current persona handle, OR
 *   - the collection has no creatorHandle stamp and its bare ID contains the
 *     current handle (legacy fallback — same logic as getCollectionListing).
 *
 * Returns true (allow) when context is unavailable so headless/system code
 * (collection-export imports, registry registration) isn't blocked.
 *
 * @param {object} meta - already-resolved collection metadata
 * @param {string} collectionId - original ID passed by caller (for legacy fallback)
 * @param {object} [settings] - extension_settings.vectfox (or partial)
 * @returns {boolean}
 */
function _isLockAuthorized(meta, collectionId, settings) {
    const store = settings || extension_settings?.vectfox || {};
    if (store.superadmin === true) return true;

    let currentHandle = '';
    try {
        // Dynamic require to avoid circular import with collection-loader.js.
        // If the context modules aren't ready (early boot), allow the action.
        const ctx = (typeof getContext === 'function') ? getContext() : null;
        // Must match the creatorHandle stamp exactly (sanitizeHandleId: NFC + edge-trim
        // + 30-char cap). The old inline derivation skipped those, so owners with
        // accented / long / punctuation-edged persona names failed this equality check
        // and got locked out of their own collections.
        currentHandle = sanitizeHandleId(ctx?.name1);
    } catch (_) {
        return true; // permissive when context unavailable
    }
    if (!currentHandle || currentHandle === 'user') return true; // permissive when no persona

    const creator = meta?.creatorHandle ? String(meta.creatorHandle).toLowerCase() : '';
    if (creator) return creator === currentHandle;

    // No creatorHandle stamp — legacy fallback to ID substring match.
    const bareId = parseRegistryKey(collectionId).collectionId || collectionId || '';
    return bareId.toLowerCase().includes(`_${currentHandle}_`);
}

/**
 * Get the lock state for a collection. One stop for: "is it locked anywhere?",
 * "is it locked to the current context?", "what chats/characters is it locked
 * to?", and "can the current user modify these locks?".
 *
 * Returns null when the caller is unauthorized (non-superadmin, non-owner).
 * Use options.ignoreAuth=true for internal/system callers that need the raw state.
 *
 * @param {string} collectionId - Bare ID or registry-key form ("backend:id")
 * @param {object} [options]
 * @param {string} [options.chatId] - Override current chat ID for the active check
 * @param {string|number} [options.characterId] - Override current character ID
 * @param {object} [options.settings] - VectFox settings (for superadmin flag)
 * @param {boolean} [options.ignoreAuth=false] - Skip authorization gate
 * @returns {null | {
 *   storageKey: string,
 *   scope: 'chat' | 'character' | 'unknown',
 *   chatLocks: string[],
 *   characterLocks: string[],
 *   isLocked: boolean,
 *   isActiveHere: boolean,
 *   canModify: boolean,
 * }}
 */
export function getLock(collectionId, options = {}) {
    if (!collectionId) return null;
    const { chatId, characterId, settings, ignoreAuth = false } = options;

    const meta = getCollectionMeta(collectionId);
    const canModify = _isLockAuthorized(meta, collectionId, settings);

    if (!ignoreAuth && !canModify) {
        return null;
    }

    const chatLocks = getCollectionLocks(collectionId);
    const characterLocks = getCollectionCharacterLocks(collectionId);
    const scope = meta?.scope || 'unknown';

    let isActiveHere = false;
    if (scope === 'chat') {
        isActiveHere = Boolean(chatId && chatLocks.some(id => String(id) === String(chatId)));
    } else if (scope === 'character') {
        isActiveHere = Boolean(characterId && characterLocks.some(id => String(id) === String(characterId)));
    }

    return {
        storageKey: collectionId,
        scope,
        chatLocks,
        characterLocks,
        isLocked: chatLocks.length > 0 || characterLocks.length > 0,
        isActiveHere,
        canModify,
    };
}

/**
 * Mutate a collection's lock state. Validates authorization first.
 *
 * @param {string} collectionId - Bare ID or registry-key form
 * @param {{ kind: 'chat'|'character', op: 'add'|'remove'|'clear', target?: string }} action
 *   - kind:   which lock list to modify
 *   - op:     'add' = include target, 'remove' = drop target, 'clear' = empty the list
 *   - target: chatId or characterId (required for add/remove; ignored for clear)
 * @param {object} [options]
 * @param {object} [options.settings] - VectFox settings (for superadmin)
 * @param {boolean} [options.ignoreAuth=false] - Skip authorization (system use)
 * @returns {{ success: boolean, reason?: string }}
 */
export function setLock(collectionId, action, options = {}) {
    if (!collectionId) return { success: false, reason: 'missing collectionId' };
    if (!action || typeof action !== 'object') return { success: false, reason: 'missing action' };
    const { kind, op, target } = action;
    if (kind !== 'chat' && kind !== 'character') return { success: false, reason: 'invalid kind' };
    if (op !== 'add' && op !== 'remove' && op !== 'clear') return { success: false, reason: 'invalid op' };
    if ((op === 'add' || op === 'remove') && !target) return { success: false, reason: 'missing target' };

    const { settings, ignoreAuth = false } = options;
    const meta = getCollectionMeta(collectionId);

    if (!ignoreAuth && !_isLockAuthorized(meta, collectionId, settings)) {
        log.warn(`VectFox: setLock denied for ${collectionId} (kind=${kind}, op=${op}) — not superadmin and persona handle does not match creatorHandle`);
        return { success: false, reason: 'unauthorized' };
    }

    if (kind === 'chat') {
        if (op === 'add') setCollectionLock(collectionId, target);
        else if (op === 'remove') removeCollectionLock(collectionId, target);
        else clearCollectionLock(collectionId);
    } else {
        if (op === 'add') setCollectionCharacterLock(collectionId, String(target));
        else if (op === 'remove') removeCollectionCharacterLock(collectionId, String(target));
        else clearCollectionCharacterLocks(collectionId);
    }
    return { success: true };
}

/**
 * Ensures a collection has metadata (creates with defaults if missing)
 * Called when a collection is discovered/created
 * @param {string} collectionId Collection identifier
 * @param {object} initialData Optional initial data to set (can include 'type' for collection type)
 */
export function ensureCollectionMeta(collectionId, initialData = {}) {
    if (!collectionId) {
        return;
    }

    ensureCollectionsObject();

    if (!extension_settings.vectfox.collections[collectionId]) {
        extension_settings.vectfox.collections[collectionId] = {
            ...defaultCollectionMeta,
            createdAt: Date.now(),
            ...initialData,
        };
        saveSettingsDebounced();
        log.lifecycle(`VectFox: Created metadata for new collection ${collectionId}`);
    }
}

/**
 * Updates lastUsed timestamp and increments queryCount
 * Called when a collection is queried
 * @param {string} collectionId Collection identifier
 */
export function recordCollectionUsage(collectionId) {
    if (!collectionId) {
        return;
    }

    ensureCollectionsObject();

    const existing = extension_settings.vectfox.collections[collectionId];
    if (existing) {
        existing.lastUsed = Date.now();
        existing.queryCount = (existing.queryCount || 0) + 1;
        saveSettingsDebounced();
    }
}

// ============================================================================
// ACTIVATION TRIGGERS (Primary Method)
// ============================================================================

/**
 * Checks if any activation triggers match the recent messages
 * @param {string[]} triggers Array of trigger keywords
 * @param {object} context Search context containing recentMessages
 * @param {object} options Matching options
 * @returns {boolean} Whether triggers matched
 */
function checkTriggers(triggers, context, options = {}) {
    if (!triggers || triggers.length === 0) {
        return false;
    }

    const {
        matchMode = 'any',
        caseSensitive = false,
        scanDepth = 5,
    } = options;

    // Get recent message text to scan
    const recentMessages = context.recentMessages || [];
    const messagesToScan = recentMessages.slice(0, scanDepth);
    const searchText = messagesToScan.join('\n');

    if (!searchText) {
        return false;
    }

    const textToSearch = caseSensitive ? searchText : searchText.toLowerCase();

    // Check each trigger
    const results = triggers.map(trigger => {
        const triggerText = caseSensitive ? trigger : trigger.toLowerCase();

        // Support regex triggers (wrapped in /.../)
        if (trigger.startsWith('/') && trigger.lastIndexOf('/') > 0) {
            try {
                const lastSlash = trigger.lastIndexOf('/');
                const pattern = trigger.slice(1, lastSlash);
                const flags = trigger.slice(lastSlash + 1) || (caseSensitive ? '' : 'i');
                const regex = new RegExp(pattern, flags);
                return regex.test(searchText);
            } catch (e) {
                log.warn(`VectFox: Invalid trigger regex: ${trigger}`);
                return false;
            }
        }

        // Plain text matching
        return textToSearch.includes(triggerText);
    });

    // Apply match mode
    if (matchMode === 'all') {
        return results.every(r => r);
    }
    return results.some(r => r); // 'any' mode (default)
}

// ============================================================================
// CONDITIONAL ACTIVATION (Advanced Method - Secondary)
// ============================================================================

// Import condition evaluator (lazy loaded to avoid circular deps)
let evaluateConditionRule = null;

/**
 * Lazily loads the condition evaluator
 */
async function getConditionEvaluator() {
    if (!evaluateConditionRule) {
        const module = await import('./conditional-activation.js');
        evaluateConditionRule = module.evaluateConditionRule;
    }
    return evaluateConditionRule;
}

/**
 * Evaluates advanced conditions for a collection
 * @param {object} meta Collection metadata
 * @param {object} context Search context
 * @param {string} collectionId Collection identifier (for logging)
 * @returns {Promise<boolean>} Whether conditions pass
 */
async function evaluateAdvancedConditions(meta, context, collectionId) {
    if (!meta.conditions || !meta.conditions.enabled) {
        return true; // No conditions = pass
    }

    const rules = meta.conditions.rules || [];
    if (rules.length === 0) {
        return true; // Enabled but no rules = pass
    }

    const evaluate = await getConditionEvaluator();

    const results = rules.map(rule => {
        const result = evaluate(rule, context);
        log.trace(`VectFox: Collection ${collectionId} condition ${rule.type}: ${result}`);
        return result;
    });

    const logic = meta.conditions.logic || 'AND';
    return logic === 'AND' ? results.every(r => r) : results.some(r => r);
}

/**
 * Checks whether a collection should be queried this turn.
 *
 * ACTIVATION IS A CHAIN OF GATES, NOT A LIST OF ALTERNATIVES. Every gate that
 * applies must pass:
 *
 * 1. Pause button (enabled=false)              → never activate
 * 2. Lock (chat or character) — THE MASTER SWITCH → required; unlocked never activates
 * 3. Activation Triggers, when configured      → keyword must match this turn
 * 4. Advanced Conditions, when configured      → rules must pass this turn
 * 5. Locked with no trigger and no condition   → always active
 *
 * The lock is what turns a collection on at all; triggers and conditions only
 * NARROW an already-on collection. A collection with trigger keywords but no
 * lock is inert by design — the user has described what should activate it but
 * has not switched it on.
 *
 * This replaced an OR chain in which a trigger match returned true "regardless
 * of lock state". That inverted the intended model twice over: an unlocked
 * collection could activate on a keyword (the leak the isOwn guard in
 * core/world-info-integration.js was added to contain), and — because a
 * non-matching trigger fell THROUGH to the lock check — a trigger on a locked
 * collection was a no-op that could never gate anything. Both are fixed here.
 *
 * @param {string} collectionId Collection identifier
 * @param {object} context Search context (from buildSearchContext) — must carry
 *   recentMessages for trigger matching, plus currentChatId / currentCharacterId
 * @returns {Promise<boolean>} Whether the collection should be queried
 */
export async function shouldCollectionActivate(collectionId, context) {
    const meta = getCollectionMeta(collectionId);
    const currentChatId = context?.currentChatId;
    const currentCharacterId = context?.currentCharacterId;

    // Gate 1: Pause button — global disable, blocks everything.
    if (meta.enabled === false) {
        log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✗ DISABLED`);
        return false;
    }

    // Gate 2: Lock — the master switch. Nothing downstream can activate a
    // collection the user has not switched on for this chat or character.
    const lockedToChat = !!(currentChatId && isCollectionLockedToChat(collectionId, currentChatId));
    const lockedToCharacter = !!(currentCharacterId && isCollectionLockedToCharacter(collectionId, currentCharacterId));
    if (!lockedToChat && !lockedToCharacter) {
        log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✗ NOT_LOCKED (master switch off for chat=${currentChatId}, character=${currentCharacterId})`);
        return false;
    }

    const hasTriggers = meta.triggers && meta.triggers.length > 0;
    const hasConditions = meta.conditions?.enabled && meta.conditions?.rules?.length > 0;

    log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: locked (chat=${lockedToChat}, character=${lockedToCharacter}), hasTriggers=${hasTriggers}, hasConditions=${hasConditions}`);

    // Gate 3: Activation Triggers narrow the locked collection to matching turns.
    if (hasTriggers) {
        const triggersMatch = checkTriggers(meta.triggers, context, {
            matchMode: meta.triggerMatchMode || 'any',
            caseSensitive: meta.triggerCaseSensitive || false,
            scanDepth: meta.triggerScanDepth || 5,
        });
        if (!triggersMatch) {
            log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✗ TRIGGERS_UNMATCHED (${meta.triggers.join(', ')})`);
            return false;
        }
        log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✓ TRIGGERS_MATCHED`);
    }

    // Gate 4: Advanced Conditions narrow further. Both must hold when both are
    // configured — they are successive filters, not alternatives.
    if (hasConditions) {
        const conditionsPass = await evaluateAdvancedConditions(meta, context, collectionId);
        if (!conditionsPass) {
            log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✗ CONDITIONS_FAIL`);
            return false;
        }
        log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✓ CONDITIONS_PASS`);
    }

    // Gate 5: Locked and every configured filter passed.
    log.trace(`[VECTFOX Activation Filter] Collection ${collectionId}: ✓ ACTIVE`);
    return true;
}

/**
 * Filters a list of collection IDs to only those that should activate
 * @param {string[]} collectionIds Array of collection IDs to check
 * @param {object} context Search context (from buildSearchContext)
 * @returns {Promise<string[]>} Collection IDs that should be queried
 */
export async function filterActiveCollections(collectionIds, context) {
    const results = await Promise.all(
        collectionIds.map(async (id) => ({
            id,
            active: await shouldCollectionActivate(id, context)
        }))
    );

    const activeIds = results.filter(r => r.active).map(r => r.id);

    if (log.enabled('trace')) {
        log.trace(`[VECTFOX Activation Filter] Summary: ${collectionIds.length} collections → ${activeIds.length} active`);
        if (activeIds.length > 0) {
            log.trace(`[VECTFOX Activation Filter] Active collections:`, activeIds);
        }
    }

    return activeIds;
}

// ============================================================================
// ACTIVATION TRIGGER HELPERS
// ============================================================================

/**
 * Sets activation triggers for a collection
 * @param {string} collectionId Collection identifier
 * @param {string[]} triggers Array of trigger keywords
 * @param {object} options Optional: matchMode, caseSensitive, scanDepth
 */
export function setCollectionTriggers(collectionId, triggers, options = {}) {
    const update = { triggers };
    if (options.matchMode !== undefined) update.triggerMatchMode = options.matchMode;
    if (options.caseSensitive !== undefined) update.triggerCaseSensitive = options.caseSensitive;
    if (options.scanDepth !== undefined) update.triggerScanDepth = options.scanDepth;
    setCollectionMeta(collectionId, update);
}

/**
 * Gets activation triggers for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} { triggers, matchMode, caseSensitive, scanDepth }
 */
export function getCollectionTriggers(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return {
        triggers: meta.triggers || [],
        matchMode: meta.triggerMatchMode || 'any',
        caseSensitive: meta.triggerCaseSensitive || false,
        scanDepth: meta.triggerScanDepth || 5,
    };
}

/**
 * Gets a summary of a collection's activation settings
 * @param {string} collectionId Collection identifier
 * @returns {object} Summary of activation state
 */
export function getCollectionActivationSummary(collectionId) {
    const meta = getCollectionMeta(collectionId);
    const triggers = meta.triggers || [];
    const hasConditions = meta.conditions?.enabled && meta.conditions?.rules?.length > 0;

    let mode = 'auto'; // No triggers, no conditions = auto-activate
    if (triggers.length > 0) {
        mode = 'triggers';
    } else if (hasConditions) {
        mode = 'conditions';
    }

    return {
        mode,
        triggerCount: triggers.length,
        conditionCount: meta.conditions?.rules?.length || 0,
        conditionsEnabled: hasConditions,
    };
}

// ============================================================================
// ADVANCED CONDITIONS HELPERS
// ============================================================================

/**
 * Sets conditions for a collection
 * @param {string} collectionId Collection identifier
 * @param {object} conditions Conditions object { enabled, logic, rules }
 */
export function setCollectionConditions(collectionId, conditions) {
    setCollectionMeta(collectionId, { conditions });
}

/**
 * Gets conditions for a collection
 * @param {string} collectionId Collection identifier
 * @returns {object} Conditions object
 */
export function getCollectionConditions(collectionId) {
    const meta = getCollectionMeta(collectionId);
    return meta.conditions || { enabled: false, logic: 'AND', rules: [] };
}

