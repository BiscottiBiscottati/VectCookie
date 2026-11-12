/**
 * Install the tracked git hooks that guard commits.
 *
 * Two hooks, both copied from `.githooks/` because `.git/hooks` is per-clone and
 * not committed:
 *
 *   - `pre-commit` runs `npm run check`.
 *   - `commit-msg` rejects subjects that break the Conventional Commits rules
 *     (scripts/check-commit-msg.mjs).
 *
 * Re-run after cloning. Existing hooks are preserved unless --force.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const force = process.argv.includes('--force');
const sourceDir = path.join(import.meta.dirname, '..', '.githooks');
const hookNames = ['pre-commit', 'commit-msg'];

let gitDir;
try {
    gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
} catch {
    console.error('hooks:install: not a git checkout; nothing to install.');
    process.exit(1);
}

const hooksDir = path.join(gitDir, 'hooks');
fs.mkdirSync(hooksDir, { recursive: true });

let failed = false;
for (const hookName of hookNames) {
    const sourcePath = path.join(sourceDir, hookName);
    const hookPath = path.join(hooksDir, hookName);

    if (!fs.existsSync(sourcePath)) {
        console.error(`hooks:install: missing tracked hook at ${sourcePath}`);
        failed = true;
        continue;
    }

    const hook = fs.readFileSync(sourcePath);
    if (fs.existsSync(hookPath) && !force) {
        const existing = fs.readFileSync(hookPath);
        if (existing.equals(hook)) {
            console.log(`hooks:install: ${hookName} already installed at ${hookPath}`);
            continue;
        }
        console.error(
            `hooks:install: ${hookPath} already exists and differs.\n`
            + `Re-run with --force to replace it, or wire ${hookName} yourself.`,
        );
        failed = true;
        continue;
    }

    fs.writeFileSync(hookPath, hook, { mode: 0o755 });
    fs.chmodSync(hookPath, 0o755);
    console.log(`hooks:install: installed ${hookName} at ${hookPath}`);
}

process.exitCode = failed ? 1 : 0;
