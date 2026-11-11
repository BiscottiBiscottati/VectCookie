/**
 * ============================================================================
 * FILE DOWNLOAD
 * ============================================================================
 * One way to save generated JSON from a panel. The Blob / object-URL / anchor
 * dance is the same everywhere a panel offers a download, so it lives here
 * instead of being copied into each panel.
 *
 * The object URL is revoked on a later task, not in the same tick as the click.
 * A large file — the chunk-metadata backup reaches megabytes — is copied by the
 * browser asynchronously, and revoking the URL immediately can cancel the
 * download in some browsers while the panel reports success.
 * ============================================================================
 */

/** How long a generated file's object URL stays alive after the click. */
const REVOKE_DELAY_MS = 1000;

/**
 * Saves `content` as a JSON file through a Blob download.
 * @param {string} filename
 * @param {string} content
 * @returns {boolean} False when the environment cannot create a download.
 */
export function downloadJsonFile(filename, content) {
    if (typeof Blob !== 'function'
        || typeof globalThis.URL?.createObjectURL !== 'function'
        || typeof document === 'undefined') {
        return false;
    }

    const blob = new Blob([content], { type: 'application/json' });
    const url = globalThis.URL.createObjectURL(blob);

    try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
    } catch (error) {
        // Nothing will consume the URL now; do not wait out the grace period.
        globalThis.URL.revokeObjectURL?.(url);
        throw error;
    }

    setTimeout(() => globalThis.URL.revokeObjectURL?.(url), REVOKE_DELAY_MS);
    return true;
}
