# Coding standards — VectCookie

Read during review. Mechanical rules belong in an automated check (`npm run
check` is the current one); this file is for the judgement calls a check cannot
make.

## Module boundaries

- `index.js` is wiring: settings, event registration and calls into modules.
  Computation, parsing and normalization live in `core/` or `ui/`.
- Pure maths and aggregation are plain modules with no DOM, storage or observer
  state; the UI consumes them.
- One owner per persisted shape: the module that defines a settings, chat or
  localStorage shape also normalizes it. Callers pass the normalized value.
- The usage observer stays read-only and off the response path.

## UI

- Keep the view model (pure labels and numbers) separate from rendering.
- One definition per CSS class. Shared state classes (`measured`, `estimated`,
  `unavailable`) have one source rule.
- Edits that only change computed results update those results in place; do not
  rebuild an editor under the user's focus.

## Tests

- Test behaviour at the approved seams; assert what the caller, ledger or view
  model observes, not private helpers.
- Keep fixtures local to the test file unless three or more files need them.
- For each acceptance bullet, cover the boundary matrix: measured / estimated /
  unavailable, empty / one / many, and the UI surfaces the bullet names.
- For a destructive state transition, cover repeated invocation, a persistence
  failure, and scope isolation. A reset that works once is not a reset.

## Review protocol

- Freeze the working tree before spawning reviewers; do not edit while they run.
- Review from the diff artifact you were handed: page it with the read tool
  instead of re-running `git diff` slice by slice. The artifact already holds
  the whole change, untracked files included.
- Wait for the completion notification instead of polling.
- Apply findings, then re-review the delta before committing.
- A finding that is mechanical (JSDoc arity, duplicate selector) should become a
  check, not prose in this file.
