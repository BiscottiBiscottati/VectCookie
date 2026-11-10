/**
 * Install the tracked pre-commit hook that runs `npm run check`.
 *
 * Hooks under `.git/hooks` are per-clone and are not committed, so the tracked
 * source lives at `.githooks/pre-commit` and this installer copies it. Re-run
 * after cloning. Existing hooks are preserved unless --force.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const force = process.argv.includes('--force');
const sourcePath = path.join(import.meta.dirname, '..', '.githooks', 'pre-commit');

if (!fs.existsSync(sourcePath)) {
    console.error(`hooks:install: missing tracked hook at ${sourcePath}`);
    process.exit(1);
}

let gitDir;
try {
    gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
} catch {
    console.error('hooks:install: not a git checkout; nothing to install.');
    process.exit(1);
}

const hooksDir = path.join(gitDir, 'hooks');
const hookPath = path.join(hooksDir, 'pre-commit');
const hook = fs.readFileSync(sourcePath);

if (fs.existsSync(hookPath) && !force) {
    const existing = fs.readFileSync(hookPath);
    if (existing.equals(hook)) {
        console.log(`hooks:install: already installed at ${hookPath}`);
        process.exit(0);
    }
    console.error(
        `hooks:install: ${hookPath} already exists and differs.\n`
        + 'Re-run with --force to replace it, or wire `npm run check` into it yourself.',
    );
    process.exit(1);
}

fs.mkdirSync(hooksDir, { recursive: true });
fs.writeFileSync(hookPath, hook, { mode: 0o755 });
fs.chmodSync(hookPath, 0o755);
console.log(`hooks:install: installed ${hookPath}`);
