/**
 * Storage health — the Size Inspector's settings-size view model.
 *
 * ADR-0003: a real library accumulated 17,104 chunk-metadata keys inside
 * `extension_settings.vectfox`, making the blob 47.3 MiB, and nobody saw it until
 * a WireGuard tunnel made startup take 20–25 s. These tests pin the measurement
 * the Size Inspector shows on open: the serialized size, the top contributing
 * keys, the chunk-metadata entry count and the over-threshold warning.
 *
 * The seam is the view model: numbers and labels only. Rendering is covered by
 * size-inspector.test.js.
 */

import { describe, it, expect } from 'vitest';

import { buildStorageHealth } from '../core/storage-health.js';
import {
    PENDING_RETRY_KEY,
    RETRY_QUEUE_CAP,
    upsertRetryRecord,
} from '../core/chunk-meta-retry.js';
import { settingsByteSize } from './fixtures/settings-bytes.js';

/**
 * Independent measurement — UTF-8 bytes on the wire, from Node's own encoder
 * rather than this module's code-point walk.
 */
function independentBytes(settings) {
    return settingsByteSize(settings);
}

/** 1200 chunk-metadata entries — the shape a real library accumulates. */
function chunkEntries(count) {
    const entries = {};
    for (let i = 0; i < count; i++) {
        entries[`vectfox_chunk_meta_${i}`] = { context: `chunk ${i}` };
    }
    return entries;
}

describe('storage health — serialized size', () => {
    it('counts UTF-8 bytes, not characters', () => {
        // Hand-counted worked example: {"k":"é"} is 9 characters, and é is two
        // bytes in UTF-8, so it crosses the wire as 10 bytes.
        const view = buildStorageHealth({ k: 'é' });

        expect(view.total.bytes).toBe(10);
        expect(view.total.exactLabel).toBe('10');
        expect(view.total.sizeLabel).toBe('10 B');
    });

    it('matches an independent byte measurement on a multibyte blob', () => {
        const settings = {
            chunk_size: 500,
            profiles: { default: { model: 'x'.repeat(400) } },
            'vectfox_chunk_meta_abc': { context: 'é'.repeat(600) },
        };

        const view = buildStorageHealth(settings);

        expect(view.status).toBe('measured');
        expect(view.total.bytes).toBe(independentBytes(settings));
    });

    it('reports unavailable rather than a size when the settings object is missing', () => {
        const view = buildStorageHealth(undefined);

        expect(view.status).toBe('unavailable');
        expect(view.total.bytes).toBe(0);
        expect(view.total.exactLabel).toBe('0');
        expect(view.topKeys).toEqual([]);
        expect(view.warning).toBeNull();
    });

    it('reports unavailable when the settings cannot be serialized', () => {
        const circular = { chunk_size: 500 };
        circular.self = circular;

        const view = buildStorageHealth(circular);

        expect(view.status).toBe('unavailable');
        expect(view.total.sizeLabel).toBe('0 B');
        expect(view.warning).toBeNull();
    });
});

describe('storage health — chunk-metadata entries', () => {
    it('counts the chunk-metadata entries held in settings and sizes them separately', () => {
        const entries = {
            'vectfox_chunk_meta_a': { context: 'alpha' },
            'vectfox_chunk_meta_b': { context: 'beta' },
            'vectfox_chunk_meta_c': { context: 'gamma', chunkLinks: [{ targetHash: 'a' }] },
        };
        const settings = {
            chunk_size: 500,
            chunk_meta_store: 'auto',
            'vectfox_collections': { 'Qdrant:lore': { enabled: true } },
            ...entries,
        };
        const independentChunkBytes = Object.values(entries)
            .reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0);

        const view = buildStorageHealth(settings);

        expect(view.chunkMeta.count).toBe(3);
        expect(view.chunkMeta.countLabel).toBe('3');
        expect(view.chunkMeta.bytes).toBe(independentChunkBytes);
    });

    it('reports a single entry as one, not zero or many', () => {
        const view = buildStorageHealth({
            'vectfox_chunk_meta_a': { context: 'alpha' },
        });

        expect(view.chunkMeta.count).toBe(1);
        expect(view.chunkMeta.countLabel).toBe('1');
        expect(view.chunkMeta.bytes).toBeGreaterThan(0);
    });

    it('reports zero entries when the settings hold no chunk metadata', () => {
        const view = buildStorageHealth({ chunk_size: 500 });

        expect(view.chunkMeta.count).toBe(0);
        expect(view.chunkMeta.countLabel).toBe('0');
        expect(view.chunkMeta.sizeLabel).toBe('0 B');
    });
});

describe('storage health — failed-write retry queue', () => {
    /** Settings carrying `count` pending payload repairs. */
    function withRetryRecords(count) {
        const settings = { chunk_size: 500 };
        for (let i = 0; i < count; i++) {
            upsertRetryRecord(settings, { collectionId: 'col-a', hash: String(i), fields: ['context'] });
        }
        return settings;
    }

    it('reports an empty queue on a healthy install', () => {
        const view = buildStorageHealth({ chunk_size: 500 });

        expect(view.retry).toMatchObject({ pending: 0, cap: RETRY_QUEUE_CAP });
        expect(view.retry.depthLabel).toBe(`0 of ${RETRY_QUEUE_CAP}`);
        expect(view.retry.warning).toBeNull();
    });

    it('reports the depth of the pending payload repairs', () => {
        const view = buildStorageHealth(withRetryRecords(3));

        expect(view.retry.pending).toBe(3);
        expect(view.retry.depthLabel).toBe(`3 of ${RETRY_QUEUE_CAP}`);
        expect(view.retry.detail).toContain('3 edits');
        expect(view.retry.warning).toBeNull();
    });

    it('says one edit, not one edits', () => {
        const view = buildStorageHealth(withRetryRecords(1));

        expect(view.retry.detail).toContain('1 edit');
        expect(view.retry.detail).not.toContain('1 edits');
    });

    it('warns when the bounded queue is full', () => {
        const view = buildStorageHealth(withRetryRecords(RETRY_QUEUE_CAP));

        expect(view.retry.pending).toBe(RETRY_QUEUE_CAP);
        expect(view.retry.warning).toContain('full');
        expect(view.retry.warning).toContain(`${RETRY_QUEUE_CAP} of ${RETRY_QUEUE_CAP}`);
        // A full queue has not dropped anything yet; the warning must not say it has.
        expect(view.retry.warning).not.toContain('and dropped');
    });

    it('reports a repair the cap actually dropped, from the store\'s session state', () => {
        const view = buildStorageHealth(withRetryRecords(2), {
            retryState: { pending: 2, cap: RETRY_QUEUE_CAP, dropped: 1 },
        });

        expect(view.retry.dropped).toBe(1);
        expect(view.retry.warning).toContain('dropped 1 pending repair');
        expect(view.retry.warning).toContain('stay in settings');
    });

    it('does not report a drop when the session reports none', () => {
        const view = buildStorageHealth(withRetryRecords(2), {
            retryState: { pending: 2, cap: RETRY_QUEUE_CAP, dropped: 0 },
        });

        expect(view.retry.dropped).toBe(0);
        expect(view.retry.warning).toBeNull();
    });

    it('ignores a malformed queue rather than counting it', () => {
        const view = buildStorageHealth({ [PENDING_RETRY_KEY]: { records: 'not a list' } });

        expect(view.retry.pending).toBe(0);
    });

    it('reports an empty queue when the settings are unavailable', () => {
        const view = buildStorageHealth(null);

        expect(view.status).toBe('unavailable');
        expect(view.retry).toMatchObject({ pending: 0, cap: RETRY_QUEUE_CAP });
    });
});

describe('storage health — over-threshold warning', () => {
    it('stays quiet while the settings are below the limit', () => {
        const view = buildStorageHealth({
            chunk_size: 500,
            ...chunkEntries(50),
        });

        expect(view.warning).toBeNull();
    });

    it('stays quiet exactly at the limit and warns one byte past it', () => {
        // {"filler":"<N chars>"} serializes to N + 13 bytes.
        const atLimit = { filler: 'x'.repeat(2 * 1024 * 1024 - 13) };
        const overLimit = { filler: 'x'.repeat(2 * 1024 * 1024 - 12) };

        const at = buildStorageHealth(atLimit);
        const over = buildStorageHealth(overLimit);

        expect(at.total.bytes).toBe(2 * 1024 * 1024);
        expect(at.warning).toBeNull();
        expect(over.total.bytes).toBe(2 * 1024 * 1024 + 1);
        expect(over.warning).toContain('past the 2 MiB health limit');
    });

    it('warns past the limit and names how many chunk-metadata entries are held', () => {
        const view = buildStorageHealth({
            // 3 MiB of something else, so the warning cannot be about the entries alone.
            profiles: { default: { model: 'x'.repeat(3 * 1024 * 1024) } },
            ...chunkEntries(1200),
        });

        expect(view.warning).toContain('2 MiB');
        expect(view.warning).toContain('1,200 chunk-metadata entries');
        expect(view.warning).toContain(view.total.sizeLabel);
    });

    it('still warns past the limit when no chunk metadata is held', () => {
        const view = buildStorageHealth({
            profiles: { default: { model: 'x'.repeat(3 * 1024 * 1024) } },
        });

        expect(view.warning).toContain('No chunk-metadata entries');
    });
});

describe('storage health — top contributing keys', () => {
    it('lists the largest settings keys with their sizes, largest first', () => {
        const settings = {
            a_small: 'x'.repeat(10),
            b_medium: 'x'.repeat(500),
            c_large: { model: 'x'.repeat(5000) },
        };
        for (let i = 0; i < 10; i++) {
            settings[`filler_${i}`] = 'x'.repeat(i);
        }

        const view = buildStorageHealth(settings);

        expect(view.topKeys).toHaveLength(10);
        expect(view.topKeys[0].key).toBe('c_large');
        expect(view.topKeys[1].key).toBe('b_medium');
        expect(view.topKeys[0].bytes)
            .toBe(Buffer.byteLength(JSON.stringify(settings.c_large), 'utf8'));
        expect(view.topKeys[0].sizeLabel).toMatch(/KiB/);
        // The smallest keys are cut by the top-10 cap.
        expect(view.topKeys.map(entry => entry.key)).not.toContain('filler_0');
        for (let i = 1; i < view.topKeys.length; i++) {
            expect(view.topKeys[i - 1].bytes)
                .toBeGreaterThanOrEqual(view.topKeys[i].bytes);
        }
    });

    it('does not flood the list with individual chunk-metadata entries', () => {
        const settings = {
            profiles: { default: { model: 'x'.repeat(1000) } },
            'vectfox_chunk_meta_a': { context: 'alpha' },
            'vectfox_chunk_meta_b': { context: 'beta' },
        };

        const view = buildStorageHealth(settings);

        expect(view.chunkMeta.count).toBe(2);
        expect(view.topKeys.map(entry => entry.key)).toEqual(['profiles']);
    });

    it('reports no rows for empty settings', () => {
        const view = buildStorageHealth({});

        expect(view.status).toBe('measured');
        expect(view.total.bytes).toBe(Buffer.byteLength('{}', 'utf8'));
        expect(view.topKeys).toEqual([]);
        expect(view.chunkMeta.count).toBe(0);
    });
});
