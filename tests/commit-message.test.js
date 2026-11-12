/**
 * Commit-message convention — the validator behind `.githooks/commit-msg`.
 *
 * Commit messages are written with the `caveman-commit` skill; this hook is the
 * deterministic half of that rule, so a forgotten skill fails the commit instead
 * of silently drifting. The convention is Conventional Commits: a known type,
 * an optional scope, an imperative summary under 72 characters, no trailing
 * period. Git's own merge, revert and fixup subjects pass through.
 *
 * Seam: `validateCommitMessage()` on the raw message text the hook reads.
 */

import { describe, it, expect } from 'vitest';

import { validateCommitMessage } from '../scripts/check-commit-msg.mjs';

describe('commit message — accepted', () => {
    it.each([
        'feat(chunk-meta): add backup download',
        'fix: remove stale status',
        'docs(adr): record the decision',
        'refactor(storage): move the label',
        'perf(sweep): page collections once',
        'test(size-inspector): cover the backup button',
        'chore(hooks): install the commit-msg hook',
        'build: pin node 22',
        'ci: run check on pull requests',
        'style(ui): escape the status line',
        'revert: undo the download helper',
        'feat(api)!: rename the chunk endpoint',
    ])('accepts %s', (message) => {
        expect(validateCommitMessage(message)).toMatchObject({ ok: true, subject: message });
    });

    it('reads the subject past git comment lines and the verbose-diff scissors', () => {
        const message = [
            'feat: add the commit hook',
            '# Please enter the commit message for your changes.',
            '# Lines starting with # will be ignored.',
            '------------------------ >8 ------------------------',
            'diff --git a/x b/x',
        ].join('\n');

        expect(validateCommitMessage(message)).toMatchObject({
            ok: true,
            subject: 'feat: add the commit hook',
        });
    });

    it.each([
        "Merge branch 'main' into feature",
        'Merge pull request #4 from example/topic',
        'Revert "feat: add the commit hook"',
        'fixup! feat: add the commit hook',
        'squash! feat: add the commit hook',
        'amend! feat: add the commit hook',
    ])('lets git generate %s', (message) => {
        expect(validateCommitMessage(message)).toMatchObject({ ok: true, subject: message });
    });

    it('does not validate the body', () => {
        const message = 'feat: add the commit hook\n\nfree-form body with a period.';

        expect(validateCommitMessage(message).ok).toBe(true);
    });
});

describe('commit message — rejected', () => {
    it.each([
        ['', /empty/],
        ['   \n# only comments\n', /empty/],
        ['Update stuff', /"<type>\(<scope>\): <summary>"/],
        ['feat add the hook', /"<type>\(<scope>\): <summary>"/],
        ['Feat: add the hook', /"<type>\(<scope>\): <summary>"/],
        ['feature: add the hook', /unknown type "feature"/],
        ['feat: added the hook', /imperative/],
        ['fix: updating the docs', /imperative/],
        ['docs: removed the note', /imperative/],
        ['feat: add the hook.', /period/],
        [`feat: ${'x'.repeat(67)}`, /limit is 72/],
    ])('rejects %s', (message, reason) => {
        expect(validateCommitMessage(message)).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
    });
});
