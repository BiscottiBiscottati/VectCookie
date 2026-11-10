/**
 * ============================================================================
 * USAGE ATTRIBUTION
 * ============================================================================
 * Answers "who caused this chat-completion request?" for the usage observer.
 *
 * The generation state is fed from SillyTavern's GENERATION_STARTED /
 * GENERATION_ENDED / GENERATION_STOPPED events. VectFox's own LLM helper marks
 * the request it is about to send, so an extraction or planner call is still
 * attributed to VectFox even while a story generation is in flight — and,
 * equally important, a story request sent while an extraction is in flight is
 * NOT stolen by the extraction.
 *
 * The mark lives on that request's `init` object, not in shared module state:
 * two overlapping requests must be attributable independently. An earlier
 * shared flag made the newest internal call win for every request in flight,
 * which mislabelled story replies as `VectFox · EventBase` (observed live when
 * auto-sync overlapped the next turn).
 *
 * The observer resolves the origin synchronously when the request is sent: a
 * generation can end before a deferred capture runs.
 * ============================================================================
 */

export const USAGE_ORIGINS = Object.freeze({
    STORY: 'story',
    QUIET: 'quiet',
    WORKER_PROFILE: 'worker-profile',
    VECTFOX_INTERNAL: 'vectfox-internal',
    UNKNOWN: 'unknown',
});

// Symbol.for, not a module-local Symbol: a reloaded module instance must still
// read the mark written by the previous one.
const INTERNAL_REQUEST_MARK = Symbol.for('vectfox.usage.internal-request');

// Generation types that produce the story reply (and its swipe/regen/continue).
const STORY_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue', 'impersonate']);

let _generation = null;

/**
 * Marks one request init as VectFox-internal. The mark is non-enumerable and a
 * Symbol, so it never reaches the wire and never changes a JSON body.
 *
 * @param {object|null} init Request init about to be passed to fetch.
 * @param {string|null} [featureLabel] Short feature name, e.g. 'EventBase'.
 * @returns {object|null} The same init, for chaining.
 */
export function markInternalRequest(init, featureLabel = null) {
    if (!init || typeof init !== 'object') return null;
    Object.defineProperty(init, INTERNAL_REQUEST_MARK, {
        value: { featureLabel: typeof featureLabel === 'string' && featureLabel ? featureLabel : null },
        configurable: true,
        enumerable: false,
        writable: false,
    });
    return init;
}

/**
 * Marks a generation as in flight. A dry run assembles a prompt without calling
 * the provider, so it must not make the next worker request look like a story.
 *
 * @param {string} type SillyTavern generation type.
 * @param {{dryRun?: boolean, quietToLoud?: boolean}} [options] A quiet-to-loud
 *   generation is posted as a chat message (SillyTavern's /sendas path), so it
 *   is a story reply, not a background call.
 */
export function noteGenerationStarted(type, { dryRun = false, quietToLoud = false } = {}) {
    if (dryRun) return;
    _generation = {
        type: typeof type === 'string' ? type : null,
        quietToLoud: quietToLoud === true,
    };
}

/** Clears the in-flight generation on GENERATION_ENDED / GENERATION_STOPPED. */
export function noteGenerationEnded() {
    _generation = null;
}

/**
 * The origin the observed request belongs to. A per-request internal mark wins;
 * otherwise the request follows the generation state. A generation type this
 * module does not know is ambiguous and stays unknown.
 *
 * @param {object|null} [init] The request init the observer received.
 * @returns {{origin: string, featureLabel: string|null}}
 */
export function resolveUsageOrigin(init = null) {
    const marked = init && typeof init === 'object' ? init[INTERNAL_REQUEST_MARK] : null;
    if (marked) {
        return { origin: USAGE_ORIGINS.VECTFOX_INTERNAL, featureLabel: marked.featureLabel ?? null };
    }
    if (!_generation) {
        return { origin: USAGE_ORIGINS.WORKER_PROFILE, featureLabel: null };
    }
    if (_generation.type === 'quiet') {
        // Quiet-to-loud results are posted as chat messages, so they are story
        // replies; a plain quiet run hands its result back and stays quiet.
        if (_generation.quietToLoud) {
            return { origin: USAGE_ORIGINS.STORY, featureLabel: null };
        }
        return { origin: USAGE_ORIGINS.QUIET, featureLabel: null };
    }
    if (STORY_GENERATION_TYPES.has(_generation.type)) {
        return { origin: USAGE_ORIGINS.STORY, featureLabel: null };
    }
    return { origin: USAGE_ORIGINS.UNKNOWN, featureLabel: null };
}

/** Resets generation attribution state. Test helper; production never calls it. */
export function resetUsageAttribution() {
    _generation = null;
}
