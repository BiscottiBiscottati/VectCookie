/**
 * Tests: chunk-metadata transfer (ticket 10 — export / import parity).
 *
 * The module under test is host-free on purpose: it decides which store an
 * export reads from and which store an import writes to. Tests call it with
 * plain objects and assert what the export file carries and what the import
 * would write, never how the decision is implemented.
 */

import { describe, it, expect } from 'vitest';

import {
    attachCollectionChunkMetadata,
    planChunkMetaImport,
} from '../core/chunk-meta-transfer.js';
import {
    chunkMetaEntryCountLabel,
    exportChunkMetaNotice,
    exportChunkMetaTotalsNotice,
    unmatchedChunkMetaCount,
} from '../core/chunk-meta-transfer-view.js';

/** A portable export chunk as fetchPortableChunks returns it. */
function portableChunk(hash, text, metadata = {}, vector = [0.1, 0.2]) {
    return { hash, text, index: Number(hash), vector, metadata };
}

describe('export: attachCollectionChunkMetadata', () => {
    it('reads metadata from the payload when the listing carries it', () => {
        const { chunks, report } = attachCollectionChunkMetadata({
            chunks: [portableChunk('1', 'alpha', { keywords: [{ text: 'alpha' }], context: 'payload ctx' })],
            legacyEntries: {},
        });

        expect(chunks[0].chunkMeta).toEqual({
            keywords: [{ text: 'alpha' }],
            context: 'payload ctx',
        });
        expect(report).toMatchObject({ chunks: 1, attached: 1 });
        expect(report.unmatchedSettingsEntries).toEqual({ count: 0 });
    });

    it('fills a field the payload lacks from the settings entry', () => {
        const { chunks, report } = attachCollectionChunkMetadata({
            chunks: [portableChunk('1', 'alpha', { context: 'payload ctx', chunkLinks: [] })],
            legacyEntries: { 1: { context: 'stale settings ctx', xmlTag: 'tag-from-settings' } },
        });

        // Payload wins where it holds a value; an empty field is an absence, so
        // it is not carried and does not hide the settings value.
        expect(chunks[0].chunkMeta).toEqual({
            context: 'payload ctx',
            xmlTag: 'tag-from-settings',
        });
        expect(report.attached).toBe(1);
    });

    it('reads from settings alone when the payload returned no metadata', () => {
        const { chunks, report } = attachCollectionChunkMetadata({
            chunks: [portableChunk('1', 'alpha', {})],
            legacyEntries: { 1: { context: 'settings only', summaries: [{ text: 'sum' }] } },
        });

        expect(chunks[0].chunkMeta).toEqual({
            context: 'settings only',
            summaries: [{ text: 'sum' }],
        });
        expect(report.attached).toBe(1);
    });

    it('never treats payload data keys as metadata', () => {
        const { chunks } = attachCollectionChunkMetadata({
            chunks: [portableChunk('1', 'alpha', { text: 'alpha', hash: 1, index: 0, vector: [1], context: 'ctx' })],
            legacyEntries: {},
        });

        expect(chunks[0].chunkMeta).toEqual({ context: 'ctx' });
    });

    it('leaves a chunk without metadata in either store without a chunkMeta key', () => {
        const { chunks, report } = attachCollectionChunkMetadata({
            chunks: [portableChunk('1', 'alpha', {})],
            legacyEntries: {},
        });

        expect(chunks[0]).not.toHaveProperty('chunkMeta');
        expect(report.attached).toBe(0);
    });

    it('handles an empty collection', () => {
        const { chunks, report, unmatchedSettingsHashes } = attachCollectionChunkMetadata({ chunks: [], legacyEntries: { 7: { context: 'x' } } });

        expect(chunks).toEqual([]);
        expect(report).toMatchObject({ chunks: 0, attached: 0 });
        // Nothing to attach to: the entry is reported, not dropped.
        expect(report.unmatchedSettingsEntries).toEqual({ count: 1 });
        expect(unmatchedSettingsHashes).toEqual(['7']);
    });

    it('does not carry the empty fields the export listing fills in for every chunk', () => {
        const { chunks, report } = attachCollectionChunkMetadata({
            chunks: [portableChunk('1', 'alpha', { keywords: [], chunkLinks: [], context: '' })],
            legacyEntries: {},
        });

        expect(chunks[0]).not.toHaveProperty('chunkMeta');
        expect(report.attached).toBe(0);
    });

    it('keeps a falsy value that means something', () => {
        const { chunks } = attachCollectionChunkMetadata({
            chunks: [portableChunk('1', 'alpha', { enabled: false, depth: 0, position: 'before' })],
            legacyEntries: {},
        });

        expect(chunks[0].chunkMeta).toEqual({ enabled: false, depth: 0, position: 'before' });
    });

    it('reports settings entries whose chunk the collection no longer has', () => {
        const { report, unmatchedSettingsHashes } = attachCollectionChunkMetadata({
            chunks: [portableChunk('1', 'alpha'), portableChunk('2', 'beta')],
            legacyEntries: {
                1: { context: 'kept' },
                2: { context: 'kept' },
                99: { context: 'gone' },
                abc: { context: 'also gone' },
            },
        });

        // The file carries the count only: the hashes are usually other
        // collections' content and an export must not travel with them.
        expect(report.unmatchedSettingsEntries).toEqual({ count: 2 });
        expect(unmatchedSettingsHashes).toEqual(['99', 'abc']);
        expect(report).toMatchObject({ chunks: 2, attached: 2 });
    });

    it('matches numeric and string hashes to the same chunk', () => {
        const { chunks, report, unmatchedSettingsHashes } = attachCollectionChunkMetadata({
            chunks: [portableChunk(123, 'alpha')],
            legacyEntries: { 123: { context: 'kept' } },
        });

        expect(chunks[0].chunkMeta).toEqual({ context: 'kept' });
        expect(report.unmatchedSettingsEntries.count).toBe(0);
        expect(unmatchedSettingsHashes).toEqual([]);
    });
});

describe('import: planChunkMetaImport', () => {
    const payloadExportChunk = (extra = {}) => ({
        text: 'alpha',
        metadata: { keywords: [{ text: 'alpha' }] },
        chunkMeta: { keywords: [{ text: 'alpha' }], context: 'ctx', summaries: [{ text: 'sum' }] },
        ...extra,
    });

    it('on the payload path merges the transferable fields into the insert metadata', () => {
        const plan = planChunkMetaImport({
            chunks: [payloadExportChunk()],
            isPayloadStore: true,
            clientOnlyFields: ['summaries'],
        });

        expect(plan.entries[0].metadata).toEqual({
            keywords: [{ text: 'alpha' }],
            context: 'ctx',
        });
        // The payload can never hold summaries: that field goes to settings.
        expect(plan.entries[0].settings).toEqual({ summaries: [{ text: 'sum' }] });
        expect(plan.counts).toEqual({ payloadChunks: 1, settingsChunks: 1 });
    });

    it('on the payload path writes no settings entry when the file carries no client-only field', () => {
        const plan = planChunkMetaImport({
            chunks: [{
                text: 'beta',
                metadata: {},
                chunkMeta: { context: 'ctx', chunkLinks: [{ targetHash: '2', mode: 'soft' }], updatedAt: 5 },
            }],
            isPayloadStore: true,
            clientOnlyFields: ['summaries'],
        });

        // Bookkeeping travels with the payload fields (splitForPayload decides
        // both halves), and nothing needs a settings entry.
        expect(plan.entries[0].metadata).toEqual({
            context: 'ctx',
            chunkLinks: [{ targetHash: '2', mode: 'soft' }],
            updatedAt: 5,
        });
        expect(plan.entries[0].settings).toBeNull();
        expect(plan.counts).toEqual({ payloadChunks: 1, settingsChunks: 0 });
    });

    it('on the payload path leaves the metadata untouched for a chunk with no chunkMeta', () => {
        const plan = planChunkMetaImport({
            chunks: [{ text: 'gamma', metadata: { keywords: [] } }],
            isPayloadStore: true,
            clientOnlyFields: ['summaries'],
        });

        expect(plan.entries[0].metadata).toEqual({ keywords: [] });
        expect(plan.entries[0].settings).toBeNull();
        expect(plan.counts).toEqual({ payloadChunks: 0, settingsChunks: 0 });
    });

    it('without the plugin writes every field to settings and nothing to the insert metadata', () => {
        const plan = planChunkMetaImport({
            chunks: [payloadExportChunk()],
            isPayloadStore: false,
            clientOnlyFields: ['summaries'],
        });

        expect(plan.entries[0].metadata).toEqual({ keywords: [{ text: 'alpha' }] });
        expect(plan.entries[0].settings).toEqual({
            keywords: [{ text: 'alpha' }],
            context: 'ctx',
            summaries: [{ text: 'sum' }],
        });
        expect(plan.counts).toEqual({ payloadChunks: 0, settingsChunks: 1 });
    });

    it('without the plugin writes nothing for a chunk with no chunkMeta', () => {
        const plan = planChunkMetaImport({
            chunks: [{ text: 'gamma', metadata: {} }],
            isPayloadStore: false,
        });

        expect(plan.entries[0].settings).toBeNull();
        expect(plan.counts).toEqual({ payloadChunks: 0, settingsChunks: 0 });
    });

    it('keeps one entry per input chunk, in order', () => {
        const plan = planChunkMetaImport({
            chunks: [
                { text: 'one', metadata: {}, chunkMeta: { context: '1' } },
                { text: 'two', metadata: {} },
                { text: 'three', metadata: {}, chunkMeta: { context: '3' } },
            ],
            isPayloadStore: true,
        });

        expect(plan.entries).toHaveLength(3);
        expect(plan.entries[0].metadata).toEqual({ context: '1' });
        expect(plan.entries[1].metadata).toEqual({});
        expect(plan.entries[2].metadata).toEqual({ context: '3' });
    });

    it('handles an empty import', () => {
        const plan = planChunkMetaImport({ chunks: [], isPayloadStore: true });
        expect(plan).toEqual({ entries: [], counts: { payloadChunks: 0, settingsChunks: 0 } });
    });
});

describe('export report labels', () => {
    const report = (count) => ({ unmatchedSettingsEntries: { count } });

    it('counts what an export could not carry, and zero for a missing report', () => {
        expect(unmatchedChunkMetaCount(report(3))).toBe(3);
        expect(unmatchedChunkMetaCount(report(0))).toBe(0);
        expect(unmatchedChunkMetaCount(undefined)).toBe(0);
        expect(unmatchedChunkMetaCount({})).toBe(0);
    });

    it('pluralises the count label once', () => {
        expect(chunkMetaEntryCountLabel(1)).toBe('1 chunk-metadata entry');
        expect(chunkMetaEntryCountLabel(0)).toBe('0 chunk-metadata entries');
        expect(chunkMetaEntryCountLabel(4)).toBe('4 chunk-metadata entries');
    });

    it('has nothing to say when every settings entry matched a chunk', () => {
        expect(exportChunkMetaNotice(report(0))).toBeNull();
        expect(exportChunkMetaNotice(undefined)).toBeNull();
        expect(exportChunkMetaNotice({})).toBeNull();
    });

    it('names the count and the collection, never claiming orphanhood', () => {
        const notice = exportChunkMetaNotice(report(3));
        expect(notice).toContain('3 chunk-metadata entries');
        expect(notice).toContain('no chunk in this collection');
        expect(notice).toContain('were not exported');
        expect(notice).toContain('Size Inspector');
        expect(notice).not.toMatch(/orphan(ed)? (entry|entries) (is|are) /);
    });

    it('agrees in the singular', () => {
        const notice = exportChunkMetaNotice(report(1));
        expect(notice).toContain('1 chunk-metadata entry');
        expect(notice).toContain('has no chunk');
        expect(notice).toContain('was not exported');
    });

    it('totals a bulk export without claiming distinct entries', () => {
        expect(exportChunkMetaTotalsNotice(0)).toBeNull();
        expect(exportChunkMetaTotalsNotice(2)).toContain('2 chunk-metadata entries');
        expect(exportChunkMetaTotalsNotice(2)).toContain('at least one exported collection');
        expect(exportChunkMetaTotalsNotice(1)).toContain('1 chunk-metadata entry');
    });
});
