/**
 * Serialized size of a settings object in UTF-8 bytes — what actually crosses
 * the wire, measured by Node's own encoder rather than by the module under
 * test. The storage-health, sweep, and orphan-deletion tests all assert that a
 * destructive action shrinks this number, so the independent measurement lives
 * here instead of being redefined per file.
 */

/**
 * @param {object} settings A settings object.
 * @returns {number} UTF-8 byte length of its JSON serialization.
 */
export function settingsByteSize(settings) {
    return Buffer.byteLength(JSON.stringify(settings), 'utf8');
}
