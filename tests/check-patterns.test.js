/**
 * Hand-rolled download check — scripts/check-patterns.mjs.
 *
 * The Blob / object-URL / anchor sequence was copy-pasted in four panels before
 * one helper replaced them. This check makes the next copy fail `npm run check`
 * instead of waiting for a reviewer to spot it. Tests cover the rule directly
 * and the CLI through a fixture repository, so the exit code and message are
 * pinned too.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ALLOWED_FILES, findViolations } from '../scripts/check-patterns.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/check-patterns.mjs', import.meta.url));

const run = (dir) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
const output = (result) => `${result.stdout}${result.stderr}`;

/** A throwaway git repo containing the given files. */
function fixture(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-patterns-'));
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(dir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return dir;
}

let dirs = [];
const track = (dir) => {
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs = [];
});

describe('check-patterns — the rule', () => {
    it('flags an object URL and a hand-built Blob outside the helper', () => {
        const violations = findViolations([
            {
                path: 'ui/panel.js',
                source: [
                    'const blob = new Blob([json], { type: "application/json" });',
                    'const url = URL.createObjectURL(blob);',
                ].join('\n'),
            },
        ]);

        expect(violations).toEqual([
            { file: 'ui/panel.js', line: 2, rule: 'object-url', hint: expect.stringContaining('downloadJsonFile') },
            { file: 'ui/panel.js', line: 1, rule: 'blob', hint: expect.stringContaining('downloadJsonFile') },
        ]);
    });

    it('allows the declared exceptions', () => {
        for (const file of ALLOWED_FILES.keys()) {
            expect(findViolations([{
                path: file,
                source: 'const url = URL.createObjectURL(new Blob(["{}"]));',
            }])).toEqual([]);
        }
    });

    it('passes code that imports the helper', () => {
        const violations = findViolations([{
            path: 'ui/panel.js',
            source: 'import { downloadJsonFile } from "../utils/file-download.js";\ndownloadJsonFile("x.json", "{}");',
        }]);

        expect(violations).toEqual([]);
    });
});

describe('check-patterns — the CLI', () => {
    it('fails and names the file and line for a hand-rolled download', () => {
        const dir = track(fixture({
            'ui/panel.js': 'const url = URL.createObjectURL(new Blob(["{}"]));\n',
        }));

        const result = run(dir);

        expect(result.status).toBe(1);
        expect(output(result)).toContain('check-patterns: 2 hand-rolled file download(s)');
        expect(output(result)).toContain('ui/panel.js:1');
    });

    it('passes a checkout that uses the shared helper', () => {
        const dir = track(fixture({
            'ui/panel.js': 'export const x = 1;\n',
            'utils/file-download.js': 'const url = URL.createObjectURL(new Blob(["{}"]));\n',
        }));

        const result = run(dir);

        expect(result.status).toBe(0);
        expect(output(result)).toContain('files clean');
    });

    it('skips tests and scripts, where stubbing these APIs is the point', () => {
        const dir = track(fixture({
            'tests/stub.test.js': 'const url = URL.createObjectURL(new Blob(["{}"]));\n',
            'scripts/tool.mjs': 'const url = URL.createObjectURL(new Blob(["{}"]));\n',
        }));

        expect(run(dir).status).toBe(0);
    });
});
