/**
 * ============================================================================
 * VECTFOX SIZE INSPECTOR VIEW STATUS
 * ============================================================================
 * The two states a Size Inspector view model can be in. Storage health and the
 * sweep report both return one, and the panel renders both — so the vocabulary
 * has one definition instead of a bare string in every producer and consumer.
 * ============================================================================
 */

export const VIEW_STATUS = Object.freeze({
    MEASURED: 'measured',
    UNAVAILABLE: 'unavailable',
});
