/**
 * Shared file-download helper.
 *
 * The chunk-metadata backup reaches megabytes, so the object URL must outlive
 * the click by a moment: revoking it in the same tick can cancel the browser's
 * copy while the panel reports success. These tests pin that deferral, the JSON
 * MIME type, and the two failure paths.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

import { downloadJsonFile } from '../utils/file-download.js';

/** Replaces the URL constructor's object-URL methods with spies. */
function stubObjectUrl({ url = 'blob:file' } = {}) {
    const createObjectURL = vi.fn(() => url);
    const revokeObjectURL = vi.fn();
    const OriginalURL = globalThis.URL;
    const Urls = class extends OriginalURL {};
    Urls.createObjectURL = createObjectURL;
    Urls.revokeObjectURL = revokeObjectURL;
    vi.stubGlobal('URL', Urls);
    return { createObjectURL, revokeObjectURL };
}

/** Reads a Blob's text in jsdom, which has no Blob#text(). */
function readText(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsText(blob);
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('downloadJsonFile', () => {
    it('saves the content as an application/json download', async () => {
        const { createObjectURL } = stubObjectUrl();
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        const saved = downloadJsonFile('backup.json', '{"entries":[]}');

        expect(saved).toBe(true);
        expect(click).toHaveBeenCalledTimes(1);
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        const blob = createObjectURL.mock.calls[0][0];
        expect(blob.type).toBe('application/json');
        expect(await readText(blob)).toBe('{"entries":[]}');
    });

    it('revokes the object URL on a later task, not in the click tick', () => {
        vi.useFakeTimers();
        const { revokeObjectURL } = stubObjectUrl({ url: 'blob:backup' });
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

        downloadJsonFile('backup.json', '{}');

        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:backup');
    });

    it('revokes immediately and rethrows when the download cannot start', () => {
        const { revokeObjectURL } = stubObjectUrl();
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
            throw new Error('blocked');
        });

        expect(() => downloadJsonFile('backup.json', '{}')).toThrow('blocked');
        expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    });

    it('reports false when the environment has no object-URL support', () => {
        const OriginalURL = globalThis.URL;
        vi.stubGlobal('URL', class extends OriginalURL {});

        expect(downloadJsonFile('backup.json', '{}')).toBe(false);
    });
});
