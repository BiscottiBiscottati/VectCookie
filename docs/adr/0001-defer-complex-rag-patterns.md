# 1. Defer Complex RAG Retrieval Patterns

Date: 2026-09-28

## Status

Accepted

## Context

During a full-pipeline audit of the EventBase ingestion and retrieval stack, several "textbook" advanced RAG patterns were considered as potential improvements:
1.  **Cross-encoder/LLM relevance-filter reranking** on the final shortlist.
2.  **Adaptive/semantic window boundaries** for extraction (vs. fixed-size overlapping windows).
3.  **Multi-vector / field-specific embeddings and HyDE.**

Although these are standard capabilities in general enterprise RAG architectures, we need to evaluate whether they provide enough precision improvement to justify their cost in latency, complexity, and LLM API calls in a roleplay context.

## Decision

We have decided to **skip implementing these advanced techniques** for now:

1.  **Skip cross-encoder relevance filtering.** The system already relies on a robust formula rerank (cosine + importance + persist + recency) that is tuned well. An additional LLM-based reranking pass adds latency and cost for marginal precision gains. Furthermore, this is largely redundant with what Agent Mode already does (multi-angle query planning and payload filtering). This shouldn't be reconsidered unless Agent Mode is judged insufficient even after entity canonicalization and state tracking are added.
2.  **Skip adaptive/semantic window boundaries.** The existing pattern of allowing "0, 1, or many events per window" to be extracted inherently absorbs much of the harm caused by fixed-size overlapping windows. Reliable scene-boundary detection is non-trivial, and pushing for it would yield diminishing returns for high complexity.
3.  **Skip multi-vector embeddings and HyDE.** The current hybrid dense + sparse (BM25) search adequately covers the keyword-miss failure modes that HyDE and multi-vector approaches typically solve. 

## Consequences

-   **Performance:** We preserve lower latency and cost by avoiding unnecessary LLM calls during the retrieval cycle.
-   **Simplicity:** The retrieval and ingestion orchestration logic remains relatively clean without the overhead of semantic scene-chunking or multi-step LLM reranking loops. 
-   **Focus:** The engineering effort can be routed to higher-impact RP-specific problems (like persistent state and entity canonicalization).
