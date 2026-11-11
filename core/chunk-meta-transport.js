/**
 * VECTFOX CHUNK METADATA TRANSPORT
 *
 * The only two plugin operations the chunk metadata store needs, so its policy
 * can be tested with fakes and no new plugin endpoint is required:
 *   - list a collection's chunks (paginated, returning hash plus payload metadata)
 *   - patch one chunk's metadata (no re-embedding)
 *
 * Both map onto backend methods the extension already ships. The transport is
 * injected into core/collection-metadata.js's store from index.js (wiring owns
 * the backend/plugin dependency); it is not imported by the store itself.
 */

import { getBackend } from '../backends/backend-manager.js';
import { isPluginAvailableCached } from './collection-loader.js';
import { parseRegistryKey } from './collection-ids.js';

/**
 * @param {object} deps
 * @param {() => object|null} deps.getSettings - current VectFox settings
 * @returns {{
 *   isAvailable: () => boolean,
 *   listChunks: (collectionId: string, options?: { offset?: number, limit?: number }) => Promise<{ items: object[] }>,
 *   patchMetadata: (collectionId: string, hash: string|number, metadata: object) => Promise<void>,
 * }}
 */
export function createPluginChunkTransport({ getSettings }) {
    /**
     * Resolve the backend and the bare collection ID together. A registry key
     * ("backend:collection") carries its own backend; a bare ID uses the
     * configured default. This is the routing rule the retrieval and export
     * paths already follow.
     */
    async function getTargetBackend(collectionId, settings) {
        const parsed = parseRegistryKey(collectionId);
        const backendName = parsed.backend || settings.vector_backend || 'standard';
        return {
            backend: await getBackend(settings, backendName),
            bareCollectionId: parsed.collectionId || collectionId,
        };
    }

    return {
        /** Payload writes need the plugin; the probe is settled by discovery. */
        isAvailable: () => isPluginAvailableCached(),

        async listChunks(collectionId, { offset = 0, limit = 500 } = {}) {
            const settings = getSettings();
            if (!settings) throw new Error('VectFox settings unavailable');
            const { backend, bareCollectionId } = await getTargetBackend(collectionId, settings);
            const result = await backend.listChunks(bareCollectionId, settings, { offset, limit });
            return { items: Array.isArray(result?.items) ? result.items : [] };
        },

        async patchMetadata(collectionId, hash, metadata) {
            const settings = getSettings();
            if (!settings) throw new Error('VectFox settings unavailable');
            const { backend, bareCollectionId } = await getTargetBackend(collectionId, settings);
            await backend.updateChunkMetadata(bareCollectionId, hash, metadata, settings);
        },
    };
}
