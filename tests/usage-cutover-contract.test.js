/**
 * ============================================================================
 * USAGE CUTOVER — REGRESSION CONTRACT
 * ============================================================================
 * Usage accounting moved to Spendbook (a standalone extension). VectFox keeps
 * exactly one link to it: the internal mark written by hand onto its own request
 * init. This test asserts the post-cutover state so a merge, a revert or a
 * copied module cannot quietly put the feature back.
 *
 * Static analysis, not runtime: index.js only loads inside SillyTavern, and the
 * question here is what the shipped extension contains — its import graph, its
 * default settings, its rendered tab strip and its stylesheet.
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_MODULE = 'index.js';

const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf-8');

/** Static and dynamic relative imports of one source file. */
function importSpecifiers(source) {
    const specifiers = [];
    for (const match of source.matchAll(/(?:^|\n)[ \t]*import\s+(?:[^'"\n]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
        specifiers.push(match[1]);
    }
    for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        specifiers.push(match[1]);
    }
    return specifiers;
}

/**
 * Every repository file the entry module loads, directly or through another
 * relative import. Paths are repo-relative and POSIX. Host files SillyTavern
 * supplies (`../../../../script.js`) are outside the repo and are skipped.
 */
function reachableModules() {
    const seen = new Set();
    const pending = [ENTRY_MODULE];
    while (pending.length > 0) {
        const relative = pending.pop();
        if (seen.has(relative)) continue;
        const absolute = path.join(ROOT, relative);
        if (!fs.existsSync(absolute)) continue;
        seen.add(relative);
        const directory = path.posix.dirname(relative);
        for (const specifier of importSpecifiers(read(relative))) {
            if (!specifier.startsWith('.')) continue;
            pending.push(path.posix.normalize(path.posix.join(directory, specifier)));
        }
    }
    return [...seen].sort();
}

/** `file:line` for every source line matching `pattern`, for a failure that names the leak. */
function findMatches(files, pattern) {
    const hits = [];
    for (const file of files) {
        read(file).split(/\r?\n/).forEach((line, index) => {
            if (pattern.test(line)) hits.push(`${file}:${index + 1}: ${line.trim()}`);
        });
    }
    return hits;
}

const REACHABLE = reachableModules();

describe('the usage feature is not shipped by VectFox', () => {
    it('reaches no usage module from the entry module', () => {
        expect(REACHABLE.filter((file) => /(^|\/)usage-/.test(file))).toEqual([]);
    });

    it('has no usage settings key, tab or panel mount left in shipped code', () => {
        const leftovers = findMatches(
            REACHABLE,
            /usage_tracking_enabled|usage_prices|data-tab="usage"|data-vectfox-tab="usage"|VectFox_usage_panel/,
        );
        expect(leftovers).toEqual([]);
    });

    it('loads no usage stylesheet', () => {
        const imports = [...read('vectfox.css').matchAll(/@import\s+url\(['"]?([^'")]+)/g)]
            .map((match) => match[1]);
        expect(imports.filter((target) => /usage/.test(target))).toEqual([]);
    });
});

describe('the Spendbook mark is the only link to Spendbook', () => {
    it('writes the documented symbol by hand', () => {
        const writers = findMatches(REACHABLE, /Symbol\.for\('spendbook\.internal-request'\)/);
        expect(writers.map((hit) => hit.split(':')[0])).toEqual(['core/llm-provider-call.js']);
    });

    it('reads and writes no retired VectFox mark', () => {
        expect(findMatches(REACHABLE, /vectfox\.usage\.internal-request/)).toEqual([]);
    });

    it('imports nothing from Spendbook and declares no dependency on it', () => {
        const specifiers = REACHABLE.flatMap((file) => importSpecifiers(read(file)));
        expect(specifiers.filter((specifier) => /spendbook/i.test(specifier))).toEqual([]);
        expect(JSON.stringify(JSON.parse(read('manifest.json'))).toLowerCase()).not.toContain('spendbook');
    });
});
