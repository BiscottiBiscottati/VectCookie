import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Behaviour tests for scripts/check-docs.mjs, at its CLI seam: a fixture git
 * repository in, exit code plus message out. The script takes a target root
 * argument so it can be pointed at a fixture instead of this checkout.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/check-docs.mjs', import.meta.url));

const check = (dir) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

const output = (result) => `${result.stdout}${result.stderr}`;

/**
 * Build a throwaway git repo. Files listed in `docs` are written but NOT
 * `git add`-ed unless tracked, so a pointer at them exercises the untracked case.
 */
function fixture({ agents, coding = '# Coding standards\n', extraFiles = {}, tracked = [], ignore = [] }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-docs-'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), agents);
    fs.writeFileSync(path.join(dir, 'CODING_STANDARDS.md'), coding);
    if (ignore.length > 0) fs.writeFileSync(path.join(dir, '.gitignore'), ignore.join('\n'));

    const files = { ...extraFiles };
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(dir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }

    execFileSync('git', ['init', '-q'], { cwd: dir });
    // `git ls-files` reads the index, so staging is enough to count as tracked.
    execFileSync('git', ['add', '-f', 'AGENTS.md', 'CODING_STANDARDS.md', ...tracked], { cwd: dir });
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

describe('check-docs — pointers that resolve', () => {
    it('passes when a pointer names an existing tracked file', () => {
        const dir = track(fixture({
            agents: 'See `scripts/tool.mjs` for details.\n',
            extraFiles: { 'scripts/tool.mjs': 'export {};\n' },
            tracked: ['scripts/tool.mjs'],
        }));

        const result = check(dir);

        expect(result.status).toBe(0);
        expect(output(result)).toContain('check-docs: 1 doc pointer');
        expect(output(result)).toContain('tracked');
    });

    it('passes for a tracked directory pointer', () => {
        const dir = track(fixture({
            agents: 'Docs live in `docs/agents/`.\n',
            extraFiles: { 'docs/agents/domain.md': '# Domain\n' },
            tracked: ['docs/agents/domain.md'],
        }));

        expect(check(dir).status).toBe(0);
    });
});

describe('check-docs — pointers that do not resolve', () => {
    it('fails when the pointer names a file that does not exist', () => {
        const dir = track(fixture({ agents: 'See `scripts/missing.mjs`.\n' }));

        const result = check(dir);

        expect(result.status).toBe(1);
        expect(output(result)).toContain('`scripts/missing.mjs` does not exist');
    });

    it('fails when the pointer names a gitignored file', () => {
        const dir = track(fixture({
            agents: 'See `build/out.json`.\n',
            extraFiles: { 'build/out.json': '{}\n' },
            ignore: ['build/'],
        }));

        const result = check(dir);

        expect(result.status).toBe(1);
        expect(output(result)).toContain('exists but is gitignored');
    });

    it('fails when the pointer names a file that exists but was never tracked', () => {
        // The gap this check used to miss: untracked and not ignored passes
        // `git check-ignore`, so only a trackedness check catches it.
        const dir = track(fixture({
            agents: 'See `scripts/loose.mjs`.\n',
            extraFiles: { 'scripts/loose.mjs': 'export {};\n' },
        }));

        const result = check(dir);

        expect(result.status).toBe(1);
        expect(output(result)).toContain('exists but is not tracked');
    });

    it('fails when AGENTS.md itself is missing', () => {
        const dir = track(fixture({ agents: '' }));
        fs.rmSync(path.join(dir, 'AGENTS.md'));

        const result = check(dir);

        expect(result.status).toBe(1);
        expect(output(result)).toContain('AGENTS.md: file is missing');
    });
});

describe('check-docs — scope', () => {
    it('checks ADRs under docs/adr/', () => {
        const dir = track(fixture({
            agents: 'No pointers here.\n',
            extraFiles: { 'docs/adr/0001-thing.md': 'See `core/gone.js`.\n' },
            tracked: ['docs/adr/0001-thing.md'],
        }));

        const result = check(dir);

        expect(result.status).toBe(1);
        expect(output(result)).toContain('docs/adr/0001-thing.md');
        expect(output(result)).toContain('`core/gone.js` does not exist');
    });

    it('skips pointers into .scratch/', () => {
        const dir = track(fixture({
            agents: 'Spec: `.scratch/feature/spec.md`.\n',
            extraFiles: { '.scratch/feature/spec.md': '# Spec\n' },
        }));

        expect(check(dir).status).toBe(0);
    });
});

describe('check-docs — what is not treated as a pointer', () => {
    it('ignores prose, commands, URLs and bare filenames', () => {
        const dir = track(fixture({
            agents: [
                'A bare name like `spec.md` is prose.',
                'A command like `git fetch upstream` is prose.',
                'A URL like `https://example.com/x.md` is prose.',
                'A separator like ` / ` is prose.',
                '',
            ].join('\n'),
        }));

        const result = check(dir);

        expect(result.status).toBe(0);
        expect(output(result)).toContain('check-docs: 0 doc pointer');
    });
});
