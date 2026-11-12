# Release note: chunk metadata moves into the collection

Per-chunk metadata — the context text, conditions, links, keyword list, XML tag,
position — used to be stored *twice*: in the collection's chunk payload (by the
Similharity plugin) and in SillyTavern's settings object, under one
`vectfox_chunk_meta_<hash>` key per chunk. On a large library that second copy
grew to **17,104 keys / 9.45 MiB**, made the settings object 47.3 MiB, and was
re-sent in full every time anything saved settings.

On the plugin path the collection's copy becomes the copy that counts. Three
things change with it. They are deliberate, not regressions.

## 1. Editing a chunk no longer uploads your settings

With the Similharity plugin installed, editing a chunk's context, conditions,
links or keywords is one write to that chunk and nothing else: one metadata
`PATCH`, no settings save, no settings key. Vectorizing new content writes
nothing to settings either — the plugin stored each chunk's keywords with the
chunk, so the old bulk copy is gone. Measured on the integration sandbox: one
`PATCH` and zero `settings/save` requests per edit, and zero new
`vectfox_chunk_meta_*` keys for a freshly vectorized document. Repeating the same
six-chunk vectorization on the previous build minted six keys and re-sent the
settings object.

What that sentence does not cover, stated plainly:

- A **dual-vector summary** edit still writes settings, because summaries have no
  payload field to live in. It writes that one field rather than a copy of the
  chunk's payload metadata, but that edit does issue a settings save.
- A **failed** payload write falls back to a settings write, so the edit is not
  lost: it is held in settings and survives a reload. That edit also issues a
  settings save, and until the payload accepts the write again an existing
  payload value still wins the read, so the field keeps showing what the
  collection last held. The extension then retries the payload write
  automatically; when it succeeds, the settings copy it superseded is removed.
  A repair that cannot get through is retried a few times with backoff, then waits
  for the next page load, where it is rebuilt from the record and the payload's
  actual contents — a field the payload already holds is not written again.
  Repairs pause while the plugin is unreachable or the store is rolled back to
  settings, and a fallback field two collections both have pending stays until
  the second repair lands. The queue is bounded at 100 repairs and its depth is
  shown in the Size Inspector. At the cap the oldest repair is dropped with a
  warning rather than silently: its edit stays in settings until the sweep moves
  it.
- **Importing** a collection still writes its chunk metadata to settings until
  the import/export parity work lands.
- If this browser's plugin probe is stale — the plugin was installed mid-session
  and the backend still holds its "not available" snapshot — an insert can take
  the native path that cannot store keywords. Without the plugin those keywords
  are lost anyway; this removes the settings copy that used to catch them.

Without the plugin, nothing changes: chunk metadata still lives in settings,
exactly as before, and vectorizing still persists keywords there.

## 2. Chunk metadata belongs to one collection

The settings store keyed metadata by chunk text hash, so the same text in two
collections shared one entry and editing it in one collection silently changed
the other. Metadata is now stored with the chunk in its own collection, so the
two are independent. A chunk that appears in two collections must be edited in
each.

## 3. Your existing chunk metadata is migrated by you, once

Nothing is moved automatically on upgrade. Open the Size Inspector for a dry run
that counts what is redundant, what needs patching and what is orphaned; download
a backup if you want one; then run the sweep — one button, one save. Until you
run it, the old settings entries are left exactly where they are, and the app
keeps working from the payload plus those entries. The 9.45 MiB only shrinks at
that sweep; what changes immediately is that an edit and newly vectorized content
stop adding entries to it.

**Do not downgrade to an older VectCookie build.** Since this release, chunk
metadata edits are written to the collection only, and an older build reads them
from settings. Anything you edit after upgrading would look unchanged to it, and
after the sweep everything would look empty — even though it is all still in your
collections. Going forward again restores it.

## Rolling back

Set `chunk_meta_store` to `settings` in VectCookie's settings (or in
`settings.json` under `extension_settings.vectfox`) to restore the previous write
behaviour without redeploying: chunk-metadata saves and the keyword save after
vectorizing go to settings again, and stop writing the collection payload. The
setting is honoured immediately in the open tab.

The chunk visualizer and retrieval still show each chunk's collection metadata,
because they read it from the collection itself. A reader that only has a chunk
hash — collection export and import — sees settings alone while this policy is
set, which is the parity work still outstanding; it does not change what you see
in the chunk list.

The rehearsal release's `chunk_meta_shadow` switch is retired: with the settings
copy gone there is nothing left for it to keep in sync, and it is not read any
more.

## What did not change

- Collections, vectors, embeddings, EventBase, retrieval, Agent Mode, summarizer
  injection: untouched.
- Export and import keep carrying per-chunk metadata.
- Installs without the Similharity plugin: byte-identical behaviour, settings only.

Measured baseline and post-fix numbers: `docs/perf/chunk-meta-write-path.md` in
the integration workspace, beside the pre-fix cost in
`docs/perf/real-server-har.md`.
