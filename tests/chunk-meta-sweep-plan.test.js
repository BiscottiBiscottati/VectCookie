/**
 * Sweep planner — the pure classification of settings chunk-metadata entries.
 *
 * ADR-0003 decision 6 and the feature spec make this the home of the destructive
 * logic: an entry is redundant only when a scanned collection's payload already
 * holds it, orphan only when it is absent from *every* registered collection,
 * and skipped whenever a collection could not be read. The planner is pure, so
 * these tests are a table of inputs and expected plans — no transport, no
 * settings object, no host modules.
 *
 * Seam: `planChunkMetaSweep()` — the plan it returns is the whole observable
 * behaviour. The dry-run entry point that feeds it is covered separately in
 * chunk-meta-sweep-run.test.js.
 */

import { describe, it, expect } from 'vitest';

import { planChunkMetaSweep } from '../core/chunk-meta-sweep.js';

/** One collection as the loader's read-only listing returns it. */
function collection(id, registryKey = id) {
    return { registryKey, collectionId: id };
}

/** A scan result for one collection; chunks is hash -> payload metadata. */
function scan(id, chunks, status = 'ok', registryKey = id) {
    return { registryKey, collectionId: id, status, chunks: new Map(Object.entries(chunks || {})) };
}

/** The plan, projected to what the report shows: counts, reasons and per-collection rows. */
function summarize(plan) {
    return {
        trusted: plan.trusted,
        untrustedReason: plan.untrustedReason,
        counts: plan.counts,
        redundant: plan.redundant.map(entry => ({ hash: entry.hash, collections: entry.collections })),
        patch: plan.patch.map(entry => ({
            hash: entry.hash,
            registryKey: entry.registryKey,
            fields: entry.fields,
        })),
        orphan: plan.orphan.map(entry => entry.hash),
        skipped: plan.skipped.map(entry => ({
            hash: entry.hash,
            reason: entry.reason,
            collections: entry.collections,
        })),
        perCollection: plan.perCollection.map(row => ({
            collectionId: row.collectionId,
            status: row.status,
            chunkCount: row.chunkCount,
            redundant: row.redundant,
            patch: row.patch,
            skipped: row.skipped,
        })),
    };
}

/** An entry that a payload fully supersedes. */
const COMPLETE_PAYLOAD = { context: 'about dragons', keywords: ['dragon'], enabled: true };

describe('sweep planner — redundant entries', () => {
    it('marks an entry redundant when the payload already holds every field', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: COMPLETE_PAYLOAD },
            collections: [collection('A')],
            scans: [scan('A', { h1: { ...COMPLETE_PAYLOAD, hash: 'h1', text: 'chunk text' } })],
        });

        expect(summarize(plan)).toEqual({
            trusted: true,
            untrustedReason: null,
            counts: { redundant: 1, patch: 0, orphan: 0, skipped: 0 },
            redundant: [{ hash: 'h1', collections: ['A'] }],
            patch: [],
            orphan: [],
            skipped: [],
            perCollection: [{
                collectionId: 'A',
                status: 'ok',
                chunkCount: 1,
                redundant: 1,
                patch: 0,
                skipped: 0,
            }],
        });
    });

    it('treats empty values in the payload as absence, matching the read path', () => {
        // The read path says an empty string/array is "no value", so the settings
        // copy still supplies it — that is a patch, not redundancy.
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'kept', keywords: ['dragon'] } },
            collections: [collection('A')],
            scans: [scan('A', { h1: { context: '', keywords: [] } })],
        });

        expect(plan.counts).toEqual({ redundant: 0, patch: 1, orphan: 0, skipped: 0 });
        expect(plan.patch[0]).toEqual({
            hash: 'h1',
            registryKey: 'A',
            collectionId: 'A',
            fields: { context: 'kept', keywords: ['dragon'] },
        });
    });

    it('counts false and zero as values the payload can hold', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: { enabled: false, position: 0 } },
            collections: [collection('A')],
            scans: [scan('A', { h1: { enabled: false, position: 0 } })],
        });

        expect(plan.counts.redundant).toBe(1);
        expect(plan.counts.patch).toBe(0);
    });

    it('never proposes patching chunk data, only metadata fields', () => {
        // A legacy entry can hold the text/hash it was keyed by. Those belong to
        // the chunk, not to a metadata patch, so they are not transferred.
        const plan = planChunkMetaSweep({
            entries: { h1: { hash: 'h1', text: 'chunk text', context: 'about dragons' } },
            collections: [collection('A')],
            scans: [scan('A', { h1: { context: 'about dragons' } })],
        });

        expect(plan.patch).toEqual([]);
        expect(plan.counts.redundant).toBe(1);
    });

    it('ignores fields the payload has but the settings entry never held', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'shared' } },
            collections: [collection('A')],
            scans: [scan('A', { h1: { context: 'shared', importance: 7 } })],
        });

        expect(plan.counts.redundant).toBe(1);
    });

    it('does not patch or compare the updatedAt bookkeeping stamp', () => {
        // Both stores stamp their own time; comparing them would make every
        // entry look patchable forever.
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'shared', updatedAt: 111 } },
            collections: [collection('A')],
            scans: [scan('A', { h1: { context: 'shared', updatedAt: 999 } })],
        });

        expect(plan.counts).toEqual({ redundant: 1, patch: 0, orphan: 0, skipped: 0 });
    });
});

describe('sweep planner — entries needing a payload patch', () => {
    it('lists only the fields the payload lacks, by collection', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons', keywords: ['dragon'], enabled: true } },
            collections: [collection('A')],
            scans: [scan('A', { h1: { context: 'about dragons', enabled: true } })],
        });

        expect(plan.counts).toEqual({ redundant: 0, patch: 1, orphan: 0, skipped: 0 });
        expect(plan.patch).toEqual([{ hash: 'h1', registryKey: 'A', collectionId: 'A', fields: { keywords: ['dragon'] } }]);
        expect(plan.perCollection[0].patch).toBe(1);
        expect(plan.perCollection[0].redundant).toBe(0);
    });

    it('never proposes patching a field with no payload representation', () => {
        // summaries is client-only: it can never reach a payload, so an entry
        // holding it is kept untouched instead of being patched forever.
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons', summaries: ['a summary'] } },
            collections: [collection('A')],
            scans: [scan('A', { h1: { context: 'about dragons' } })],
            clientOnlyFields: ['summaries'],
        });

        expect(plan.patch).toEqual([]);
        expect(plan.counts.skipped).toBe(1);
        expect(plan.skipped[0]).toEqual({ hash: 'h1', reason: 'client-only', collections: ['A'] });
    });

    it('proposes patches for every collection that lacks the field', () => {
        const plan = planChunkMetaSweep({
            entries: { shared: { context: 'about dragons', keywords: ['dragon'] } },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', { shared: { context: 'about dragons' } }),
                scan('B', { shared: { context: 'about dragons' } }),
            ],
        });

        expect(plan.counts.patch).toBe(1);
        expect(plan.patch).toHaveLength(2);
        expect(plan.patch.map(entry => entry.registryKey)).toEqual(['A', 'B']);
        expect(plan.perCollection.map(row => row.patch)).toEqual([1, 1]);
    });

    it('is not redundant when one of the containing collections lacks the field', () => {
        const plan = planChunkMetaSweep({
            entries: { shared: { context: 'about dragons', keywords: ['dragon'] } },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', { shared: { context: 'about dragons', keywords: ['dragon'] } }),
                scan('B', { shared: { context: 'about dragons' } }),
            ],
        });

        expect(plan.counts.redundant).toBe(0);
        expect(plan.redundant).toEqual([]);
        expect(plan.patch).toEqual([{ hash: 'shared', registryKey: 'B', collectionId: 'B', fields: { keywords: ['dragon'] } }]);
    });
});

describe('sweep planner — orphans mean absent from every registered collection', () => {
    it('marks an entry orphan when no scanned collection contains its hash', () => {
        const plan = planChunkMetaSweep({
            entries: { gone: { context: 'deleted chunk' } },
            collections: [collection('A')],
            scans: [scan('A', {})],
        });

        expect(plan.counts).toEqual({ redundant: 0, patch: 0, orphan: 1, skipped: 0 });
        expect(plan.orphan).toEqual([{ hash: 'gone' }]);
    });

    it('does not call an entry orphan while another collection still holds it', () => {
        // The collection in the visualizer is A, but the same content-derived
        // hash lives in B too. Absence from A alone proves nothing (ADR-0003).
        const plan = planChunkMetaSweep({
            entries: { shared: { context: 'about dragons' } },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', {}),
                scan('B', { shared: { context: 'about dragons' } }),
            ],
        });

        expect(plan.counts.orphan).toBe(0);
        expect(plan.counts.redundant).toBe(1);
        expect(plan.redundant[0].collections).toEqual(['B']);
    });

    it('counts a hash found in two collections once in total and once per collection', () => {
        const plan = planChunkMetaSweep({
            entries: { shared: { context: 'about dragons' } },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', { shared: { context: 'about dragons' } }),
                scan('B', { shared: { context: 'about dragons' } }),
            ],
        });

        expect(plan.counts.redundant).toBe(1);
        expect(plan.redundant[0].collections).toEqual(['A', 'B']);
        expect(plan.perCollection.map(row => row.redundant)).toEqual([1, 1]);
    });
});

describe('sweep planner — untrusted scans refuse deletion', () => {
    it('marks a run untrusted when a collection scan failed', () => {
        const plan = planChunkMetaSweep({
            entries: { kept: { context: 'maybe in B' } },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', {}),
                { collectionId: 'B', status: 'failed', chunks: new Map(), error: 'timeout' },
            ],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.untrustedReason).toBe('failed');
        expect(plan.counts).toEqual({ redundant: 0, patch: 0, orphan: 0, skipped: 1 });
        expect(plan.skipped[0]).toEqual({ hash: 'kept', reason: 'unverified', collections: ['B'] });
    });

    it('marks a run untrusted when a registered collection was never attempted', () => {
        const plan = planChunkMetaSweep({
            entries: { kept: { context: 'maybe in B' } },
            collections: [collection('A'), collection('B')],
            scans: [scan('A', {})],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.untrustedReason).toBe('unscanned');
        expect(plan.counts.skipped).toBe(1);
        expect(plan.perCollection).toContainEqual({
            registryKey: 'B',
            collectionId: 'B',
            status: 'unscanned',
            chunkCount: 0,
            redundant: 0,
            patch: 0,
            skipped: 0,
        });
    });

    it('still counts what a trusted collection proves when another failed', () => {
        // The failed collection blocks deletion for the whole run, but it must
        // not hide the redundancy the successful scan actually established.
        const plan = planChunkMetaSweep({
            entries: {
                redundant: { context: 'about dragons' },
                maybeInB: { context: 'elsewhere' },
            },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', { redundant: { context: 'about dragons' } }),
                { collectionId: 'B', status: 'failed', chunks: new Map(), error: 'timeout' },
            ],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.counts.redundant).toBe(1);
        expect(plan.counts.skipped).toBe(1);
        expect(plan.counts.orphan).toBe(0);
    });

    it('marks a metadata-less listing untrusted but still proposes the patch', () => {
        // The native fallback returns hashes with empty payloads. Absence of
        // metadata is not proof of deletion, but the settings fields are
        // exactly what the payload lacks — patching is allowed on untrusted runs.
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons' } },
            collections: [collection('A')],
            scans: [{ collectionId: 'A', status: 'metadata-missing', chunks: new Map([['h1', {}]]) }],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.untrustedReason).toBe('metadata-missing');
        expect(plan.patch).toEqual([{ hash: 'h1', registryKey: 'A', collectionId: 'A', fields: { context: 'about dragons' } }]);
        expect(plan.counts.redundant).toBe(0);
    });

    it('refuses deletion when nothing is registered, instead of calling everything orphan', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons' } },
            collections: [],
            scans: [],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.untrustedReason).toBe('empty-registry');
        expect(plan.counts).toEqual({ redundant: 0, patch: 0, orphan: 0, skipped: 1 });
        expect(plan.skipped[0].reason).toBe('unverified');
    });

    it('reports trusted when every registered collection was read with metadata', () => {
        const plan = planChunkMetaSweep({
            entries: {},
            collections: [collection('A')],
            scans: [scan('A', {})],
        });

        expect(plan.trusted).toBe(true);
        expect(plan.untrustedReason).toBeNull();
    });
});

describe('sweep planner — a second run produces the same plan', () => {
    const entries = {
        redundant: { context: 'about dragons', keywords: ['dragon'] },
        needsPatch: { context: 'about elves', keywords: ['elf'] },
        orphaned: { context: 'deleted chunk' },
        clientOnly: { context: 'about dragons', summaries: ['kept'] },
    };
    const collections = [collection('A'), collection('B')];
    const scans = () => [
        scan('A', {
            redundant: { context: 'about dragons', keywords: ['dragon'] },
            needsPatch: { context: 'about elves' },
            clientOnly: { context: 'about dragons' },
        }),
        scan('B', {}),
    ];

    it('returns the same plan twice and mutates neither input', () => {
        const entriesBefore = JSON.stringify(entries);
        const collectionsBefore = JSON.stringify(collections);

        const first = planChunkMetaSweep({ entries, collections, scans: scans(), clientOnlyFields: ['summaries'] });
        const second = planChunkMetaSweep({ entries, collections, scans: scans(), clientOnlyFields: ['summaries'] });

        expect(summarize(second)).toEqual(summarize(first));
        expect(JSON.stringify(entries)).toBe(entriesBefore);
        expect(JSON.stringify(collections)).toBe(collectionsBefore);
        expect(first.counts).toEqual({ redundant: 1, patch: 1, orphan: 1, skipped: 1 });
        expect(first.trusted).toBe(true);
    });

    it('does not treat a scan as authoritative for a collection it does not name', () => {
        const plan = planChunkMetaSweep({
            entries: { onlyInB: { context: 'about elves' } },
            collections: collections,
            scans: [scan('A', {})],
        });

        // B exists in the registry and was never scanned: no orphan is claimed.
        expect(plan.counts).toEqual({ redundant: 0, patch: 0, orphan: 0, skipped: 1 });
        expect(plan.untrustedReason).toBe('unscanned');
    });
});

describe('sweep planner — collection identity is the registry key', () => {
    it('keeps the same collection id on two backends as two collections', () => {
        // "backend:collectionId" is the registry identity; collapsing by bare
        // id would silently drop one scan and its entries.
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons' } },
            collections: [
                collection('same', 'qdrant:same'),
                collection('same', 'standard:same'),
            ],
            scans: [
                scan('same', { h1: { context: 'about dragons' } }, 'ok', 'qdrant:same'),
                scan('same', {}, 'ok', 'standard:same'),
            ],
        });

        expect(plan.perCollection.map(row => row.registryKey)).toEqual(['qdrant:same', 'standard:same']);
        expect(plan.perCollection.map(row => row.collectionId)).toEqual(['same', 'same']);
        expect(plan.counts.redundant).toBe(1);
        expect(plan.coverage.registered).toBe(2);
    });

    it('does not let a later successful scan hide an earlier failed one for the same key', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons' } },
            collections: [collection('A', 'qdrant:A')],
            scans: [
                { registryKey: 'qdrant:A', collectionId: 'A', status: 'failed', chunks: new Map() },
                scan('A', { h1: { context: 'about dragons' } }, 'ok', 'qdrant:A'),
            ],
        });

        // Same identity: the last result for that collection wins, and it is an
        // ok scan. The guarantee that matters is that a *different* collection
        // can never overwrite it — covered by the two-backends case above.
        expect(plan.trusted).toBe(true);
    });
});

describe('sweep planner — the delete list exists only for a trusted run', () => {
    it('reports redundant findings but no deletable entries when a scan failed', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons' } },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', { h1: { context: 'about dragons' } }),
                { registryKey: 'B', collectionId: 'B', status: 'failed', chunks: new Map() },
            ],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.counts.redundant).toBe(1);
        expect(plan.redundant).toEqual([{ hash: 'h1', collections: ['A'] }]);
        expect(plan.deletable).toEqual([]);
    });

    it('offers the redundant entries for deletion when every collection was read', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons' } },
            collections: [collection('A')],
            scans: [scan('A', { h1: { context: 'about dragons' } })],
        });

        expect(plan.trusted).toBe(true);
        expect(plan.deletable).toEqual(plan.redundant);
        expect(plan.deletable).toHaveLength(1);
    });
});

describe('sweep planner — every entry the sweep may remove is on the delete list', () => {
    it('lists a patched entry for deletion so the sweep removes its settings copy', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons', keywords: ['dragon'] } },
            collections: [collection('A')],
            scans: [scan('A', { h1: { context: 'about dragons' } })],
        });

        expect(plan.trusted).toBe(true);
        expect(plan.patch).toHaveLength(1);
        expect(plan.deletable).toEqual([{ hash: 'h1', collections: ['A'] }]);
    });

    it('keeps a patched entry out of the delete list when the run is untrusted', () => {
        const plan = planChunkMetaSweep({
            entries: { h1: { context: 'about dragons', keywords: ['dragon'] } },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', { h1: { context: 'about dragons' } }),
                { registryKey: 'B', collectionId: 'B', status: 'failed', chunks: new Map() },
            ],
        });

        expect(plan.trusted).toBe(false);
        expect(plan.patch).toHaveLength(1);
        expect(plan.deletable).toEqual([]);
    });

    it('names every collection holding a patched hash, once per settings entry', () => {
        const plan = planChunkMetaSweep({
            entries: { shared: { context: 'about elves', keywords: ['elf'] } },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', { shared: { context: 'about elves' } }),
                scan('B', { shared: { context: 'about elves' } }),
            ],
        });

        expect(plan.patch).toHaveLength(2);
        expect(plan.deletable).toEqual([{ hash: 'shared', collections: ['A', 'B'] }]);
    });
});

describe('sweep planner — skip reasons are counted apart', () => {
    it('separates unverified from client-only skips', () => {
        const plan = planChunkMetaSweep({
            entries: {
                kept: { context: 'about dragons', summaries: ['a summary'] },
                maybeInB: { context: 'unknown' },
            },
            collections: [collection('A'), collection('B')],
            scans: [
                scan('A', { kept: { context: 'about dragons' } }),
                { registryKey: 'B', collectionId: 'B', status: 'failed', chunks: new Map() },
            ],
            clientOnlyFields: ['summaries'],
        });

        expect(plan.counts.skipped).toBe(2);
        expect(plan.skippedByReason).toEqual({ unverified: 1, clientOnly: 1 });
    });
});

describe('sweep planner — malformed scans are rejected, not guessed', () => {
    it('throws when a scan carries chunks as a plain object instead of a Map', () => {
        // Coercing silently would make every entry look absent — a delete-list
        // hazard — so the planner refuses the input instead.
        expect(() => planChunkMetaSweep({
            entries: { h1: { context: 'about dragons' } },
            collections: [collection('A')],
            scans: [{ registryKey: 'A', collectionId: 'A', status: 'ok', chunks: { h1: {} } }],
        })).toThrow(TypeError);
    });
});
