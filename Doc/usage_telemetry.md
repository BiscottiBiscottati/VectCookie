# Usage telemetry

The **Usage** tab records every chat-completion request this browser makes and shows what the provider reported for it: prompt, cached (hit), missed, cache-write, completion and reasoning tokens, cost, and cache saving. It exists to answer the question ghost batching raises — **is the stable prompt prefix actually served from cache, and what does that save?**

The feature is **off by default**, **observe-only** and **local**:

- It wraps `fetch` once while tracking is on. It never changes a request, a prompt or the response SillyTavern consumes, never delays a response, and never throws into SillyTavern.
- It makes no network calls of its own, adds no timers and no polling.
- It stores no prompt text and no API keys — only counts, hashes, provider/model, origin and the ghosting configuration.
- Per-chat records live inside the chat file and are deleted with the chat.

It observes **chat-completion requests only**. Embedding and text-completion calls are not recorded: embeddings run server-side and expose no usage to the browser.

---

## Enabling it

1. Open VectFox settings and switch to the **Usage** tab.
2. Tick **Track token usage**.
3. Send a reply. The request appears once the response has settled.

The health line above the cards tells these states apart, so an empty table is never ambiguous:

| Health line | Meaning |
| --- | --- |
| `Tracking is off — the observer is not installed.` | The feature is disabled; nothing is captured. |
| `Observer installed — no requests captured yet.` | Tracking is on; the next chat completion will be recorded. |
| `Observer installed — N requests captured, M skipped.` | Working. Skipped requests could not be read (for example a `Request` object or a non-string body). |
| `Observer error — N capture attempts failed.` | Something failed inside capture; rows may be missing. Sending another reply is safe. |

Tracking installs immediately when you tick the box — no page reload. Turning it off leaves the wrapper in place as a pass-through, because another extension may have wrapped `fetch` after VectFox and unwrapping would drop that layer.

---

## Origins

Every request is labelled with the kind of work that caused it. The split is what stops a background job from polluting the story reply's cache rate.

| Origin label | What it is |
| --- | --- |
| `story` | A generation whose reply is posted as a chat message — normal replies, swipes, regenerates, continues and impersonates included. A quiet generation whose result is posted (`quietToLoud`) also counts as story. |
| `quiet` | A quiet generation whose result is handed back to the caller. |
| `worker` | A request outside any SillyTavern generation, such as a background-worker job over its own connection profile. The label is deliberately generic; the tab does not name the extension that sends it. |
| `VectFox · <feature>` | One of VectFox's own LLM calls — EventBase extraction, reformat and Agent Mode planning are the usual labels. |
| `unknown` | The request could not be attributed confidently. |

Dry-run generations are ignored. VectFox's own calls are marked **on the request itself**, so an extraction that overlaps the next story turn cannot relabel that reply as internal — each request carries its own attribution.

---

## Reading the numbers

### The request table

Newest first. Each row is one observed request:

| Column | Meaning |
| --- | --- |
| **Time** | When the request was sent. |
| **Origin** | The label from the table above. |
| **Provider / model** | The provider and model the request reported. |
| **Prompt** | Provider-reported prompt tokens. A leading `~` means this number is an estimate, not a measurement. |
| **Hit** | Provider-reported cached prompt tokens. |
| **Hit %** | Hit divided by prompt for this request. Empty when the provider reported no usage. |
| **Miss** | Provider-reported uncached prompt tokens (or prompt minus hit when the provider reports no miss count). |
| **Total** | The provider's `total_tokens` when present, otherwise prompt + completion. |
| **Cost** | Provider-reported cost, or the price-table estimate, or `unavailable`. |
| **Saving** | The cache saving: the provider's reported cache discount when it supplies one, otherwise `(miss price − hit price) × hit tokens` from the price table. Output is never part of saving. |
| **Shared prefix** | How many tokens this prompt shares from the start with the previous **comparable** request. Estimated with SillyTavern's tokenizer, never from the provider. Empty (`—`) when there is no comparable prior request. |
| **Possible prefix breaker** | Shown when the provider reports **zero** cached tokens and the shared prefix is at least **2,048 tokens** — the prompt looked stable, but caching did not happen. |
| **Source** | `measured`, `estimated` or `unavailable`. |

Failed and aborted requests are kept as rows so the attempt is visible, but they are excluded from the hit-rate denominator. An aborted stream has no terminal usage, so it cannot contribute one.

### The cards

The first card (**All requests**) covers the open chat. One card follows for each origin present, so you can read the story reply and the background worker separately. The **All time · all chats** card sits above the run bar and aggregates every chat.

Each card shows:

- **Prompt** — measured prompt tokens, plus `~estimated` when some rows had no usage.
- **Hit** — cached prompt tokens.
- **Hit %** — token-weighted: cache-hit tokens divided by provider-reported prompt tokens. Percentages are never averaged, so a hundred tiny cached requests cannot outvote one large uncached prompt.
- **Coverage** — the share of prompt tokens the provider actually reported. Estimated prompt tokens count as uncovered. Coverage is also capped by the share of completed requests that had a token count, so an unestimated row cannot leave coverage at 100%.
- **Cost** — provider-reported cost, or the price-table estimate.
- **Saving** — cache saving, computed as described above.

**Measured** means the provider reported the number. **Estimated** means only prompt tokens were inferred with SillyTavern's tokenizer. **Unavailable** means neither is possible — it is never displayed as zero. Cache hit is *never* estimated: an endpoint that omits usage cannot produce a hit rate.

### Measurement runs

A run is a labelled marker stored per chat. Records captured after **Start new measurement** carry that run's id; earlier runs stay available. Requests captured before the first run stay under **All runs**.

- The run selector filters the cards, the configuration table and the request rows to one run. It still lists every old run.
- Starting a run does not delete anything. It is the cheap way to keep a before/after comparison honest.
- Runs are per chat, not global.

### By configuration

The **By configuration** table groups requests by ghosting state, batch size and keep-recent, and shows requests, average prompt, hit %, cost per request and saving for each group. That is the direct batch-size-1 versus batch-size-30 comparison: set a run at one batch size, then another at the other, and compare the two rows.

Cost per request is divided only by the requests that had a price, so a group with unpriced rows does not report a misleadingly low per-request cost.

---

## Price table

The price table supplies cost and saving **only when the provider does not report them**. Prices are per million tokens, for hit, miss, output and cache write, with a currency label and a "prices updated" date.

- A reported provider cost always wins over the table.
- A model with no price row shows cost and saving as `unavailable`, never `$0.00`.
- The seeded row is a DeepSeek example. **Set the model name to the exact model your provider reports** — the seeded row says `deepseek-v4-flash`, and a chat using `deepseek-flash` will not match it until you edit or add the row. The model string is what the request body carries, not a display name.
- Saving uses `miss − hit` for the saving rate; output pricing affects cost but never saving, because caching does not change output tokens.
- OpenRouter costs are reported in credits and shown as reported; the tab does not convert currency.

No price is fetched from the network automatically.

---

## Export and reset

**Export JSON** downloads a `version: 1`, `kind: "vectfox-usage-export"` file containing:

- `records` — the open chat's retained requests (newest 500), projected through an explicit field allowlist.
- `runs` and `currentRunId`.
- `aggregates.archived` — the counters for rows the 500-record cap evicted, so totals after eviction are still explainable.
- `aggregates.retention` — the cap, how many rows are retained and the total seen.
- `aggregates.allTime.totals` and `aggregates.allTime.chats` — the cross-chat totals and one bucket per chat.
- `currentPrices` — the price table in force at export time.

The export contains **no prompt text, no message content and no API keys**. It is a projection, not a dump: unknown fields are simply not published. Nothing is uploaded anywhere.

**Reset this chat** deletes the open chat's requests, its measurement runs and its all-time contribution, after a confirmation. Other chats are untouched. Because SillyTavern can resolve a metadata save that failed, the reset also stages an empty pending revision so a stale chat file cannot restore the rows on the next open.

**Reset all-time totals** clears only the cross-chat totals and buckets, after a confirmation. Every chat keeps its own request rows.

### Where the records live

- The newest **500** records per chat are stored in `chat_metadata.vectfox_usage` (versioned namespace). Older rows are folded into `archived` counters without the older rows themselves, so counts stay correct while storage stays bounded.
- All-time counters live in `localStorage.vectfox_usage_alltime` as totals plus one bucket per chat.
- Deleting a chat removes its bucket from the all-time totals. Renaming a chat moves the bucket to the new name.
- A branched or manually copied chat starts with a clean table: the namespace records its owner chat id, and a copy whose owner differs is discarded.
- A chat deleted from another browser or device cannot be reconciled here; use **Reset this chat** locally.

---

## Measurement recipe: does batching pay?

The recipe the feature was built for:

1. Turn tracking on. Set the ghost batch size you want to compare first (for example **1**).
2. Send one warm-up reply, then click **Start new measurement**. The first turn of any run is cold; a warm-up keeps it out of the comparison.
3. Send the number of replies you want to compare — 20 is a reasonable sample.
4. Change the batch size (for example to **30**), click **Start new measurement** again and send the same number of replies.
5. In **By configuration**, compare the two rows: requests, average prompt, hit %, cost per request and saving.
6. If you can, check the same window against the provider's usage page. Record the provider, model, date and any price-table edit, so the numbers stay reproducible.

Notes that matter for a fair comparison:

- Provider caches are **best-effort** and expire after hours to days. A long pause between the runs can cold-start the second one.
- Hit counts are **quantised** by providers (commonly 128-token blocks), so the reported hit is slightly below the theoretical prefix.
- DeepSeek's cache units require a **full-prefix match** and take seconds to persist; the first turns after a change are misses.
- The first turn or two of each run are cold. A warm-up reply before starting the run is the simplest fix.

---

## Provider notes

| Provider | What the tab can show |
| --- | --- |
| **DeepSeek** | Measured hit/miss/completion from `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens` and `usage`. Cost and saving come from the price table. Streaming works: usage arrives in the terminal chunk. |
| **OpenRouter** | Measured cached tokens from `prompt_tokens_details.cached_tokens`, plus cache-write tokens when present. Cost is reported in credits and shown as reported. With a **BYOK** key, OpenRouter can report `cost: 0` even though the upstream provider bills you — the row then shows `$0.00 reported` and the provider dashboard is the source of truth. |
| **Generic OpenAI-compatible** | `prompt_tokens_details.cached_tokens` when present; otherwise cache hit is unavailable. Prompt tokens may still be estimated. |
| **Custom endpoint that omits usage** | Estimated prompt size (marked `~`), cache hit and cost unavailable. No hit rate is possible. |
| **Anthropic / Gemini native handlers** | Not supported in v1 — their SillyTavern handlers drop usage for non-streamed responses and use provider-specific streaming frames. |

Embedding usage is out of scope: embeddings are executed server-side and expose no usage to the extension.

---

## Known prefix breakers

These are the usual reasons a long shared prefix still reports a zero cache hit. The help block repeats the short list:

- `{{time}}` or `{{date}}` macros early in the prompt.
- Keyword-triggered World Info entries that appear before or after the character card.
- Author's Note, character depth prompts, and World Info entries at depth.
- Per-collection injection overrides that move VectFox blocks.
- A SillyTavern context budget small enough to trim the oldest message every turn.

The **Shared prefix** column tells you whether the prompt was stable; **Possible prefix breaker** tells you the provider cached nothing anyway. That pair is enough to know where to look next.

---

## Troubleshooting

**The tab is empty.** Check the health line. If it says tracking is off, tick **Track token usage**. If it says installed with no requests, send a reply — the row appears after the response settles.

**Rows appear but hit % is `—`.** The provider did not report cache usage for those requests. A custom endpoint that drops `usage` cannot produce a hit rate; the prompt size may still be estimated.

**Cost is `unavailable`.** The provider did not report a cost and the price table has no row for that provider and model. Add one, using the exact model string the request carries.

**Cost shows `$0.00 reported` on OpenRouter.** That is the BYOK case: OpenRouter reports zero while the upstream provider bills you. Use the upstream dashboard for the real spend, or add a price row if you want the tab to estimate it.

**A "Possible prefix breaker" appears on every turn.** Something near the top of the prompt changes every turn. Check the breakers list above, starting with `{{time}}`/`{{date}}` and keyword-triggered World Info.

**Records disappeared.** Each chat keeps its newest 500 rows; older rows still count in the cards and in the export's archived aggregates but no longer have row detail. Deleting the chat, resetting, or opening a branch also clears or separates records by design.

**Tracking was on, but a request is missing.** Look for `skipped` in the health line: a request whose body is a `Request` object or a non-string body cannot be read. The observer never blocks or alters such a request; it just cannot record it.
