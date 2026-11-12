# 3. Chunk Metadata Lives in the Chunk Payload

Date: 2026-11-11

## Status

Accepted

## Context

Every chunk's metadata (keywords, activation conditions, prompt context, links,
parent hash) was persisted into `extension_settings.vectfox` under a
`vectfox_chunk_meta_<hash>` key. On a real library that reached **17,104 keys /
9.45 MiB**, making `settings.json` 47.3 MiB decoded; it was downloaded twice and
re-uploaded twice (12.5 MiB each) per page load, and every metadata edit re-sent
the whole blob.

The write was added for a real reason: without the Similharity plugin,
SillyTavern's native `/api/vector/insert` stores only `{hash, text, index}`, so
settings was the only place keywords could live. But on the plugin path the same
keywords are **already** written into the payload by `backends/qdrant.js`
(`metadata.keywords`, `conditions`, `parentHash`, `importance`). Settings held a
second copy, and nothing ever deleted entries when a collection was purged.

Relevant properties of the storage that shaped this decision:

- Both backends expose a metadata-only update through the plugin
  (`PATCH /chunks/:hash/metadata`): qdrant via native point payload, vectra via
  delete + re-upsert preserving `hash`/`text`.
- `/chunks/list` returns each chunk's `metadata` for both backends, so a client
  can hydrate from the store alone.
- Chunk hashes are content-derived (`getStringHash(chunk.text)`) and are **not**
  collection-scoped, so one settings key currently serves every collection that
  contains the same text.
- `core/chat-vectorization.js` already states the intent: *"Backend payload is
  source of truth; ext_settings is the legacy fallback."*

## Decision

1. **The chunk payload is the source of truth** wherever the plugin is present,
   for both backends. `extension_settings` becomes a legacy read fallback and the
   primary store only for installs without the plugin.
2. **`chunk_meta_store: 'auto'`** — payload when the plugin is available,
   settings otherwise. A no-plugin install behaves exactly as before.
3. **The public functions stay synchronous.** `getChunkMetadata`,
   `saveChunkMetadata`, `deleteChunkMetadata` keep their signatures; an in-memory
   mirror hydrated lazily per collection backs them, and only the layer behind
   them is asynchronous.
4. **Metadata becomes per-collection.** The same text in two collections no
   longer shares one metadata entry; cross-collection coupling was an artifact of
   the settings namespace, not a feature.
5. **A failed payload write falls back to a settings write** plus a bounded retry
   queue, so an outage degrades to today's behaviour instead of losing an edit.
6. **Migration is staged**: automatic dry-run and shadow dual-writes in the
   release that ships the migration, then a single explicit sweep that deletes
   the settings copies. Orphans (entries whose chunk exists in no registered
   collection) are reported and deleted only on explicit confirmation. The
   dual-write is a rehearsal-window device, not the end state: the release after
   it stops writing the settings copy altogether, so an edit costs one payload
   write and no settings upload (only client-only fields still reach settings).
7. **Hydration is lazy**, per collection, so the fix cannot reintroduce a startup
   stall through a different endpoint.
8. **A hash-only caller resolves the collection through one "current collection"
   pointer.** The four public functions keep their hash-only signatures, so the
   store — not the caller — decides which collection a read or write belongs to.
   Opening a collection in the metadata UI makes it current and starts its
   hydration; bulk paths (import, keyword persistence) clear it. Reads and writes
   are scoped to the current collection, and with none current they fall back to
   the legacy settings entry instead of searching other collections' mirrors.
   Retrieval deliberately does not make a collection current: its query results
   already carry payload metadata, and a listing there would move the startup
   stall to the first generation. A caller that spans collections (retrieval,
   export) must use an explicit collection-scoped read when it needs the payload.

## Considered Options

- **Keep settings, add garbage collection only.** Cheapest to ship, but leaves
  every metadata edit round-tripping the full settings blob and leaves the
  duplicate copy in place. Rejected: it treats the symptom that was measured,
  not the cause.
- **Payload only, no settings path.** Cleanest data model, but breaks VectCookie
  standalone, which the integration rules forbid. Rejected.
- **Write-through settings first, payload as a mirror.** Preserves the blob and
  its upload cost as the steady state. Rejected.

## Consequences

- **The store, the transport and the `auto` policy ship first**, with hydrate-on-use
  and per-field merged reads; the sweep (decision 6) and the bounded retry half of
  decision 5 land in later changes. The rehearsal dual-write ends with the write-path
  change: a payload-path save writes no settings copy (only client-only fields such
  as `summaries` still reach settings), and a failed payload write persists the
  refused fields to settings instead of losing the edit — the bounded retry that
  repairs the payload and drops that copy comes later.
- **Three behaviour changes to announce**: per-collection metadata (no more
  cross-collection sharing), a chunk edit no longer triggering a full settings
  upload on the plugin path, and — after the sweep — downgrading to an older
  VectCookie losing per-chunk metadata, since the settings copy is gone. Forward
  compatibility was covered by the shadow window of the release that shipped the
  migration; the write-path change ends it.
- **The 9.45 MiB only shrinks at the sweep**, and only for entries that are
  redundant or explicitly deleted as orphans. Growth stops immediately for edits
  and for newly vectorized content because those writes no longer mint settings
  keys. Import/export routing is a separate change: until it lands, importing a
  collection still mints one settings key per imported chunk.
- **`orphan` must mean absent from every registered collection**, never from the
  collection currently loaded: content-derived hashes mean one key can be
  referenced by several collections.
- **A stuck retry queue re-inflates settings**, so its depth must be visible in
  the Size Inspector alongside the settings size.
- **The mirror is a read cache, not a second store**: any disagreement resolves
  payload-first per field, settings filling gaps, until the sweep removes the
  settings side.
- **Hash-only reads outside a current collection see only settings.** That is the
  deliberate cost of keeping the public functions synchronous and unchanged: the
  retrieval and export fallbacks do not borrow an open collection's payload
  entry, and they gain an explicit collection-scoped read in a later change.
