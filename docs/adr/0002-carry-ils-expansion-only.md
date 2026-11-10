# 2. Carry ILS Expansion as the Fork's Only Upstream Divergence

Date: 2026-11-10

## Status

Accepted

## Context

This repository is a personal fork of [KritBlade/VectFox](https://github.com/KritBlade/VectFox). It is not a source of pull requests: upstream work is pulled *down*, and local work is never sent up. That makes every commit we carry a permanent maintenance cost, because each upstream sync is a `rebase` that must re-resolve any file we have touched.

The fork started life as a clone of a *fork* of VectFox and accumulated 14 commits (13 behind / 14 ahead) whose base was the `3.6.13` merge. Two authors contributed: `zrochler` (Zach) with 7 commits, and this fork's owner with 3. The history contained 3 merge commits, one of which was an "evil merge" whose tree differed from a clean merge because it hand-resolved committed conflict markers — it was dropped deliberately, after verifying both merged-in sides (`886a014`, `690d386`) were already ancestors of `upstream/main`, so no content was lost. Applying the remainder onto upstream (`2a5e61f`, 3.6.17) produced 5 conflicts, none of which were genuine disagreements: they were **June commits being forward-ported onto October code**.

Zach's 7 commits (+295/−47) implemented three things:

1. **ILS expansion** — `core/ils-expander.js`, expanding InlineSummary ("ILS") summary messages back into their original messages so EventBase extraction and semantic World Info vectorize real content rather than summary text. Supports two storage layouts (legacy `msg.extra.ILS_Data.OriginalMessages`, and ref-based `chat_metadata.ILS_Originals[Ref]`). Upstream has **no** support for this at all.
2. **Auto-sync trailing gap** — a second "hold back the tail" mechanism (`eventbase_autosync_tail_lag_messages`, default 0), plus a `core/eventbase-workflow-utils.js` module created to hold it.
3. **Removal of the `modules` dependency** — deleting `import { modules }` and the `extras_module_missing` guard from `throwIfSourceInvalid` in `core/core-vector-api.js`. This is the only one of the seven that *deletes* upstream behaviour.

Removing all seven was tested empirically and is not breaking: the owner's 3 commits cherry-pick onto `upstream/main` with zero conflicts and 1042 tests pass.

## Decision

**Carry ILS expansion only.** Specifically:

1. **Keep ILS expansion** (`ILS Expansion`, `Fix ILS Expansion`) — the sole functional divergence from upstream. It is additive, pure, and a no-op when no InlineSummary messages are present.
2. **Do not carry the auto-sync trailing gap.** It duplicates a concept upstream already has: `eventbase_autosync_settle_lag` holds back the active turn via `getCommitBoundary`. The two compose rather than replace (tail truncation runs first, then `getCommitBoundary` runs on the truncated array), so keeping both would leave two settings meaning nearly the same thing with an ill-defined interaction. With it go `core/eventbase-workflow-utils.js`, the settings default, the UI slider, and its tests.
3. **Keep upstream's `modules` / `extras` guard.** SillyTavern still exports `modules` (`public/scripts/extensions.js`), so the import was never broken; removing the guard only delayed a clear `extras_module_missing` error into something vaguer. Upstream keeps it, so we keep it.
4. **Do not keep `getAutoSyncWindowSize` extracted into a utils module.** Upstream defines it inline in `core/eventbase-workflow.js`; the extraction existed only to serve the trailing gap and was a conflict magnifier. `eventbase-workflow.js` is back to upstream's structure.
5. **Sync by rebase, not merge, and force-push.** This fork's `main` is rewritten history by design.

## Consequences

- **The trim cut this fork's footprint sharply.** Removing the trailing gap took the fork's own divergence from 27 files / +909 to 11 files / +557. That figure still describes the ILS + ghosting + lorebook work; total divergence is larger today (47 files / +11,052 as of 2026-11-11) because the separate usage-telemetry feature landed on top. The two upstream hotspots stay protected: `core/core-vector-api.js` is **untouched**, and `core/eventbase-workflow.js` diverges by 11 lines instead of 44.
- **Conflict surface is 14 upstream files**: `.gitignore`, `README.md`, `core/chat-vectorization.js`, `core/conditional-activation.js`, `core/eventbase-workflow.js`, `core/llm-provider-call.js`, `core/summarizer-injection.js`, `core/world-info-integration.js`, `index.js`, `package.json`, `tests/llm-provider-call.test.js`, `tests/world-info-integration.test.js`, `ui/ui-manager.js`, `vectfox.css`. Expect conflicts in the ILS call sites when upstream edits those files.
- **ILS coverage.** `tests/ils-expander.test.js` covers the single public seam, `expandILSMessages`: pass-through chats, both storage formats (inline `OriginalMessages`, and `chat_metadata.ILS_Originals[Ref]`), ILS data stored directly on the message, dangling refs, originals with no text, nested summaries, and the 64-layer recursion cap including a cyclic chain. It was validated by mutation — forcing summary detection off, shrinking the cap to 8, or dropping the on-message path each makes it fail — so a bad conflict resolution during a future rebase surfaces as a red test rather than a silent behaviour change.
- **The dropped work is recorded here so it is not re-added by accident.** If a future sync "restores" the trailing-gap slider or the `modules` removal, that is a regression against this decision, not a fix.

### Staying in sync

```bash
git fetch upstream
git rebase upstream/main
# resolve conflicts; prefer upstream's structure, keep the ILS call sites
npm run check             # syntax + doc pointers + full unit suite, all green
git push --force-with-lease origin main
```

Recovery refs: `backup/pre-sync-main` is the original 14-commit history (also pushed to `origin`); `backup/full-carried-main` is the state after the rebase but before this trim (local only). Both are disposable once the trimmed history is trusted.

### Note on where this file lives

This ADR lives in the **tracked** `docs/adr/` tree, and must be committed alongside the code it describes. That is a reversal of what this record originally said, and the reversal is worth keeping because it is easy to get wrong: `docs/` used to be gitignored by upstream's own `.gitignore`, and ADR-0001 sat untracked as local-only state. The doc-tracking convention has since been turned around — `.scratch/` is now the gitignored local area, while `AGENTS.md`, `CODING_STANDARDS.md`, `docs/agents/` and `docs/adr/` are tracked, and `scripts/check-docs.mjs` (run by `npm run check`) fails any agent doc that points at a gitignored path. A future session that re-reads only the old state could easily leave a new ADR untracked, where a fresh clone and GitHub would never see it.
