/**
 * Verify that paths named in the agent docs exist and are tracked.
 *
 * A pointer to a gitignored file is worse than no pointer: the current checkout
 * makes it look valid and a fresh clone loses it. This check catches both a
 * dangling path and a path hidden by `.gitignore`.
 *
 * Scope: AGENTS.md, CODING_STANDARDS.md and docs/agents/*.md. `.scratch/` is
 * intentionally local and is skipped.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const docs = [
    'AGENTS.md',
    'CODING_STANDARDS.md',
    ...listMarkdown(path.join(repoRoot, 'docs/agents')),
];
const SKIP = ['.scratch', 'VectCookie/.scratch'];
const PATH_EXTENSIONS = ['.md', '.js', '.mjs', '.json', '.css', '.yaml', '.yml'];

function listMarkdown(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
        .filter((name) => name.endsWith('.md'))
        .map((name) => `docs/agents/${name}`);
}

function looksLikePath(token) {
    if (!token || /[\s*<>():"']/.test(token)) return false;
    if (token.startsWith('http') || token.startsWith('npm ') || token.startsWith('git ')) return false;
    // Bare filenames are prose examples (map.md, spec.md), not navigation.
    if (!token.includes('/')) return false;
    return token.endsWith('/') || PATH_EXTENSIONS.some((extension) => token.endsWith(extension));
}

function isSkipped(relativePath) {
    return SKIP.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`));
}

function isIgnored(relativePath) {
    try {
        execFileSync('git', ['check-ignore', '--quiet', '--', relativePath], {
            cwd: repoRoot,
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}

const failures = [];
let checked = 0;

for (const doc of docs) {
    const docPath = path.join(repoRoot, doc);
    if (!fs.existsSync(docPath)) {
        failures.push(`${doc}: file is missing`);
        continue;
    }
    const text = fs.readFileSync(docPath, 'utf8');
    const pattern = /`([^`\n]+)`/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        const token = match[1].trim();
        if (!looksLikePath(token)) continue;
        // Pointers are written either relative to the doc or to the repo root;
        // accept whichever resolves, so a moved doc does not break the check.
        const docRelative = path.resolve(path.dirname(docPath), token);
        const rootRelative = path.resolve(repoRoot, token);
        const target = fs.existsSync(docRelative) ? docRelative : rootRelative;
        const relative = path.relative(repoRoot, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        if (isSkipped(relative)) continue;
        checked += 1;
        if (!fs.existsSync(target)) {
            failures.push(`${doc}: \`${token}\` does not exist`);
            continue;
        }
        if (isIgnored(relative)) {
            failures.push(`${doc}: \`${token}\` exists but is gitignored; track it or remove the pointer`);
        }
    }
}

if (failures.length > 0) {
    console.error(`check-docs: ${failures.length} problem(s)`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(`check-docs: ${checked} doc pointer(s) exist and are not gitignored`);
