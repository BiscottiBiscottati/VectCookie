/**
 * ============================================================================
 * VECTFOX ORPHAN-DELETION CONFIRMATION
 * ============================================================================
 * The one dialog between a counted orphan-deletion plan and the settings object
 * losing entries. It exists as its own module so the storage-health panel stays
 * free of SillyTavern host imports — the panel is rendered in tests without
 * them — while this file can call the host's popup directly.
 *
 * The view model is built by core/chunk-meta-sweep-report.js and already states
 * the entry count and the released size; this module only places that text and
 * returns the user's answer. Every value is escaped: the labels are ours, but
 * they carry counts that came from settings, and a dialog is not the place to
 * discover that a string was trusted.
 * ============================================================================
 */

import { callGenericPopup, POPUP_TYPE } from '../../../../popup.js';
import StringUtils from '../utils/string-utils.js';

/**
 * Asks whether to delete the orphan settings entries the run measured.
 * @param {object} view Confirmation view model from buildOrphanDeleteConfirmView().
 * @returns {Promise<boolean>} Whether the user accepted.
 */
export async function confirmOrphanDeletion(view) {
    const choice = await callGenericPopup(
        `<div style="text-align:left">
            <p><strong>${StringUtils.escapeHtml(view.headline)}</strong></p>
            <p>${StringUtils.escapeHtml(view.detail)}</p>
        </div>`,
        POPUP_TYPE.CONFIRM,
        '',
        { okButton: view.okButton, cancelButton: view.cancelButton },
    );
    return Boolean(choice);
}
