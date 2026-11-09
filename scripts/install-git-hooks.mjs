/**
 * Install the local pre-commit hook that runs `npm run check`.
 *
 * Hooks are per-clone and are not committed, so this installer is the tracked
 * part. Re-run it after cloning. Existing hooks are preserved unless --force.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const force = process.argv.includes('--force');

let gitDir;
try {
    gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim();
} catch {
    console.error('hooks:install: not a git checkout; nothing to install.');
    process.exit(1);
}

const hooksDir = path.join(gitDir, 'hooks');
const hookPath = path.join(hooksDir, 'pre-commit');
const hook = '#!/bin/sh\nset -e\nnpm run check\n';

if (fs.existsSync(hookPath) && !force) {
    console.error(
        `hooks:install: ${hookPath} already exists.\n`
        + 'Re-run with --force to replace it, or wire `npm run check` into it yourself.',
    );
    process.exit(1);
}

fs.mkdirSync(hooksDir, { recursive: true });
fs.writeFileSync(hookPath, hook, { mode: 0o755 });
fs.chmodSync(hookPath, 0o755);
console.log(`hooks:install: installed ${hookPath}`);
