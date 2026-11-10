# Domain Docs — VectCookie

How the engineering skills consume this repo's domain documentation.

## Before exploring, read these

- `docs/adr/` — decisions that touch the area you are about to change.
- When this checkout is the VectCookie child of the ST-Integration workspace,
  the workspace root's glossary and integration reference are authoritative for
  cross-extension vocabulary (worker route, quiet generation, VectFox block).
  They are not part of this repository, so a standalone clone simply proceeds
  without them.
- `../../CODING_STANDARDS.md` for module boundaries and the review protocol.

If a referenced file does not exist in a standalone checkout, proceed
silently. Don't flag its absence.

## Vocabulary

Use the glossary's terms when output names a domain concept (issue title,
refactor proposal, hypothesis, test name). Don't drift to synonyms the
glossary explicitly avoids.

If the concept you need isn't in the glossary, that's a signal: either you are
inventing language the project doesn't use (reconsider) or there is a real gap
(note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than
silently overriding:

> _Contradicts ADR-0001 (defer complex RAG patterns), but worth reopening
> because…_
