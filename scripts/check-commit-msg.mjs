/**
 * Validate a commit message against the project's Conventional Commits rules —
 * the ones the `caveman-commit` skill writes to: `<type>(<scope>)!: <imperative
 * summary>`, at most 72 characters, no trailing period, body optional.
 *
 * The `.githooks/commit-msg` hook runs this on every commit, and
 * tests/commit-message.test.js exercises it through the same validator, so
 * `npm run check` covers it too.
 *
 * Usage: node scripts/check-commit-msg.mjs <commit-message-file>
 */

import fs from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Conventional Commit types the project accepts. */
const COMMIT_TYPES = [
    'feat', 'fix', 'refactor', 'perf', 'docs', 'test', 'chore', 'build', 'ci', 'style', 'revert',
];

/** Hard cap from the commit convention. */
const SUBJECT_MAX = 72;

/** Subjects git itself generates; the convention does not apply to them. */
const GIT_GENERATED = [
    /^Merge /,
    /^Revert "/,
    /^(fixup|squash|amend)! /,
];

/** Past/gerund openings that make a summary non-imperative. */
const NON_IMPERATIVE = /^(added|adds|adding|created|creates|creating|changed|changes|changing|fixed|fixes|fixing|implemented|implements|removed|removes|removing|refactored|refactors|updated|updates|updating)\b/i;

/**
 * The subject: first non-empty line that git did not add as a comment or as the
 * `git commit -v` scissors line.
 * @param {string} message
 * @returns {string}
 */
function subjectOf(message) {
    for (const line of String(message || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        if (/^-{2,}\s*>8\s*-{2,}$/.test(trimmed)) continue;
        return trimmed;
    }
    return '';
}

/**
 * Validates one commit message.
 * @param {string} message Full message text as git wrote it.
 * @returns {{ ok: boolean, subject: string, reason?: string }}
 */
export function validateCommitMessage(message) {
    const subject = subjectOf(message);
    if (!subject) {
        return { ok: false, subject, reason: 'commit message is empty' };
    }
    if (GIT_GENERATED.some(pattern => pattern.test(subject))) {
        return { ok: true, subject };
    }

    const match = /^([a-z]+)(\([A-Za-z0-9._/-]+\))?(!)?: (.+)$/.exec(subject);
    if (!match) {
        return { ok: false, subject, reason: 'subject must be "<type>(<scope>): <summary>"' };
    }

    const [, type, , , summary] = match;
    if (!COMMIT_TYPES.includes(type)) {
        return {
            ok: false,
            subject,
            reason: `unknown type "${type}" (use ${COMMIT_TYPES.join(', ')})`,
        };
    }
    if (subject.length > SUBJECT_MAX) {
        return {
            ok: false,
            subject,
            reason: `subject is ${subject.length} characters; the limit is ${SUBJECT_MAX}`,
        };
    }
    if (summary.endsWith('.')) {
        return { ok: false, subject, reason: 'subject ends with a period' };
    }
    if (NON_IMPERATIVE.test(summary)) {
        return { ok: false, subject, reason: 'summary must be imperative (e.g. "add", not "added")' };
    }

    return { ok: true, subject };
}

/** Reads git's message file, reports a rejection with the offending subject. */
function main() {
    const messagePath = process.argv[2];
    if (!messagePath) {
        console.error('commit-msg: missing message file argument');
        process.exit(2);
    }

    let message;
    try {
        message = fs.readFileSync(messagePath, 'utf8');
    } catch (error) {
        console.error(`commit-msg: cannot read ${messagePath}: ${error.message}`);
        process.exit(2);
    }

    const result = validateCommitMessage(message);
    if (!result.ok) {
        console.error(
            `commit-msg: ${result.reason}\n`
            + `  ${result.subject || '(empty)'}\n`
            + '  Write the message with the caveman-commit skill.',
        );
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
