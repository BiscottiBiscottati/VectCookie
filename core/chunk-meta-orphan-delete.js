/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA ORPHAN DELETION
 * ============================================================================
 * The last destructive step of the staged migration (ADR-0003 decision 6):
 * settings entries whose chunk exists in no registered collection. The dry run
 * reports them; this module is the only thing that removes them, and it removes
 * nothing until a counted confirmation says yes.
 *
 * Why a confirmation at all: an orphan is proved absent from every registered
 * collection *at scan time*, but "registered" is the boundary. A collection that
 * exists on a backend without being discovered looks exactly like a deleted
 * one, and chunk hashes are content-derived, so one settings key can be the only
 * metadata for text that still lives somewhere. The sweep therefore leaves
 * orphans alone and the user, shown the count and the released size, makes the
 * call. The dialog is unbounded human time, so absence is not re-verified while
 * it is open: a collection restored during the dialog can lose its settings
 * copy, which is the same snapshot limit the sweep documents.
 *
 * The rules, straight from the feature spec:
 *
 *   - Only a trusted plan may produce a deletion. The planner empties its orphan
 *     list when any registered collection could not be read; the decision
 *     refuses a plan that is untrusted anyway, and the executor refuses any
 *     decision that does not carry the trusted flag. A hand-built decision is
 *     an internal seam, not a user path, and cannot claim trust it was not
 *     given.
 *   - The decision names only entries that are still in settings. A plan can
 *     predate a concurrent deletion, and a dialog that promises to remove an
 *     entry that is already gone would disagree with the removal count.
 *   - Nothing is deleted before the confirmation resolves true. Cancelling, or
 *     a caller that supplies no confirmation at all, removes nothing and saves
 *     nothing — the destructive path fails closed.
 *   - Only orphans are touched. Redundant, patchable, client-only and unverified
 *     entries are not part of the decision and cannot arrive through it.
 *   - One save follows the run, however many entries go. The deletions mutate
 *     the settings object only; a failed save is reported beside the counts and
 *     never turns a completed deletion into a thrown error.
 *   - Counts describe this run: how many settings keys were removed, how many
 *     were already gone, and only the size those removed entries actually
 *     released. A cancelled or stopped run reports a partial figure, never the
 *     whole decision's predicted size.
 *
 * Host-free: the settings deletion, the persistence and the confirmation are
 * injected by the composition in core/chunk-meta-storage-actions.js. No DOM, no
 * SillyTavern imports, no transport.
 * ============================================================================
 */

import { carriesClientOnlyMetadata } from './chunk-meta-fields.js';
import { chunkMetaSettingsKey } from './chunk-meta-keys.js';
import { serializedSize } from './storage-health.js';

/**
 * What the decision concluded:
 *   - `refused` a collection could not be read, so absence proves nothing
 *   - `empty`   the run was trusted and found no orphan to remove
 *   - `ready`   a trusted plan named orphans; the confirmation may be shown
 * @typedef {'refused'|'empty'|'ready'} OrphanDeleteDecisionStatus
 */

/**
 * Whether the settings object owns this key. Own-property only: a prototype
 * member is not a persisted entry and must never be counted as one.
 * @param {object|null|undefined} settings
 * @param {string} key
 * @returns {boolean}
 */
function ownsKey(settings, key) {
    return Boolean(settings) && typeof settings === 'object'
        && Object.prototype.hasOwnProperty.call(settings, key);
}

/**
 * Per-entry serialized cost: `"key":value`, with the quotes and colon that
 * JSON writes. Costs exclude the comma separator, which `releasedBytesFor`
 * accounts for once it knows how many entries go.
 * @param {object|null|undefined} settings
 * @param {string} hash Chunk hash.
 * @returns {number} Bytes, 0 when the value is not serialized at all.
 */
function costOfEntry(settings, hash) {
    const key = chunkMetaSettingsKey(hash);
    const valueBytes = serializedSize(settings?.[key]);
    if (valueBytes === 0) return 0;
    return serializedSize(key) + 1 + valueBytes;
}

/**
 * Bytes the settings payload loses when exactly these hashes are removed.
 *
 * The panel measures `JSON.stringify(settings)` in UTF-8, so an entry costs its
 * `"key":value` text plus the comma that separated it; removing every entry
 * leaves `{}`, so one comma fewer disappears. Computed from the decision's
 * per-entry costs rather than by serializing a copy of the whole settings
 * object — on the 17k-entry library this feature targets, a second full
 * serialization would block the click. `serializableKeys` counts only the keys
 * whose values JSON writes, so a dropped value never buys a comma correction.
 * @param {Object<string, number>} costs Per-hash entry cost.
 * @param {string[]} hashes Entries removed.
 * @param {number} serializableKeys Total own keys in the settings object.
 * @returns {number}
 */
function releasedBytesFor(costs, hashes, serializableKeys) {
    let released = 0;
    let removed = 0;
    for (const hash of hashes) {
        const cost = costs?.[hash] || 0;
        if (cost <= 0) continue;
        released += cost;
        removed += 1;
    }
    if (removed === 0) return 0;
    return released + removed - (removed === serializableKeys ? 1 : 0);
}

/**
 * How many of the settings object's own keys `JSON.stringify` actually writes.
 * Counted without serializing any value: a value of `undefined`, a function or
 * a symbol is dropped together with its key, and such a key must not be counted
 * when the release formula corrects for the object's final comma.
 * @param {object|null|undefined} settings
 * @returns {number}
 */
function countSerializableKeys(settings) {
    if (!settings || typeof settings !== 'object') return 0;
    let count = 0;
    for (const key of Object.keys(settings)) {
        const value = settings[key];
        if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
        count += 1;
    }
    return count;
}

/**
 * Turns a completed sweep plan into the deletion decision: which settings
 * entries may go, and what removing them releases. Read-only and pure — it
 * mutates neither the plan nor the settings.
 *
 * The hashes come from the plan's orphan list only, and only for a trusted
 * plan. A plan that is untrusted is refused rather than filtered: if any
 * registered collection could not be read, no entry is provably an orphan.
 * The list is then narrowed three ways, so the count the dialog shows is the
 * count the run can actually remove:
 *
 *   - a hash whose settings entry is already gone is dropped (a concurrent
 *     deletion can outrun the plan);
 *   - a hash holding client-only metadata is dropped: the planner already
 *     keeps those, and a hand-built plan must not be able to discard the only
 *     copy of `summaries` by listing it as an orphan;
 *   - the remainder is priced per entry, so a later partial run reports only
 *     what it actually released.
 *
 * @param {object} input
 * @param {object} input.plan Output of planChunkMetaSweep().
 * @param {object|null|undefined} [input.settings] The live settings object, for
 *     the entry filters and the released-size measurement.
 * @param {Iterable<string>} [input.clientOnlyFields] Fields with no payload
 *     representation; entries holding them are never deleted.
 * @returns {{
 *   status: OrphanDeleteDecisionStatus,
 *   trusted: boolean,
 *   hashes: string[],
 *   entries: number,
 *   bytes: number,
 *   costs: Object<string, number>,
 *   serializableKeys: number,
 * }}
 */
export function decideChunkMetaOrphanDelete({
    plan,
    settings,
    clientOnlyFields = [],
} = {}) {
    if (!plan || typeof plan !== 'object' || !plan.counts || !plan.coverage) {
        throw new TypeError(
            'a chunk-metadata orphan deletion needs the plan from a completed scan',
        );
    }

    const trusted = plan.trusted === true;
    const hashes = (trusted ? (plan.orphan || []) : [])
        .map(record => String(record?.hash ?? ''))
        .filter(hash => hash.length > 0)
        .filter(hash => ownsKey(settings, chunkMetaSettingsKey(hash)))
        .filter(hash => !carriesClientOnlyMetadata(
            settings?.[chunkMetaSettingsKey(hash)],
            clientOnlyFields,
        ));

    const costs = {};
    for (const hash of hashes) costs[hash] = costOfEntry(settings, hash);
    const serializableKeys = countSerializableKeys(settings);

    return {
        status: !trusted ? 'refused' : hashes.length === 0 ? 'empty' : 'ready',
        trusted,
        hashes,
        entries: hashes.length,
        bytes: trusted ? releasedBytesFor(costs, hashes, serializableKeys) : 0,
        costs,
        serializableKeys,
    };
}

/** A non-negative integer from a decision field. */
function countOf(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Executes a decision: confirms, then removes exactly the orphan settings
 * entries it names, with one save after them. See the module header for the
 * safety rules.
 *
 * @param {object} options
 * @param {object} options.decision Output of decideChunkMetaOrphanDelete().
 * @param {(decision: object) => (boolean|Promise<boolean>)} [options.confirmDelete]
 *     Shows the counted confirmation. Absent, it is treated as "no" — the
 *     destructive path fails closed.
 * @param {(hash: string) => boolean|void} [options.deleteEntry]
 *     Removes one legacy settings entry, without saving; false when there was
 *     nothing to remove.
 * @param {() => void} [options.persistSettings] Persists the settings, once.
 * @param {(progress: { done: number, total: number, deleted: number }) => void} [options.onProgress]
 * @returns {Promise<{
 *   status: 'refused'|'empty'|'cancelled'|'complete'|'aborted',
 *   trusted: boolean,
 *   entries: number,
 *   bytes: number,
 *   releasedBytes: number,
 *   counts: { deleted: number, skipped: number },
 *   error: string|null,
 *   saveError: string|null,
 * }>}
 */
export async function executeChunkMetaOrphanDelete({
    decision,
    confirmDelete,
    deleteEntry = () => false,
    persistSettings = () => {},
    onProgress,
} = {}) {
    if (!decision || typeof decision !== 'object' || !Array.isArray(decision.hashes)) {
        throw new TypeError(
            'a chunk-metadata orphan deletion needs the decision from a completed plan',
        );
    }

    const trusted = decision.trusted === true;
    const hashes = trusted
        ? decision.hashes.map(hash => String(hash)).filter(hash => hash.length > 0)
        : [];
    const result = {
        trusted,
        entries: countOf(decision.entries) || hashes.length,
        bytes: trusted ? countOf(decision.bytes) : 0,
        // The decision's `bytes` prices everything it offered; this is what the
        // run actually removed, so a cancel or a stop never reports a release
        // that did not happen.
        releasedBytes: 0,
        counts: { deleted: 0, skipped: 0 },
        error: null,
        saveError: null,
    };

    // Untrusted or empty never reaches the user: there is nothing to confirm.
    if (!trusted) return { ...result, status: 'refused' };
    if (hashes.length === 0) return { ...result, status: 'empty' };

    // Fail closed: a missing or throwing confirmation is a "no".
    let confirmed = false;
    try {
        confirmed = (await confirmDelete?.(decision)) === true;
    } catch {
        confirmed = false;
    }
    if (!confirmed) return { ...result, status: 'cancelled' };

    let failure = null;
    let done = 0;
    const removed = [];
    for (const hash of hashes) {
        try {
            if (deleteEntry(hash) === false) {
                result.counts.skipped += 1;
            } else {
                result.counts.deleted += 1;
                removed.push(hash);
            }
        } catch (error) {
            failure = error;
            break;
        }
        done += 1;
        onProgress?.({
            done,
            total: hashes.length,
            deleted: result.counts.deleted,
        });
    }
    result.releasedBytes = releasedBytesFor(
        decision.costs,
        removed,
        countOf(decision.serializableKeys),
    );

    // What was removed is in memory either way; a failed save must not read as
    // "nothing was deleted". It is reported beside the counts instead.
    let saveError = null;
    if (result.counts.deleted > 0) {
        try {
            persistSettings?.();
        } catch (error) {
            saveError = error?.message || String(error);
        }
    }

    return {
        ...result,
        status: failure ? 'aborted' : 'complete',
        error: failure ? (failure.message || String(failure)) : null,
        saveError,
    };
}
