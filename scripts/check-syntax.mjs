/**
 * Syntax-check every JS file tracked or untracked-but-not-ignored in this repo.
 *
 * `npm run check` runs this before the unit suite. The point is to catch a
 * parse error in a file the tests happen not to import.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import process from 'node:process';

function listJavaScriptFiles() {
    try {
        return execFileSync(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard', '*.js', '*.mjs'],
            { encoding: 'utf8' },
        )
            .split('\n')
            .filter(Boolean)
            .sort();
    } catch {
        console.error('check-syntax: could not list JS files; run from the VectCookie git checkout.');
        process.exit(1);
    }
}

const files = listJavaScriptFiles();
const failures = [];

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        failures.push({ file, error: (result.stderr || result.stdout || '').trim() });
    }
}

if (failures.length > 0) {
    console.error(`check-syntax: ${failures.length} file(s) failed to parse`);
    for (const { file, error } of failures) {
        console.error(`\n${file}\n${error}`);
    }
    process.exit(1);
}

console.log(`check-syntax: ${files.length} JS/MJS files parsed`);
