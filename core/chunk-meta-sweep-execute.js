/**
 * ============================================================================
 * VECTFOX CHUNK-METADATA SWEEP EXECUTION
 * ============================================================================
 * The one explicit, mutating action of the staged migration (ADR-0003 decision
 * 6). It takes the plan core/chunk-meta-sweep.js produced from a completed scan
 * and:
 *
 *   - patches every payload field the settings entry holds and the payload lacks
 *   - removes the settings copy of every entry the payload supersedes
 *   - leaves orphans, unverified entries and client-only entries untouched
 *
 * Safety rules, straight from the feature spec:
 *
 *   - Batching. Work proceeds in batches. A batch's payload writes all happen
 *     before the batch's deletions, so a failure anywhere in a batch aborts the
 *     run and deletes nothing from the batch that failed — an entry is never
 *     removed before the value it held is known to be in the payload.
 *   - An untrusted plan deletes nothing. The planner already empties the delete
 *     list when any collection could not be read; this module refuses a delete
 *     list that arrives anyway, so a hand-built plan cannot bypass the rule.
 *   - One save. Deletions mutate the settings object only; a single
 *     `persistSettings` call follows the whole run, however many entries moved.
 *   - A stamp. Mode, counts and timestamps of the run are written after every
 *     run, so support can tell a migrated install from an unmigrated one and a
 *     later run can resume an interrupted one. Counts describe the run that
 *     just happened, never a running total: "62 removed" must not creep upward
 *     across attempts. A failed save marks the stamp `persisted: false`, so an
 *     in-memory completion is not mistaken for a finished migration.
 *   - A failed save is reported, not thrown. The deletions and the stamp are in
 *     memory by then; a throwing save would turn a completed run into "Sweep
 *     failed" and hide what it did. The caller surfaces the save error beside
 *     the counts.
 *   - A second complete run is a no-op: with a complete stamp, a trusted plan
 *     and no remaining work there is no write, no patch and no save. An
 *     untrusted plan never takes that path — it cannot prove the migration is
 *     finished, so calling it "nothing to sweep" would be a lie.
 *
 * Resumption is honest rather than stateful. The settings entries a finished
 * batch removed are gone from the next scan, and a batch that aborted left its
 * settings copies in place — so the next run's plan contains exactly the work
 * that is left, and re-patching an entry the earlier attempt completed is
 * impossible because its payload no longer lacks a field. The stamp supplies the
 * attempt's identity (start time, mode) and tells the UI the run is continuing
 * one that stopped. A hard interruption (tab closed) leaves no stamp, because
 * the one permitted save follows the run; progress is always re-derived from the
 * scan, and no payload write is repeated.
 *
 * Known limit: deletion decisions come from the scan's snapshot. An edit made
 * while a run is in progress can land in a settings copy the plan already
 * decided to remove — a client-only field such as `summaries` is the sharpest
 * case, since no payload ever holds it. The bounded batch window limits the
 * exposure, and the backup is the escape hatch; per-deletion re-validation is
 * not part of this ticket.
 *
 * Host-free: the transport write, the settings delete, the stamp accessors and
 * the persistence are injected by the composition in core/chunk-meta-storage-actions.js.
 * No DOM, no SillyTavern imports, no transport of its own.
 * ============================================================================
 */

/** Settings key that holds the last sweep's stamp. */
export const CHUNK_META_SWEEP_STAMP_KEY = 'chunk_meta_sweep_stamp';

/** Bumped only when the stamp shape changes incompatibly. */
const STAMP_VERSION = 1;

/** Work items between deletions; small enough that a failure loses little. */
const DEFAULT_BATCH_SIZE = 25;

const STAMP_STATUSES = new Set(['complete', 'aborted']);

/** A non-negative integer from anything a stored stamp may carry. */
function countOf(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** ISO timestamp for a stamp field. */
function isoOf(value) {
    return new Date(value).toISOString();
}

/** A zeroed count record. */
function emptyCounts() {
    return { entries: 0, patched: 0, deleted: 0, refused: 0, failed: 0 };
}

/**
 * Normalizes the stored stamp, or null when there is none this build recognises.
 * Owns the stamp shape: the sweep writes it, the Size Inspector displays it, and
 * a stale or foreign value must never be read as a finished migration.
 * @param {object|null|undefined} settings VectFox settings.
 * @returns {object|null}
 */
export function getSweepStamp(settings) {
    const raw = settings?.[CHUNK_META_SWEEP_STAMP_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    // A stamp from an incompatible build is not a finished migration. A missing
    // version is accepted for stamps written before the field existed.
    if (raw.version !== undefined && raw.version !== STAMP_VERSION) return null;
    if (!STAMP_STATUSES.has(raw.status)) return null;
    return {
        version: STAMP_VERSION,
        mode: raw.mode === 'settings' ? 'settings' : 'payload',
        status: raw.status,
        startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : null,
        finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
        trusted: raw.trusted !== false,
        persisted: raw.persisted !== false,
        counts: {
            entries: countOf(raw.counts?.entries),
            patched: countOf(raw.counts?.patched),
            deleted: countOf(raw.counts?.deleted),
            refused: countOf(raw.counts?.refused),
            failed: countOf(raw.counts?.failed),
        },
    };
}

/**
 * Stores a stamp on the settings object. The caller owns persistence: a sweep
 * writes the stamp and asks for the one settings save that follows the run.
 * @param {object|null|undefined} settings VectFox settings.
 * @param {object} stamp Output of a sweep run.
 * @returns {boolean} Whether there was a settings object to write to.
 */
export function setSweepStamp(settings, stamp) {
    if (!settings || typeof settings !== 'object') return false;
    settings[CHUNK_META_SWEEP_STAMP_KEY] = stamp;
    return true;
}

/**
 * Groups the plan's patch records by hash and attaches each hash's deletion, so
 * one settings entry is one work item. A hash patchable in two collections is
 * one item with two payload writes and (once trusted) one deletion.
 * @param {object} plan Output of planChunkMetaSweep().
 * @param {boolean} trusted Whether this run may delete.
 * @returns {Array<{ hash: string, patches: Array<{ registryKey: string, fields: object }>, removable: boolean }>}
 */
function workItemsOf(plan, trusted) {
    const items = new Map();
    const itemOf = (hash) => {
        if (!items.has(hash)) items.set(hash, { hash, patches: [], removable: false });
        return items.get(hash);
    };

    for (const record of plan.patch || []) {
        itemOf(record.hash).patches.push({ registryKey: record.registryKey, fields: record.fields });
    }
    // Only a trusted run may act on the delete list at all.
    for (const record of trusted ? plan.deletable || [] : []) {
        itemOf(record.hash).removable = true;
    }

    return [...items.values()];
}

/** A batch size from any caller-supplied value. */
function batchSizeOf(value) {
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_BATCH_SIZE;
}

/**
 * Executes a sweep plan. See the module header for the safety rules.
 *
 * @param {object} options
 * @param {object} options.plan Output of planChunkMetaSweep().
 * @param {'payload'|'settings'} [options.mode] Store mode the run reports.
 * @param {(registryKey: string, hash: string, fields: object) => Promise<void>} [options.patchMetadata]
 *     Writes one chunk's metadata into its payload. Required when the plan has patch work.
 * @param {(hash: string) => boolean|void} [options.deleteEntry]
 *     Removes one legacy settings entry, without saving; false when there was
 *     nothing to remove.
 * @param {() => object|null} [options.readStamp] Returns the stored stamp, if any.
 * @param {(stamp: object) => void} [options.writeStamp] Stores the stamp, without saving.
 * @param {() => void} [options.persistSettings] Persists the settings object, once.
 * @param {number} [options.batchSize] Work items per batch.
 * @param {Date|string|number} [options.now] Timestamp the run is stamped with.
 * @param {(progress: { phase: string, done: number, total: number, patched: number, deleted: number }) => void} [options.onProgress]
 * @returns {Promise<{
 *   status: 'complete'|'aborted'|'noop',
 *   mode: 'payload'|'settings',
 *   trusted: boolean,
 *   deletionRefused: boolean,
 *   resumed: boolean,
 *   counts: { entries: number, patched: number, deleted: number, refused: number, failed: number },
 *   stamp: object,
 *   error: string|null,
 * }>}
 */
export async function executeChunkMetaSweep({
    plan,
    mode = 'payload',
    patchMetadata,
    deleteEntry = () => false,
    readStamp = () => null,
    writeStamp = () => {},
    persistSettings = () => {},
    batchSize = DEFAULT_BATCH_SIZE,
    now = new Date(),
    onProgress,
} = {}) {
    if (!plan || typeof plan !== 'object' || !plan.counts || !plan.coverage) {
        throw new TypeError('a chunk-metadata sweep needs the plan from a completed scan');
    }

    const trusted = plan.trusted === true;
    const items = workItemsOf(plan, trusted);
    if (items.some(item => item.patches.length > 0) && typeof patchMetadata !== 'function') {
        throw new TypeError('a chunk-metadata sweep that patches payloads needs patchMetadata');
    }

    const previous = readStamp?.() || null;
    // A partial stamp (an earlier attempt that aborted) is what a resume reads:
    // its start time identifies the interrupted attempt, and the re-derived plan
    // already excludes the work that attempt finished.
    const resumed = Boolean(previous && previous.status !== 'complete');
    // Untrusted, the entries a complete listing proved redundant — and the ones
    // this run patched — would have been removable; they are kept instead.
    const refused = trusted
        ? 0
        : (plan.redundant?.length || 0) + new Set((plan.patch || []).map(record => record.hash)).size;

    // A finished migration with nothing left to move: no write, no save, no new
    // stamp. This is what makes running the sweep twice cheap. An untrusted plan
    // never qualifies: absence it could not verify is not proof of completion,
    // and neither does a completion whose save failed — it is in memory only.
    if (items.length === 0 && trusted && previous?.status === 'complete'
        && previous.persisted !== false) {
        return {
            status: 'noop',
            mode: previous.mode || mode,
            trusted,
            deletionRefused: !trusted,
            resumed: false,
            counts: emptyCounts(),
            stamp: previous,
            error: null,
            saveError: null,
        };
    }

    const counts = emptyCounts();
    const startedAt = resumed && previous.startedAt ? previous.startedAt : isoOf(now);
    const size = batchSizeOf(batchSize);
    let failure = null;
    let done = 0;

    outer:
    for (let index = 0; index < items.length; index += size) {
        const batch = items.slice(index, index + size);

        try {
            // Payload writes first: a settings entry is only removable once the
            // value it holds is provably in the payload.
            for (const item of batch) {
                for (const patch of item.patches) {
                    await patchMetadata(patch.registryKey, item.hash, patch.fields);
                }
                if (item.patches.length > 0) counts.patched += 1;
                counts.entries += 1;
                done += 1;
            }
            // The whole batch patched, so its settings copies may go. A delete
            // that reports nothing to remove (already gone) is not counted.
            for (const item of batch) {
                if (!item.removable) continue;
                if (deleteEntry(item.hash) === false) continue;
                counts.deleted += 1;
            }
        } catch (error) {
            failure = error;
            counts.failed += 1;
            break outer;
        }

        onProgress?.({
            phase: 'patch',
            done,
            total: items.length,
            patched: counts.patched,
            deleted: counts.deleted,
        });
    }

    counts.refused = refused;

    const stamp = {
        version: STAMP_VERSION,
        mode: mode === 'settings' ? 'settings' : 'payload',
        status: failure ? 'aborted' : 'complete',
        startedAt,
        finishedAt: isoOf(now),
        trusted,
        counts,
        persisted: true,
    };
    writeStamp?.(stamp);

    // The work is done and the stamp is in memory; a failing save must not be
    // reported as a failed sweep. It is surfaced beside the counts instead, and
    // the stamp says the completion is not durable yet, so the next run does not
    // mistake it for a finished migration.
    let saveError = null;
    try {
        persistSettings?.();
    } catch (error) {
        saveError = error?.message || String(error);
        stamp.persisted = false;
        writeStamp?.(stamp);
    }

    return {
        status: stamp.status,
        mode: stamp.mode,
        trusted,
        deletionRefused: !trusted,
        resumed,
        counts: { ...counts },
        stamp,
        error: failure ? (failure.message || String(failure)) : null,
        saveError,
    };
}
