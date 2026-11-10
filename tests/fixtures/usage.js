/**
 * Shared usage fixtures.
 *
 * Three test files need the same base record and accumulator, so the base
 * lives here and each file layers only the fields its seam cares about.
 */

import { createUsageAccumulator } from '../../core/usage-stats.js';

export function usageAccumulator(overrides = {}) {
    return { ...createUsageAccumulator(), ...overrides };
}

export function usageRecord(overrides = {}) {
    return {
        recordId: 'rec-1',
        timestamp: 1_700_000_000_000,
        chatId: 'chat-1',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        status: 'ok',
        promptTokens: 1000,
        hitTokens: 500,
        missTokens: 500,
        completionTokens: 100,
        usageSource: 'measured',
        ...overrides,
    };
}
