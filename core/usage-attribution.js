/**
 * ============================================================================
 * USAGE ATTRIBUTION
 * ============================================================================
 * Answers "who caused this chat-completion request?" for the usage observer.
 *
 * The generation state is fed from SillyTavern's GENERATION_STARTED /
 * GENERATION_ENDED / GENERATION_STOPPED events. VectFox's own LLM helper raises
 * the internal-call flag around its fetch, so an extraction or planner call made
 * while a story generation is in flight is still attributed to VectFox and not
 * to the story reply.
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

// Generation types that produce the story reply (and its swipe/regen/continue).
const STORY_GENERATION_TYPES = new Set(['normal', 'regenerate', 'swipe', 'continue', 'impersonate']);

let _generation = null;
let _internalCalls = [];

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
 * Raises VectFox's internal-call flag for one request. Returns a token to pass
 * back so concurrent calls cannot release each other's flag.
 *
 * @param {string|null} featureLabel Short feature name, e.g. 'EventBase'.
 * @returns {{featureLabel: string|null}}
 */
export function beginInternalCall(featureLabel = null) {
    const token = { featureLabel: typeof featureLabel === 'string' && featureLabel ? featureLabel : null };
    _internalCalls.push(token);
    return token;
}

/**
 * Lowers an internal-call flag raised by beginInternalCall.
 * @param {{featureLabel: string|null}} token
 */
export function endInternalCall(token) {
    const index = _internalCalls.lastIndexOf(token);
    if (index >= 0) _internalCalls.splice(index, 1);
}

/**
 * The origin the next observed request belongs to. The internal flag wins over
 * the generation state; leaving a generation means worker-profile; a generation
 * type this module does not know is ambiguous and stays unknown.
 *
 * @returns {{origin: string, featureLabel: string|null}}
 */
export function resolveUsageOrigin() {
    const internal = _internalCalls[_internalCalls.length - 1];
    if (internal) {
        return { origin: USAGE_ORIGINS.VECTFOX_INTERNAL, featureLabel: internal.featureLabel };
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

/** Resets all attribution state. Test helper; production code never calls it. */
export function resetUsageAttribution() {
    _generation = null;
    _internalCalls = [];
}
