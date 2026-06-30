/**
 * ============================================================================
 * INLINE SUMMARY (ILS) EXPANDER
 * ============================================================================
 * Expands InlineSummary summary messages back into their original messages
 * so VectFox can extract events from the full detailed content.
 *
 * This is a READ-ONLY operation — the original chat array is never modified.
 * A new array is returned with ILS summary messages replaced by their originals.
 *
 * InlineSummary stores original messages in:
 *   msg.extra.ILS_Data.OriginalMessages  (array of message objects)
 *
 * @author VectFox ILS Integration
 * ============================================================================
 */

import { log } from './log.js';
import { chat_metadata } from '../../../../../script.js';

/**
 * Checks if a message is an InlineSummary summary message.
 * Supports both ILS storage formats:
 *   - legacy: originals embedded at msg.extra.ILS_Data.OriginalMessages
 *   - ref:    originals in chat_metadata.ILS_Originals[msg.extra.ILS_Data.Ref]
 *             (ILS fork — keeps the payload out of `extra` so SillyTavern's
 *             swipe sync doesn't structuredClone it into swipe_info)
 * @param {object} msg Chat message object
 * @returns {boolean} True if this is an ILS summary message
 */
function isILSSummaryMessage(msg) {
    const data = msg?.extra?.ILS_Data;
    return !!(data && (data.OriginalMessages || typeof data.Ref === 'string'));
}

/**
 * Resolves a summary message's original messages from either storage format.
 * @param {object} msg ILS summary message
 * @returns {object[]|null} Originals, or null if the ref is dangling
 */
function getILSOriginals(msg) {
    const data = msg?.extra?.ILS_Data;
    if (!data) return null;
    if (Array.isArray(data.OriginalMessages)) return data.OriginalMessages;
    if (typeof data.Ref === 'string') {
        const originals = chat_metadata?.ILS_Originals?.[data.Ref];
        return Array.isArray(originals) ? originals : null;
    }
    return null;
}

/**
 * Expands InlineSummary summary messages back into their original messages.
 *
 * When InlineSummary summarizes a range of messages, it:
 * 1. Replaces those messages with a single summary message
 * 2. Stores the originals in msg.extra.ILS_Data.OriginalMessages
 *
 * This function detects such summary messages and replaces each one with
 * its original messages, so the downstream pipeline sees full detail.
 *
 * PURE FUNCTION — does not modify the input array or any messages.
 *
 * @param {object[]} messages Array of chat message objects
 * @returns {{ expanded: object[], stats: { summariesFound: number, originalsRecovered: number } }}
 */
export function expandILSMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { expanded: messages, stats: { summariesFound: 0, originalsRecovered: 0, maxDepth: 0 } };
    }

    const stats = { summariesFound: 0, originalsRecovered: 0, maxDepth: 0 };
    const expanded = [];

    // Defensive cap on recursion. ILS nests summaries-of-summaries (see its
    // Experiment1 / CreateOriginalMessagesContainer depth handling), and while
    // a malformed/cyclic OriginalMessages chain shouldn't occur in practice,
    // an unbounded recursion would hang the whole vectorization run. 64 layers
    // is far beyond any realistic ILS nesting.
    const MAX_DEPTH = 64;

    /**
     * Recursively flattens one message into `out`. A summary message is replaced
     * by its OriginalMessages; any of those that are themselves summaries are
     * expanded in turn, so nested (multilayered) summaries resolve down to the
     * real leaf messages.
     * @param {object} msg
     * @param {number} depth Current nesting depth (0 = top-level chat message)
     */
    function flatten(msg, depth) {
        if (isILSSummaryMessage(msg)) {
            const originals = getILSOriginals(msg);
            stats.summariesFound++;
            if (depth > stats.maxDepth) stats.maxDepth = depth;

            if (depth >= MAX_DEPTH) {
                // Bail out of pathological nesting — keep the summary text rather
                // than recursing forever.
                log.warn(`[ILS Expander] Max nesting depth (${MAX_DEPTH}) reached — keeping summary text instead of expanding further`);
                if (msg.mes) expanded.push(msg);
                return;
            }

            if (Array.isArray(originals) && originals.length > 0) {
                for (const orig of originals) {
                    if (!orig) continue;
                    if (isILSSummaryMessage(orig)) {
                        // Nested summary — recurse so multilayered summaries
                        // resolve down to their underlying original messages.
                        flatten(orig, depth + 1);
                    } else if (orig.mes) {
                        expanded.push(orig);
                        stats.originalsRecovered++;
                    }
                }
                log.verbose(`[ILS Expander] Expanded ILS summary (depth=${depth}) into ${originals.length} original message(s)`);
            } else {
                // No originals available — keep the summary as-is (better than dropping it)
                if (msg.mes) expanded.push(msg);
                log.verbose('[ILS Expander] ILS summary has no originals, keeping summary text');
            }
        } else {
            // Normal message — pass through unchanged
            expanded.push(msg);
        }
    }

    for (const msg of messages) {
        flatten(msg, 0);
    }

    if (stats.summariesFound > 0) {
        log.lifecycle(`[ILS Expander] Expanded ${stats.summariesFound} ILS summaries (max nesting depth ${stats.maxDepth}), recovered ${stats.originalsRecovered} original messages (input: ${messages.length}, output: ${expanded.length})`);
    }

    return { expanded, stats };
}