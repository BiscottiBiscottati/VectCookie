/**
 * Verify that paths named in the agent docs exist and are tracked.
 *
 * A pointer to a file a fresh clone will not have is worse than no pointer: the
 * current checkout makes it look valid and the clone loses it. This check
 * catches three ways that happens — a dangling path, a path hidden by
 * `.gitignore`, and a path that exists locally but was never committed.
 *
 * Scope: AGENTS.md, CODING_STANDARDS.md, docs/agents/*.md and docs/adr/*.md.
 * `.scratch/` is intentionally local and is skipped.
 *
 * Convention: a backticked path is a live pointer, so every one must exist and
 * be tracked. An ADR naming a file it removed, or a file belonging to another
 * repository, writes that name as prose rather than in backticks — otherwise
 * this check cannot tell history from navigation.
 *
 * Usage: node scripts/check-docs.mjs [repoRoot]
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const targetRoot = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '..'));
const docs = [
    'AGENTS.md',
    'CODING_STANDARDS.md',
    ...listMarkdown('docs/agents'),
    ...listMarkdown('docs/adr'),
];
const SKIP = ['.scratch', 'VectCookie/.scratch'];
const PATH_EXTENSIONS = ['.md', '.js', '.mjs', '.json', '.css', '.yaml', '.yml'];

function listMarkdown(relativeDirectory) {
    const directory = path.join(targetRoot, relativeDirectory);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory)
        .filter((name) => name.endsWith('.md'))
        .sort()
        .map((name) => `${relativeDirectory}/${name}`);
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

/** Present only if a fresh clone gets it, so trackedness is the real question. */
function isTracked(relativePath) {
    try {
        execFileSync('git', ['ls-files', '--error-unmatch', '--', relativePath], {
            cwd: targetRoot,
            stdio: 'ignore',
        });
        return true;
    } catch {
        return false;
    }
}

/** Distinguishes the common cause of untracked, for a message that says what to do. */
function isIgnored(relativePath) {
    try {
        execFileSync('git', ['check-ignore', '--quiet', '--', relativePath], {
            cwd: targetRoot,
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
    const docPath = path.join(targetRoot, doc);
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
        const rootRelative = path.resolve(targetRoot, token);
        const target = fs.existsSync(docRelative) ? docRelative : rootRelative;
        const relative = path.relative(targetRoot, target);
        if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
        if (isSkipped(relative)) continue;
        checked += 1;
        if (!fs.existsSync(target)) {
            failures.push(`${doc}: \`${token}\` does not exist`);
            continue;
        }
        if (isTracked(relative)) continue;
        failures.push(
            isIgnored(relative)
                ? `${doc}: \`${token}\` exists but is gitignored; track it or remove the pointer`
                : `${doc}: \`${token}\` exists but is not tracked; commit it or remove the pointer`,
        );
    }
}

if (failures.length > 0) {
    console.error(`check-docs: ${failures.length} problem(s)`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
}

console.log(`check-docs: ${checked} doc pointer(s) exist and are tracked`);
