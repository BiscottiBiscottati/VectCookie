/**
 * Usage export — the versioned JSON shape.
 *
 * The export is a data file for a bug report or a spreadsheet, so the test
 * asserts its published shape and, above all, that no prompt text or API key
 * can reach it. Expected values are literals from the ticket, never rebuilt
 * through the same projection the builder uses.
 */

import { describe, it, expect } from 'vitest';

import { buildUsageExport, usageExportFileName } from '../core/usage-export.js';
import { usageAccumulator, usageRecord } from './fixtures/usage.js';

function record(overrides = {}) {
    return usageRecord({
        runId: 'run-1',
        origin: 'story',
        stream: true,
        httpStatus: 200,
        latencyMs: 1200,
        messageCount: 12,
        cacheWriteTokens: null,
        reasoningTokens: null,
        totalTokens: 3500,
        cost: null,
        cacheDiscount: null,
        estimatedPromptTokens: null,
        sharedPrefixTokens: 2500,
        possiblePrefixBreaker: false,
        configuration: { ghostEnabled: true, ghostBatchSize: 30, ghostKeepRecent: 4 },
        ...overrides,
    });
}

function snapshot(overrides = {}) {
    return {
        records: [record()],
        runs: [{ runId: 'run-1', label: 'Run 1', startedAt: 1_700_000_000_000, endedAt: null }],
        currentRunId: 'run-1',
        archived: {
            total: usageAccumulator({ requests: 2, measuredRequests: 2 }),
            byOrigin: { story: usageAccumulator({ requests: 2 }) },
            byModel: {
                'deepseek|deepseek-v4-flash': {
                    provider: 'deepseek',
                    model: 'deepseek-v4-flash',
                    accumulator: usageAccumulator({ requests: 2 }),
                },
            },
            byConfiguration: {
                'ghost:on:batch:30:keep:4': {
                    configuration: { ghostEnabled: true, ghostBatchSize: 30, ghostKeepRecent: 4 },
                    accumulator: usageAccumulator({ requests: 2 }),
                },
            },
        },
        retention: { limit: 500, retained: 1, total: 3 },
        allTime: {
            totals: usageAccumulator({ requests: 3 }),
            buckets: { 'chat-1': usageAccumulator({ requests: 2 }) },
        },
        ...overrides,
    };
}

describe('usage export — versioned shape', () => {
    it('carries the records, runs and aggregates of one chat plus the all-time buckets', () => {
        const prices = {
            currency: 'USD',
            updated: '2026-07-31',
            entries: [{ provider: 'deepseek', model: 'deepseek-v4-flash', hit: 0.003, miss: 0.15, output: 0.6, cacheWrite: 0.15 }],
        };
        const exported = buildUsageExport({
            chatId: 'chat-1',
            now: Date.UTC(2026, 10, 10, 12, 34, 56),
            snapshot: snapshot(),
            prices,
        });

        expect(exported).toMatchObject({
            version: 1,
            kind: 'vectfox-usage-export',
            exportedAt: '2026-11-10T12:34:56.000Z',
            chatId: 'chat-1',
            currentRunId: 'run-1',
            currentPrices: prices,
        });
        expect(exported.records).toEqual([record()]);
        expect(exported.runs).toEqual([{
            runId: 'run-1',
            label: 'Run 1',
            startedAt: 1_700_000_000_000,
            endedAt: null,
        }]);
        expect(exported.aggregates.retention).toEqual({ limit: 500, retained: 1, total: 3 });
        expect(exported.aggregates.archived.total.requests).toBe(2);
        expect(exported.aggregates.archived.byOrigin.story.requests).toBe(2);
        expect(exported.aggregates.archived.byModel['deepseek|deepseek-v4-flash']).toMatchObject({
            provider: 'deepseek',
            model: 'deepseek-v4-flash',
            accumulator: { requests: 2 },
        });
        expect(exported.aggregates.archived.byConfiguration['ghost:on:batch:30:keep:4'].configuration)
            .toEqual({ ghostEnabled: true, ghostBatchSize: 30, ghostKeepRecent: 4 });
        expect(exported.aggregates.allTime.totals.requests).toBe(3);
        expect(exported.aggregates.allTime.chats['chat-1'].requests).toBe(2);
    });

    it('keeps every source label and count in a mixed set of many records', () => {
        const exported = buildUsageExport({
            chatId: 'chat-1',
            now: 0,
            snapshot: snapshot({
                records: [
                    record({ recordId: 'measured', usageSource: 'measured' }),
                    record({
                        recordId: 'estimated',
                        usageSource: 'estimated',
                        promptTokens: null,
                        hitTokens: null,
                        missTokens: null,
                        estimatedPromptTokens: 800,
                    }),
                    record({
                        recordId: 'unavailable',
                        status: 'no-usage',
                        usageSource: 'unavailable',
                        promptTokens: null,
                        hitTokens: null,
                        missTokens: null,
                        completionTokens: null,
                        estimatedPromptTokens: null,
                    }),
                ],
            }),
        });

        expect(exported.records.map((entry) => entry.usageSource))
            .toEqual(['measured', 'estimated', 'unavailable']);
        expect(exported.records[1].estimatedPromptTokens).toBe(800);
        expect(exported.records[2].possiblePrefixBreaker).toBe(false);
        expect(exported.records[2].sharedPrefixTokens).toBe(2500);
    });

    it('is empty but well formed when nothing has been recorded', () => {
        const exported = buildUsageExport({ now: 0 });

        expect(exported).toMatchObject({
            version: 1,
            kind: 'vectfox-usage-export',
            exportedAt: '1970-01-01T00:00:00.000Z',
            chatId: null,
            currentPrices: null,
            records: [],
            runs: [],
            currentRunId: null,
        });
        expect(exported.aggregates.archived).toEqual({
            total: usageAccumulator(),
            byOrigin: {},
            byModel: {},
            byConfiguration: {},
        });
        expect(exported.aggregates.retention).toEqual({ limit: 0, retained: 0, total: 0 });
        expect(exported.aggregates.allTime).toEqual({
            totals: usageAccumulator(),
            chats: {},
        });
    });
});

describe('usage export — privacy', () => {
    it('projects only usage fields, so prompt text, message bodies and API keys cannot leak', () => {
        const dirty = record({
            promptText: 'SECRET PROMPT TEXT',
            messages: [{ role: 'system', content: 'SECRET PROMPT TEXT' }],
            ['api' + 'Key']: 'not-a-real-key-123',
            messageFingerprint: { messages: [{ hash: 11, tokens: 1500 }] },
        });

        const json = JSON.stringify(buildUsageExport({
            chatId: 'chat-1',
            now: Date.UTC(2026, 10, 10, 12, 0, 0),
            snapshot: snapshot({ records: [dirty] }),
        }));

        expect(json).not.toContain('SECRET PROMPT TEXT');
        expect(json).not.toContain('not-a-real-key-123');
        const [exportedRecord] = JSON.parse(json).records;
        expect(exportedRecord).not.toHaveProperty('promptText');
        expect(exportedRecord).not.toHaveProperty('messages');
        expect(exportedRecord).not.toHaveProperty('apiKey');
        expect(exportedRecord).not.toHaveProperty('messageFingerprint');
        expect(exportedRecord).toMatchObject({
            recordId: 'rec-1',
            promptTokens: 1000,
            hitTokens: 500,
            sharedPrefixTokens: 2500,
        });
    });
});

describe('usage export — file name', () => {
    it('names the file after the chat and the export time, dropping path characters', () => {
        expect(usageExportFileName({
            chatId: 'My Chat: 2',
            now: Date.UTC(2026, 10, 10, 12, 34, 56),
        })).toBe('vectfox-usage-My-Chat-2-20261110-123456.json');

        expect(usageExportFileName({
            chatId: '../../etc/passwd',
            now: Date.UTC(2026, 10, 10, 12, 34, 56),
        })).toBe('vectfox-usage-etc-passwd-20261110-123456.json');
    });

    it('omits the chat segment when no chat is open', () => {
        expect(usageExportFileName({
            chatId: null,
            now: Date.UTC(2026, 10, 10, 12, 34, 56),
        })).toBe('vectfox-usage-20261110-123456.json');
    });
});
