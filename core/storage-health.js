/**
 * ============================================================================
 * VECTFOX STORAGE HEALTH
 * ============================================================================
 * Measures how large the extension-settings blob has become and turns it into
 * the labels the Size Inspector shows when its tab is opened.
 *
 * Why it exists (ADR-0003): a real library accumulated 17,104 chunk-metadata
 * keys — 9.45 MiB — inside `extension_settings.vectfox`, making that object
 * 47.3 MiB. SillyTavern downloads it twice per page load and re-uploads it in
 * full on every settings save, so the blob is the dominant startup cost over a
 * slow link. Nothing surfaced the number until the tunnel made it painful; this
 * module makes it visible on a screen that already exists.
 *
 * Read-only and network-free by construction: it takes the settings object and
 * returns numbers and labels. It issues no plugin request, starts no collection
 * scan and mutates nothing. Its one cost is serializing the settings object in
 * memory, which the UI pays only when the user opens the tab.
 *
 * Sizes are UTF-8 bytes of the serialized object: what actually crosses the
 * wire, not the JS character count (which under-reports non-ASCII text).
 * ============================================================================
 */

import { isChunkMetaSettingsKey } from './chunk-meta-keys.js';

/** Sane upper bound for the extension settings blob — the post-sweep target. */
const WARN_BYTES = 2 * 1024 * 1024;

/** How many individual settings keys the Size Inspector names as top contributors. */
const TOP_KEY_LIMIT = 10;

const SIZE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/**
 * Human label for a byte count: 0 B, 812 B, 9.45 MiB, 47.3 MiB.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    if (unit === 0) {
        return `${Math.round(value)} B`;
    }
    return `${parseFloat(value.toFixed(2))} ${SIZE_UNITS[unit]}`;
}

/** Thousands-grouped number for labels: 17104 -> "17,104". */
function formatCount(value) {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Everything the UI shows about one measured size: the raw bytes, the short
 * human label, and the exact grouped byte count.
 * @param {number} bytes
 * @returns {{ bytes: number, sizeLabel: string, exactLabel: string }}
 */
function sizeInfo(bytes) {
    return { bytes, sizeLabel: formatSize(bytes), exactLabel: formatCount(bytes) };
}

/** UTF-8 byte length of a string, matching what JSON on the wire costs. */
function utf8ByteLength(text) {
    let bytes = 0;
    for (const character of text) {
        const codePoint = character.codePointAt(0);
        bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    }
    return bytes;
}

/** Serialized size of one settings value; 0 for values JSON drops (undefined). */
function serializedSize(value) {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : utf8ByteLength(text);
}

/**
 * Sizes the chunk-metadata entries held in settings. Those are the keys the
 * legacy store minted (core/chunk-meta-keys.js defines the namespace); they are
 * reported as one group because a real library holds 17,104 of them and each
 * individual key is small enough to crowd every other key out of the top list.
 * @param {object} settings
 * @returns {{ count: number, countLabel: string, bytes: number, sizeLabel: string, exactLabel: string }}
 */
function measureChunkMeta(settings) {
    let count = 0;
    let bytes = 0;
    for (const key of Object.keys(settings)) {
        if (!isChunkMetaSettingsKey(key)) continue;
        count += 1;
        bytes += serializedSize(settings[key]);
    }
    return { count, countLabel: formatCount(count), ...sizeInfo(bytes) };
}

/**
 * The settings keys that account for the most bytes, largest first. The
 * chunk-metadata namespace is left out on purpose: it is reported once, with its
 * entry count, and 17,104 keys of the same shape would otherwise fill every row
 * while saying nothing the group line does not already say.
 * @param {object} settings
 * @returns {Array<{ key: string, bytes: number, sizeLabel: string, exactLabel: string }>}
 */
function measureTopKeys(settings) {
    const rows = [];
    for (const key of Object.keys(settings)) {
        if (isChunkMetaSettingsKey(key)) continue;
        rows.push({ key, ...sizeInfo(serializedSize(settings[key])) });
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    return rows.slice(0, TOP_KEY_LIMIT);
}

/**
 * The warning shown past the limit. It always names the chunk-metadata count:
 * that is the known way this blob gets big (ADR-0003), so the warning tells the
 * user whether this is the leak or something else grew.
 * @param {{ bytes: number, sizeLabel: string }} total
 * @param {{ count: number, countLabel: string, sizeLabel: string }} chunkMeta
 * @returns {string|null}
 */
function warningFor(total, chunkMeta) {
    if (total.bytes <= WARN_BYTES) {
        return null;
    }
    const chunkLine = chunkMeta.count === 0
        ? 'No chunk-metadata entries in settings.'
        : `${chunkMeta.countLabel} chunk-metadata ${chunkMeta.count === 1 ? 'entry accounts' : 'entries account'} for ${chunkMeta.sizeLabel}.`;
    return `Extension settings are ${total.sizeLabel} — past the ${formatSize(WARN_BYTES)} health limit. ${chunkLine}`;
}

function unavailableView(reason) {
    return {
        status: 'unavailable',
        reason,
        total: sizeInfo(0),
        chunkMeta: measureChunkMeta({}),
        topKeys: [],
        warning: null,
    };
}

/**
 * Builds the Size Inspector's storage-health view model.
 * @param {object|null|undefined} settings The extension settings object
 *     (`extension_settings.vectfox`).
 * @returns {object} View model: status, measured sizes, top keys and warning.
 */
export function buildStorageHealth(settings) {
    if (!settings || typeof settings !== 'object') {
        return unavailableView('Extension settings are not available yet.');
    }

    let serialized;
    try {
        serialized = JSON.stringify(settings);
    } catch (err) {
        return unavailableView(`Extension settings could not be measured: ${err.message}`);
    }
    if (serialized === undefined) {
        return unavailableView('Extension settings could not be measured.');
    }

    const total = sizeInfo(utf8ByteLength(serialized));
    const chunkMeta = measureChunkMeta(settings);

    return {
        status: 'measured',
        total,
        chunkMeta,
        topKeys: measureTopKeys(settings),
        warning: warningFor(total, chunkMeta),
    };
}
