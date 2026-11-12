/**
 * Deterministic checks for patterns a review should not have to catch twice.
 *
 * Rule: a file download goes through utils/file-download.js. The Blob /
 * object-URL / anchor sequence had been hand-rolled in four places (and drifted:
 * one copy revoked the URL before the browser had started copying), so a new
 * copy is a regression. `core/png-export.js` is allowed because it builds image
 * blobs, not JSON downloads.
 *
 * Tests and scripts are skipped: tests stub these APIs on purpose, and this
 * script's own patterns would match themselves.
 *
 * Usage: node scripts/check-patterns.mjs [repoRoot]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Files allowed to build object URLs or Blobs, with why. */
export const ALLOWED_FILES = new Map([
    ['utils/file-download.js', 'the one JSON download helper'],
    ['core/png-export.js', 'image blobs for PNG export and preview'],
]);

/** Directories whose files are not extension runtime code. */
const SKIP_PREFIXES = ['tests/', 'scripts/', 'core/vendor/'];

const RULES = [
    {
        id: 'object-url',
        pattern: /\b(?:globalThis\.)?URL\.createObjectURL\b/,
        hint: 'call downloadJsonFile() from utils/file-download.js',
    },
    {
        id: 'blob',
        pattern: /\bnew Blob\s*\(/,
        hint: 'call downloadJsonFile() from utils/file-download.js; image code belongs in core/png-export.js',
    },
];

/**
 * Finds hand-rolled download sites in the given sources.
 * @param {Array<{ path: string, source: string }>} files Repo-relative path and contents.
 * @param {{ allowed?: Map<string, string> }} [options]
 * @returns {Array<{ file: string, line: number, rule: string, hint: string }>}
 */
export function findViolations(files, { allowed = ALLOWED_FILES } = {}) {
    const violations = [];

    for (const { path: file, source } of files) {
        if (allowed.has(file)) continue;
        const lines = source.split(/\r?\n/);
        for (const rule of RULES) {
            lines.forEach((line, index) => {
                if (!rule.pattern.test(line)) return;
                violations.push({ file, line: index + 1, rule: rule.id, hint: rule.hint });
            });
        }
    }

    return violations;
}

/** Lists JS files that make up the extension runtime. */
function listSourceFiles(root) {
    return execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '*.js', '*.mjs'],
        { cwd: root, encoding: 'utf8' },
    )
        .split('\n')
        .filter(Boolean)
        .filter(file => !SKIP_PREFIXES.some(prefix => file.startsWith(prefix)))
        .sort();
}

function main() {
    const root = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));

    let files;
    try {
        files = listSourceFiles(root);
    } catch {
        console.error('check-patterns: could not list JS files; run from the VectCookie git checkout.');
        process.exit(1);
    }

    const entries = files.map(file => ({
        path: file,
        source: fs.readFileSync(path.join(root, file), 'utf8'),
    }));
    const violations = findViolations(entries);

    if (violations.length > 0) {
        console.error(`check-patterns: ${violations.length} hand-rolled file download(s)`);
        for (const violation of violations) {
            console.error(`\n${violation.file}:${violation.line} (${violation.rule})\n  ${violation.hint}`);
        }
        process.exit(1);
    }

    console.log(`check-patterns: ${files.length} files clean`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
