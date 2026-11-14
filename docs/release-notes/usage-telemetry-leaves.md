# Release note: usage telemetry leaves VectFox

The **Usage** tab is gone from VectFox, and with it the page-lifetime `fetch`
observer, the ledger, the price table, the export and their settings keys. The
extension you install for retrieval no longer carries roughly 4,500 lines of
accounting it did not need, and nothing about retrieval changed.

Token, cache and cost accounting now lives in
**[Spendbook](https://github.com/BiscottiBiscottati/Spendbook)** — a standalone,
MIT extension that watches chat-completion traffic on its own. Install it beside
VectFox, or without VectFox at all; it needs no vector backend and no other
extension.

## Your old numbers are still there

Nothing was deleted from your chats or your settings. The old per-chat records
stay in `chat_metadata.vectfox_usage` in each chat file, and the old price table
stays in `extension_settings.vectfox.usage_prices`, so switching back to VectFox
3.6.18 still finds the ledger it wrote. Spendbook offers an explicit import for
the **open chat** — records, runs, folded-row counters and prices — that keeps
the originals in place; open a chat, click import, and repeat per chat if you
want them all.

## The one line VectFox keeps

VectFox's own LLM calls still write Spendbook's documented internal mark onto
their request init — `Symbol.for('spendbook.internal-request')`, value
`{ label }` — so an extraction, reformat or planner call is recorded as
Spendbook's `internal` with its feature label rather than as the story reply.
That is a hand-written symbol property: no import, no dependency entry and no
runtime link in either direction. With Spendbook absent, the mark is written and
ignored, and VectFox loads and generates exactly as before.

If a chat's old ledger stays unimported, nothing breaks: the records sit in the
chat file untouched and are simply not shown anywhere until imported.
