/**
 * Size Inspector — the storage-health block.
 *
 * ADR-0003 adds no new screen: the settings size, the top contributing keys, the
 * chunk-metadata entry count and the over-limit warning belong on the tab users
 * already open to diagnose bloat. What must not come with them is cost — opening
 * the tab has to stay a pure settings read, with no plugin request and no
 * collection scan, or the diagnostics panel becomes a second source of the
 * startup stall it exists to report.
 *
 * jsdom + a tiny jQuery shim: the inspector renders through jQuery in SillyTavern
 * and jQuery isn't a test dependency, so the shim supplies just the calls the
 * render path makes. The real DOM is asserted. The backend modules are mocked
 * because the SillyTavern host paths they import cannot be resolved here; the
 * measurement and the panel under test are the real ones.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const listChunks = vi.hoisted(() => vi.fn());
vi.mock('../core/core-vector-api.js', () => ({ listChunks }));

const loadAllCollections = vi.hoisted(() => vi.fn());
vi.mock('../core/collection-loader.js', () => ({ loadAllCollections }));

vi.mock('../core/collection-ids.js', () => ({
    buildRegistryKey: (collectionId, backend) => `${backend}:${collectionId}`,
}));

import { renderSizeInspectorTab } from '../ui/size-inspector.js';
import { runChunkMetaDryRun } from '../core/chunk-meta-sweep-report.js';
import {
    createStorageOrphanDelete,
    createStorageSweep,
} from '../core/chunk-meta-storage-actions.js';
import { getSweepStamp, setSweepStamp } from '../core/chunk-meta-sweep-execute.js';
import { createFakeChunkListing } from './fixtures/chunk-listing.js';
import { settingsByteSize } from './fixtures/settings-bytes.js';

/**
 * Just enough jQuery for the render path: mount, template write, event rebind.
 * `find()` reports whether the selector is already in the mount, so the
 * "already rendered" branch behaves as it does in SillyTavern.
 */
function installJQueryShim() {
    const noopChain = {
        length: 0,
        off: () => noopChain,
        on: () => noopChain,
        find: () => noopChain,
        html: () => noopChain,
        prop: () => noopChain,
        hide: () => noopChain,
        show: () => noopChain,
        text: () => noopChain,
        empty: () => noopChain,
        attr: () => noopChain,
    };
    window.jQuery = (target) => {
        if (!target || typeof target === "string") return noopChain;
        const wrapper = {
            length: 1,
            find: (selector) => ({ length: target.querySelector(selector) ? 1 : 0 }),
            html: (html) => {
                if (html !== undefined) target.innerHTML = html;
                return wrapper;
            },
        };
        return wrapper;
    };
}

function openTab(settings, deps = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderSizeInspectorTab(container, () => settings, deps);
    return container;
}

/** Lets the click handler's await chain and the re-render settle. */
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function healthOf(container) {
    return container.querySelector("#vectfox_size_health");
}

/** 1200 chunk-metadata entries — the shape a real library accumulates. */
function chunkEntries(count) {
    const entries = {};
    for (let i = 0; i < count; i++) {
        entries[`vectfox_chunk_meta_${i}`] = { context: `chunk ${i}` };
    }
    return entries;
}

let fetchSpy;

beforeEach(() => {
    installJQueryShim();
    listChunks.mockReset();
    loadAllCollections.mockReset();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete window.jQuery;
    document.body.innerHTML = "";
});

describe("Size Inspector — storage health on open", () => {
    it("shows the serialized settings size, measured independently", () => {
        const settings = {
            chunk_size: 500,
            profiles: { default: { model: "x".repeat(3000) } },
            "vectfox_chunk_meta_a": { context: "alpha" },
        };
        const independent = settingsByteSize(settings);

        const settingsSize = healthOf(openTab(settings))
            .querySelector('[data-health="settings-size"]');

        expect(settingsSize.querySelector(".vectfox-size-health-value").textContent)
            .toMatch(/^\d+(\.\d+)? (B|KiB|MiB)$/);
        const displayedBytes = Number(
            settingsSize.querySelector(".vectfox-size-health-detail").textContent
                .replace(/[^\d]/g, ""),
        );
        expect(displayedBytes).toBe(independent);
    });

    it("lists the top contributing keys and the chunk-metadata entry count", () => {
        const settings = {
            profiles: { default: { model: "x".repeat(3000) } },
            chunk_size: 500,
            "vectfox_chunk_meta_a": { context: "alpha" },
            "vectfox_chunk_meta_b": { context: "beta" },
        };

        const health = healthOf(openTab(settings));

        expect(health.querySelector('[data-health="chunk-meta"]').textContent)
            .toContain("2 entries");

        const rows = health.querySelectorAll(".vectfox-size-health-table tbody tr");
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain("profiles");
        expect(rows[0].textContent).toContain("KiB");
        expect(health.textContent).not.toContain("vectfox_chunk_meta_a");
    });

    it("says one entry, not one entries", () => {
        const health = healthOf(openTab({ "vectfox_chunk_meta_a": { context: "alpha" } }));

        expect(health.querySelector('[data-health="chunk-meta"]').textContent)
            .toContain("1 entry");
        expect(health.textContent).not.toContain("1 entries");
    });

    it("warns past the limit and names how many chunk-metadata entries are held", () => {
        const settings = {
            profiles: { default: { model: "x".repeat(3 * 1024 * 1024) } },
            ...chunkEntries(1200),
        };

        const warning = healthOf(openTab(settings)).querySelector('[data-health="warning"]');

        expect(warning).not.toBeNull();
        expect(warning.textContent).toContain("2 MiB");
        expect(warning.textContent).toContain("1,200 chunk-metadata entries");
    });

    it("says nothing about a limit while the settings are small", () => {
        const health = healthOf(openTab({ chunk_size: 500 }));

        expect(health.querySelector('[data-health="warning"]')).toBeNull();
    });

    it("explains an unmeasurable settings object instead of breaking the tab", () => {
        const health = healthOf(openTab(null));

        expect(health.textContent).toContain("Storage health");
        expect(health.textContent).toMatch(/not available/i);
        expect(health.querySelector(".vectfox-size-health-table")).toBeNull();
        expect(health.querySelector("#vectfox_size_health_refresh")).not.toBeNull();
    });

    it("re-measures on demand, so a tab left open does not show a stale number", () => {
        const settings = { chunk_size: 500 };
        const health = healthOf(openTab(settings));
        expect(health.querySelector('[data-health="chunk-meta"]').textContent)
            .toContain("0 entries");

        settings["vectfox_chunk_meta_a"] = { context: "alpha" };
        health.querySelector("#vectfox_size_health_refresh").click();

        expect(health.querySelector('[data-health="chunk-meta"]').textContent)
            .toContain("1 entry");
        expect(listChunks).not.toHaveBeenCalled();
        expect(loadAllCollections).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("recovers from unavailable once settings exist, through Re-measure", () => {
        let settings = null;
        const container = document.createElement("div");
        document.body.appendChild(container);
        renderSizeInspectorTab(container, () => settings);
        const health = healthOf(container);
        expect(health.textContent).toMatch(/not available/i);

        settings = { chunk_size: 500 };
        health.querySelector("#vectfox_size_health_refresh").click();

        expect(health.querySelector('[data-health="settings-size"]')).not.toBeNull();
    });
});

describe("Size Inspector — opening the tab costs nothing", () => {
    it("issues no plugin request and performs no collection scan", async () => {
        const container = openTab({
            chunk_size: 500,
            "vectfox_chunk_meta_a": { context: "alpha" },
        });

        // Let any timer or microtask an open-path regression would use run.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(healthOf(container)).not.toBeNull();
        expect(listChunks).not.toHaveBeenCalled();
        expect(loadAllCollections).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("keeps one health block when the tab is reopened", () => {
        const settings = { chunk_size: 500 };
        const container = openTab(settings);
        // Reopening must only rebind and re-measure, not rebuild the shell —
        // that would wipe whatever the last scan rendered.
        container.querySelector("#vectfox_size_status").textContent = "previous scan kept";

        renderSizeInspectorTab(container, () => settings);

        expect(container.querySelector("#vectfox_size_status").textContent)
            .toContain("previous scan kept");
        expect(container.querySelectorAll(".vectfox-size-health")).toHaveLength(1);
        expect(container.querySelectorAll("#vectfox_size_health_refresh")).toHaveLength(1);
    });
});

/**
 * Injects the production dry-run entry point over a fake plugin listing, so the
 * panel is what is under test — not a hand-built report.
 */
function makeDryRun({ entries, collections, chunksByCollection, failing = [] }) {
    const { listChunks } = createFakeChunkListing({ chunksByCollection, failing });
    return ({ onProgress } = {}) => runChunkMetaDryRun({
        entries,
        collections,
        listChunks,
        onProgress,
    }).then(run => run.view);
}

const DRY_RUN_FIXTURE = {
    entries: {
        redundant: { context: 'about dragons', keywords: ['dragon'] },
        patchMe: { context: 'about elves', keywords: ['elf'] },
        gone: { context: 'deleted chunk' },
    },
    collections: [{ collectionId: 'A' }, { collectionId: 'B' }],
    chunksByCollection: {
        A: {
            redundant: { context: 'about dragons', keywords: ['dragon'] },
            patchMe: { context: 'about elves' },
        },
        B: {
            redundant: { context: 'about dragons', keywords: ['dragon'] },
        },
    },
};

describe("Size Inspector — the storage dry run", () => {
    it("runs only on click, never while opening the tab", async () => {
        const runDryRun = vi.fn(makeDryRun(DRY_RUN_FIXTURE));

        const health = healthOf(openTab({ chunk_size: 500 }, { runDryRun }));
        await settle();

        expect(runDryRun).not.toHaveBeenCalled();
        expect(health.querySelector('#vectfox_size_dry_run')).not.toBeNull();
    });

    it("reports counts per collection and in total", async () => {
        const runDryRun = vi.fn(makeDryRun(DRY_RUN_FIXTURE));
        const health = healthOf(openTab({ chunk_size: 500 }, { runDryRun }));

        health.querySelector('#vectfox_size_dry_run').click();
        await settle();

        expect(runDryRun).toHaveBeenCalledTimes(1);
        const report = health.querySelector('#vectfox_size_dry_run_report');
        expect(report.querySelector('[data-dry-run="headline"]').textContent)
            .toContain('3 entries');
        expect(report.querySelector('[data-dry-run="coverage"]').textContent)
            .toBe('2 of 2 collections fully read');
        expect(report.querySelector('[data-dry-run="refusal"]')).toBeNull();

        const rowA = report.querySelector('tbody tr[data-collection="A"]');
        const rowB = report.querySelector('tbody tr[data-collection="B"]');
        expect(rowA.querySelector('[data-dry-run="row-redundant"]').textContent).toBe('1');
        expect(rowA.querySelector('[data-dry-run="row-patch"]').textContent).toBe('1');
        expect(rowB.querySelector('[data-dry-run="row-redundant"]').textContent).toBe('1');
        expect(rowB.querySelector('[data-dry-run="row-patch"]').textContent).toBe('0');

        expect(report.querySelector('[data-dry-run="total-redundant"]').textContent).toBe('1');
        expect(report.querySelector('[data-dry-run="total-patch"]').textContent).toBe('1');
        expect(report.querySelector('[data-dry-run="total-orphan"]').textContent).toBe('1');
        expect(report.querySelector('[data-dry-run="total-skipped"]').textContent).toBe('0');
        expect(report.querySelector('.vectfox-size-dry-run-total').textContent).toContain('Total');
    });

    it("states plainly that an untrusted scan refuses deletion", async () => {
        const runDryRun = vi.fn(makeDryRun({ ...DRY_RUN_FIXTURE, failing: ['B'] }));
        const health = healthOf(openTab({ chunk_size: 500 }, { runDryRun }));

        health.querySelector('#vectfox_size_dry_run').click();
        await settle();

        const report = health.querySelector('#vectfox_size_dry_run_report');
        const refusal = report.querySelector('[data-dry-run="refusal"]').textContent;
        expect(refusal).toContain('Deletion is refused');
        expect(refusal).toContain('1 of 2 collections could not be read');
        // What the readable collection proved is still shown.
        expect(report.querySelector('[data-dry-run="total-redundant"]').textContent).toBe('1');
        expect(report.querySelector('[data-dry-run="total-skipped"]').textContent).toBe('1');
        expect(report.querySelector('[data-dry-run="skipped-note"]').textContent)
            .toContain('could not be attributed');
        expect(report.querySelector('tbody tr[data-collection="B"]').textContent).toContain('failed');
    });

    it("keeps the report when the block is re-measured", async () => {
        const runDryRun = vi.fn(makeDryRun(DRY_RUN_FIXTURE));
        const health = healthOf(openTab({ chunk_size: 500 }, { runDryRun }));
        health.querySelector('#vectfox_size_dry_run').click();
        await settle();

        health.querySelector('#vectfox_size_health_refresh').click();

        expect(health.querySelector('[data-dry-run="total-orphan"]').textContent).toBe('1');
    });

    it("says the dry run is unavailable when no runner is wired", async () => {
        const health = healthOf(openTab({ chunk_size: 500 }));

        health.querySelector('#vectfox_size_dry_run').click();
        await settle();

        expect(health.querySelector('#vectfox_size_dry_run_status').textContent)
            .toContain('not available in this build');
    });

    it("reports a runner failure instead of leaving the button dead", async () => {
        const runDryRun = vi.fn(async () => { throw new Error('boom'); });
        const health = healthOf(openTab({ chunk_size: 500 }, { runDryRun }));

        health.querySelector('#vectfox_size_dry_run').click();
        await settle();

        expect(health.querySelector('[data-dry-run="unavailable"]').textContent)
            .toContain('Dry run failed: boom');
        expect(health.querySelector('#vectfox_size_dry_run').disabled).toBe(false);
    });
});

/** One collection whose payload already holds the entry: a 1-redundant report. */
const BACKUP_FIXTURE = {
    entries: { only: { context: 'about dwarves', keywords: ['dwarf'] } },
    collections: [{ collectionId: 'C' }],
    chunksByCollection: {
        C: { only: { context: 'about dwarves', keywords: ['dwarf'] } },
    },
};

const BACKUP_FILENAME = 'vectfox-chunk-meta-backup-2026-11-12T09-30-00-000Z.json';
const BACKUP_TEXT = '{"format":"vectfox-chunk-meta-backup","version":1,"entries":[]}';

/**
 * The production backup entry point over the fake listing, so the report the
 * panel shows is the real view model of the scan the file was built from.
 */
async function backupResult(overrides = {}) {
    return {
        status: 'measured',
        filename: BACKUP_FILENAME,
        text: BACKUP_TEXT,
        entries: { count: 1, label: '1 entry' },
        view: await makeDryRun(BACKUP_FIXTURE)({}),
        ...overrides,
    };
}

function backupStatusOf(health) {
    return health.querySelector('#vectfox_size_backup_status').textContent;
}

describe("Size Inspector — the backup download", () => {
    it("downloads only on click, never while opening the tab", async () => {
        const runBackup = vi.fn(async () => backupResult());
        const saveFile = vi.fn();

        const health = healthOf(openTab({ chunk_size: 500 }, { runBackup, saveFile }));
        const button = health.querySelector('#vectfox_size_backup_download');
        expect(button).not.toBeNull();
        expect(button.disabled).toBe(false);
        expect(runBackup).not.toHaveBeenCalled();
        expect(saveFile).not.toHaveBeenCalled();
    });

    it("saves the file the runner built and says how many entries it holds", async () => {
        const runBackup = vi.fn(async () => backupResult());
        const saveFile = vi.fn();

        const health = healthOf(openTab({ chunk_size: 500 }, { runBackup, saveFile }));
        health.querySelector('#vectfox_size_backup_download').click();
        await settle();

        expect(runBackup).toHaveBeenCalledTimes(1);
        expect(saveFile).toHaveBeenCalledWith(BACKUP_FILENAME, BACKUP_TEXT);
        expect(backupStatusOf(health)).toContain(`Backup saved: ${BACKUP_FILENAME} (1 entry)`);
        expect(health.querySelector('#vectfox_size_backup_download').disabled).toBe(false);
    });

    it("shows the report of the scan the file was built from, replacing a stale dry run", async () => {
        const runDryRun = vi.fn(makeDryRun(DRY_RUN_FIXTURE));
        const runBackup = vi.fn(async () => backupResult());

        const health = healthOf(openTab({ chunk_size: 500 }, { runDryRun, runBackup, saveFile: vi.fn() }));
        health.querySelector('#vectfox_size_dry_run').click();
        await settle();
        const report = health.querySelector('#vectfox_size_dry_run_report');
        expect(report.querySelector('[data-dry-run="total-orphan"]').textContent).toBe('1');

        health.querySelector('#vectfox_size_backup_download').click();
        await settle();

        const fresh = health.querySelector('#vectfox_size_dry_run_report');
        expect(fresh.querySelector('[data-dry-run="headline"]').textContent).toContain('1 entries checked');
        expect(fresh.querySelector('[data-dry-run="total-redundant"]').textContent).toBe('1');
        expect(fresh.querySelector('[data-dry-run="total-orphan"]').textContent).toBe('0');
    });

    it("keeps the backup status when the block is re-measured", async () => {
        const runBackup = vi.fn(async () => backupResult());

        const health = healthOf(openTab({ chunk_size: 500 }, { runBackup, saveFile: vi.fn() }));
        health.querySelector('#vectfox_size_backup_download').click();
        await settle();
        health.querySelector('#vectfox_size_health_refresh').click();

        expect(backupStatusOf(health)).toContain(`Backup saved: ${BACKUP_FILENAME}`);
    });

    it("shows scan and file-writing progress while the download is built", async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const runBackup = vi.fn(async ({ onProgress, onEncode } = {}) => {
            onProgress?.({ done: 1, total: 2 });
            await gate;
            onEncode?.({ done: 500, total: 20000 });
            return backupResult();
        });

        const health = healthOf(openTab({ chunk_size: 500 }, { runBackup, saveFile: vi.fn() }));
        health.querySelector('#vectfox_size_backup_download').click();

        expect(backupStatusOf(health)).toContain('(1/2)');

        release();
        await settle();

        expect(backupStatusOf(health)).toContain('Backup saved');
    });

    it("cannot start a second backup while one is being built, even across a re-render", async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const runBackup = vi.fn(async () => {
            await gate;
            return backupResult();
        });

        const health = healthOf(openTab({ chunk_size: 500 }, { runBackup, saveFile: vi.fn() }));
        health.querySelector('#vectfox_size_backup_download').click();
        await settle();

        // Re-measure rebuilds the block mid-download; the fresh button must not
        // offer a concurrent scan of every collection.
        health.querySelector('#vectfox_size_health_refresh').click();
        const fresh = health.querySelector('#vectfox_size_backup_download');
        expect(fresh.disabled).toBe(true);
        fresh.click();
        await settle();

        expect(runBackup).toHaveBeenCalledTimes(1);

        release();
        await settle();

        expect(backupStatusOf(health)).toContain('Backup saved');
        expect(health.querySelector('#vectfox_size_backup_download').disabled).toBe(false);
    });

    it("cannot start a backup while a dry run is scanning", async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const runDryRun = vi.fn(async () => {
            await gate;
            return makeDryRun(DRY_RUN_FIXTURE)({});
        });
        const runBackup = vi.fn(async () => backupResult());

        const health = healthOf(openTab({ chunk_size: 500 }, { runDryRun, runBackup, saveFile: vi.fn() }));
        health.querySelector('#vectfox_size_dry_run').click();
        await settle();

        const backupButton = health.querySelector('#vectfox_size_backup_download');
        expect(backupButton.disabled).toBe(true);
        backupButton.click();
        await settle();
        expect(runBackup).not.toHaveBeenCalled();

        release();
        await settle();

        expect(runDryRun).toHaveBeenCalledTimes(1);
        expect(health.querySelector('[data-dry-run="headline"]').textContent).toContain('3 entries checked');
        expect(backupButton.disabled).toBe(false);
    });

    it("cannot start a dry run while a backup is scanning", async () => {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const runBackup = vi.fn(async () => {
            await gate;
            return backupResult();
        });
        const runDryRun = vi.fn(makeDryRun(DRY_RUN_FIXTURE));

        const health = healthOf(openTab({ chunk_size: 500 }, { runDryRun, runBackup, saveFile: vi.fn() }));
        health.querySelector('#vectfox_size_backup_download').click();
        await settle();

        const dryRunButton = health.querySelector('#vectfox_size_dry_run');
        expect(dryRunButton.disabled).toBe(true);
        dryRunButton.click();
        await settle();
        expect(runDryRun).not.toHaveBeenCalled();

        release();
        await settle();

        expect(backupStatusOf(health)).toContain('Backup saved');
        expect(dryRunButton.disabled).toBe(false);
    });

    it("does not call a saved file failed when the runner omits its display label", async () => {
        const runBackup = vi.fn(async () => ({
            status: 'measured',
            filename: BACKUP_FILENAME,
            text: BACKUP_TEXT,
        }));
        const saveFile = vi.fn();

        const health = healthOf(openTab({ chunk_size: 500 }, { runBackup, saveFile }));
        health.querySelector('#vectfox_size_backup_download').click();
        await settle();

        expect(saveFile).toHaveBeenCalledTimes(1);
        expect(backupStatusOf(health)).toContain(`Backup saved: ${BACKUP_FILENAME}`);
        expect(backupStatusOf(health)).not.toContain('failed');
    });

    it("explains an unavailable backup instead of saving an empty file", async () => {
        const runBackup = vi.fn(async () => ({
            status: 'unavailable',
            reason: 'The Similharity plugin is not available, so there is no chunk payload to compare against.',
        }));
        const saveFile = vi.fn();

        const health = healthOf(openTab({ chunk_size: 500 }, { runBackup, saveFile }));
        health.querySelector('#vectfox_size_backup_download').click();
        await settle();

        expect(saveFile).not.toHaveBeenCalled();
        expect(backupStatusOf(health)).toContain('Similharity plugin is not available');
    });

    it("reports a failure and leaves the button usable", async () => {
        const runBackup = vi.fn(async () => { throw new Error('boom'); });

        const health = healthOf(openTab({ chunk_size: 500 }, { runBackup, saveFile: vi.fn() }));
        const button = health.querySelector('#vectfox_size_backup_download');
        button.click();
        await settle();

        expect(backupStatusOf(health)).toContain('Backup failed: boom');
        expect(button.disabled).toBe(false);
    });

    it("reports a browser that cannot save instead of claiming the backup exists", async () => {
        const runBackup = vi.fn(async () => backupResult());
        const saveFile = vi.fn(() => false);

        const health = healthOf(openTab({ chunk_size: 500 }, { runBackup, saveFile }));
        health.querySelector('#vectfox_size_backup_download').click();
        await settle();

        expect(backupStatusOf(health)).toContain('Backup failed: this browser cannot save files');
    });

    it("says the backup is unavailable when no runner is wired", async () => {
        const health = healthOf(openTab({ chunk_size: 500 }));

        health.querySelector('#vectfox_size_backup_download').click();
        await settle();

        expect(backupStatusOf(health)).toContain('not available in this build');
    });

    it("saves through a Blob download when no saveFile is injected", async () => {
        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        const createObjectURL = vi.fn(() => 'blob:backup');
        const revokeObjectURL = vi.fn();
        const OriginalURL = globalThis.URL;
        vi.stubGlobal('URL', class extends OriginalURL {
            static createObjectURL = createObjectURL;
            static revokeObjectURL = revokeObjectURL;
        });

        try {
            const health = healthOf(openTab({ chunk_size: 500 }, {
                runBackup: vi.fn(async () => backupResult()),
            }));
            health.querySelector('#vectfox_size_backup_download').click();
            await settle();

            expect(createObjectURL).toHaveBeenCalledTimes(1);
            expect(clickSpy).toHaveBeenCalledTimes(1);
            const blob = createObjectURL.mock.calls[0][0];
            expect(blob.type).toBe('application/json');
            const written = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsText(blob);
            });
            expect(written).toBe(BACKUP_TEXT);
            expect(backupStatusOf(health)).toContain('Backup saved');
        } finally {
            clickSpy.mockRestore();
        }
    });
});


/**
 * The production sweep entry point over a fake plugin listing and a settings
 * object that really loses its legacy keys, so a panel test sees the size drop
 * the action exists to produce — not a hand-built view model.
 */
function makeSweep(isPatchable) {
    return (settings) => {
        const { listChunks, patchMetadata } = createFakeChunkListing({
            chunksByCollection: {
                'qdrant:A': isPatchable
                    ? { alpha: { context: 'about dragons', keywords: ['dragon'] }, beta: { context: 'about elves' } }
                    : { alpha: { context: 'about dragons', keywords: ['dragon'] } },
            },
            reportTotal: true,
        });
        const run = createStorageSweep({
            createTransport: () => ({ isAvailable: () => true, listChunks, patchMetadata }),
            listCollections: () => [{ registryKey: 'qdrant:A', collectionId: 'A' }],
            listEntries: () => Object.fromEntries(
                Object.entries(settings)
                    .filter(([key]) => key.startsWith('vectfox_chunk_meta_'))
                    .map(([key, metadata]) => [key.slice('vectfox_chunk_meta_'.length), metadata]),
            ),
            clientOnlyFields: ['summaries'],
            deleteEntry: (hash) => {
                delete settings[`vectfox_chunk_meta_${hash}`];
                return true;
            },
            readStamp: () => getSweepStamp(settings),
            writeStamp: stamp => setSweepStamp(settings, stamp),
            persistSettings: vi.fn(),
            batchSize: 2,
        });
        return ({ onProgress } = {}) => run({ getSettings: () => settings, onProgress });
    };
}

/** Settings with one redundant entry, one patchable entry and one orphan. */
function sweepSettings() {
    return {
        chunk_size: 500,
        "vectfox_chunk_meta_alpha": { context: "about dragons", keywords: ["dragon"] },
        "vectfox_chunk_meta_beta": { context: "about elves", keywords: ["elf"] },
        "vectfox_chunk_meta_gone": { context: "about nothing" },
    };
}

function sweepStatusOf(health) {
    return health.querySelector('#vectfox_size_sweep_status').textContent;
}

describe("Size Inspector — the sweep action", () => {
    it("offers the button but runs nothing until it is clicked", async () => {
        const settings = sweepSettings();
        const runSweep = vi.fn(makeSweep(true)(settings));

        const health = healthOf(openTab(settings, { runSweep }));
        await settle();

        const button = health.querySelector('#vectfox_size_run_sweep');
        expect(button).not.toBeNull();
        expect(button.disabled).toBe(false);
        expect(runSweep).not.toHaveBeenCalled();
    });

    it("patches, removes the redundant settings copies and re-measures smaller", async () => {
        const settings = sweepSettings();
        const runSweep = vi.fn(makeSweep(true)(settings));
        const health = healthOf(openTab(settings, { runSweep }));

        health.querySelector('#vectfox_size_run_sweep').click();
        await settle();

        expect(runSweep).toHaveBeenCalledTimes(1);
        expect(settings["vectfox_chunk_meta_alpha"]).toBeUndefined();
        expect(settings["vectfox_chunk_meta_beta"]).toBeUndefined();
        // The orphan is not the sweep's business; ticket 06 deletes those.
        expect(settings["vectfox_chunk_meta_gone"]).toBeDefined();

        const result = health.querySelector('#vectfox_size_sweep_result');
        expect(result.querySelector('[data-sweep="headline"]').textContent)
            .toBe('Sweep complete — 1 entry patched, 2 settings entries removed.');
        expect(result.querySelector('[data-sweep="patched"]').textContent).toBe('1');
        expect(result.querySelector('[data-sweep="deleted"]').textContent).toBe('2');

        // The block re-measured itself, so the smaller payload is visible.
        expect(health.querySelector('[data-health="chunk-meta"]').textContent)
            .toContain('1 entry');
        expect(sweepStatusOf(health)).toContain('Sweep complete');
    });

    it("shows the stamp the run left, so a migrated install is recognisable", async () => {
        const settings = sweepSettings();
        const runSweep = vi.fn(makeSweep(true)(settings));
        const health = healthOf(openTab(settings, { runSweep }));
        expect(health.querySelector('[data-sweep="stamp"]').textContent).toBe('');

        health.querySelector('#vectfox_size_run_sweep').click();
        await settle();

        const stamp = health.querySelector('[data-sweep="stamp"]').textContent;
        expect(stamp).toContain('Last sweep complete');
        expect(stamp).toContain('payload mode');
        expect(stamp).toContain('1 entry patched');
        expect(stamp).toContain('2 settings entries removed');
        // Re-measuring keeps it: it lives in settings, not in the render.
        health.querySelector('#vectfox_size_health_refresh').click();
        expect(health.querySelector('[data-sweep="stamp"]').textContent).toContain('payload mode');
    });

    it("drops the stale dry-run report the sweep just invalidated", async () => {
        const settings = sweepSettings();
        const runSweep = vi.fn(makeSweep(true)(settings));
        const runDryRun = vi.fn(makeDryRun({
            entries: {
                alpha: { context: 'about dragons', keywords: ['dragon'] },
                beta: { context: 'about elves', keywords: ['elf'] },
                gone: { context: 'about nothing' },
            },
            collections: [{ collectionId: 'A' }],
            chunksByCollection: {
                A: {
                    alpha: { context: 'about dragons', keywords: ['dragon'] },
                    beta: { context: 'about elves' },
                },
            },
        }));
        const health = healthOf(openTab(settings, { runSweep, runDryRun }));

        health.querySelector('#vectfox_size_dry_run').click();
        await settle();
        expect(health.querySelector('[data-dry-run="headline"]').textContent).toContain('1 redundant');

        health.querySelector('#vectfox_size_run_sweep').click();
        await settle();

        // The pre-sweep counts are gone; the run's own result is what stands.
        expect(health.querySelector('[data-dry-run="headline"]')).toBeNull();
        expect(health.querySelector('[data-sweep="headline"]').textContent).toContain('Sweep complete');
    });

    it("shows a save failure beside the counts instead of calling the run a failure", async () => {
        const runSweep = vi.fn(async () => ({
            status: 'measured',
            outcome: 'complete',
            headline: 'Sweep complete — 1 entry patched, 0 settings entries removed.',
            failure: null,
            refusal: null,
            resumedNote: null,
            saveWarning: 'The run finished, but the settings could not be saved: disk full. '
                + 'The deletions and the stamp are in memory only until a settings save succeeds.',
            counts: {
                entries: { count: 1, label: '1' },
                patched: { count: 1, label: '1' },
                deleted: { count: 0, label: '0' },
            },
            stampNote: '',
        }));
        const health = healthOf(openTab(sweepSettings(), { runSweep }));

        health.querySelector('#vectfox_size_run_sweep').click();
        await settle();

        expect(sweepStatusOf(health)).toContain('Sweep complete');
        expect(health.querySelector('[data-sweep="save-warning"]').textContent)
            .toContain('could not be saved');
        expect(health.querySelector('[data-sweep="failure"]')).toBeNull();
    });

    it("reports an unavailable sweep instead of pretending it ran", async () => {
        const runSweep = vi.fn(async () => ({
            status: 'unavailable',
            reason: 'The Similharity plugin is not available, so there is no chunk payload to compare against.',
        }));
        const health = healthOf(openTab(sweepSettings(), { runSweep }));

        health.querySelector('#vectfox_size_run_sweep').click();
        await settle();

        expect(sweepStatusOf(health)).toContain('Similharity plugin is not available');
        expect(health.querySelector('[data-sweep="headline"]')).toBeNull();
        expect(health.querySelector('#vectfox_size_run_sweep').disabled).toBe(false);
    });

    it("says the sweep is unavailable when no runner is wired", async () => {
        const health = healthOf(openTab(sweepSettings()));

        health.querySelector('#vectfox_size_run_sweep').click();
        await settle();

        expect(sweepStatusOf(health)).toContain('not available in this build');
    });

    it("reports a runner failure and leaves the button usable", async () => {
        const runSweep = vi.fn(async () => { throw new Error('backend went away'); });
        const health = healthOf(openTab(sweepSettings(), { runSweep }));

        health.querySelector('#vectfox_size_run_sweep').click();
        await settle();

        expect(sweepStatusOf(health)).toContain('Sweep failed: backend went away');
        expect(health.querySelector('#vectfox_size_run_sweep').disabled).toBe(false);
    });

    it("refuses to start a second action while one is in flight", async () => {
        let release;
        const runSweep = vi.fn(() => new Promise((resolve) => { release = resolve; }));
        const runDryRun = vi.fn(makeSweep(true)(sweepSettings()));
        const health = healthOf(openTab(sweepSettings(), { runSweep, runDryRun }));
        const sweepButton = health.querySelector('#vectfox_size_run_sweep');

        sweepButton.click();
        await settle();

        expect(sweepButton.disabled).toBe(true);
        expect(health.querySelector('#vectfox_size_dry_run').disabled).toBe(true);
        expect(health.querySelector('#vectfox_size_backup_download').disabled).toBe(true);

        // A second click while busy is ignored rather than starting another scan.
        sweepButton.click();
        health.querySelector('#vectfox_size_dry_run').click();
        await settle();
        expect(runSweep).toHaveBeenCalledTimes(1);
        expect(runDryRun).not.toHaveBeenCalled();

        release({
            status: 'measured',
            outcome: 'noop',
            headline: 'Nothing to sweep — every chunk-metadata entry is already migrated.',
            failure: null,
            refusal: null,
            resumedNote: null,
            counts: { entries: { count: 0, label: '0' }, patched: { count: 0, label: '0' }, deleted: { count: 0, label: '0' } },
            stampNote: '',
        });
        await settle();

        expect(health.querySelector('#vectfox_size_run_sweep').disabled).toBe(false);
        expect(health.querySelector('[data-sweep="headline"]').textContent).toContain('Nothing to sweep');
    });
});


/** One redundant entry, one patchable entry and two orphans on collection A. */
const ORPHAN_CHUNKS = {
    'qdrant:A': {
        alpha: { context: 'about dragons', keywords: ['dragon'] },
        beta: { context: 'about elves' },
    },
};

function orphanDeleteSettings() {
    return {
        chunk_size: 500,
        'vectfox_chunk_meta_alpha': { context: 'about dragons', keywords: ['dragon'] },
        'vectfox_chunk_meta_beta': { context: 'about elves', keywords: ['elf'] },
        'vectfox_chunk_meta_gone': { context: 'about nothing' },
        'vectfox_chunk_meta_gone2': { context: 'still nothing', keywords: ['void'] },
    };
}

function legacyEntriesOf(settings) {
    return Object.fromEntries(
        Object.entries(settings)
            .filter(([key]) => key.startsWith('vectfox_chunk_meta_'))
            .map(([key, metadata]) => [key.slice('vectfox_chunk_meta_'.length), metadata]),
    );
}

/**
 * The production orphan-deletion entry point over the fake listing and a
 * settings object that really loses its legacy keys, so the panel test sees the
 * shrink this action exists to produce. `confirm` is what the panel injects.
 */
function makeOrphanDelete(settings, { deleteEntry, persistSettings = vi.fn() } = {}) {
    const { listChunks, patchMetadata } = createFakeChunkListing({
        chunksByCollection: ORPHAN_CHUNKS,
        reportTotal: true,
    });
    const runner = createStorageOrphanDelete({
        createTransport: () => ({ isAvailable: () => true, listChunks, patchMetadata }),
        listCollections: () => [{ registryKey: 'qdrant:A', collectionId: 'A' }],
        listEntries: () => legacyEntriesOf(settings),
        clientOnlyFields: ['summaries'],
        deleteEntry: deleteEntry || ((hash) => {
            const key = `vectfox_chunk_meta_${hash}`;
            if (!(key in settings)) return false;
            delete settings[key];
            return true;
        }),
        persistSettings,
    });
    return ({ onProgress, confirm } = {}) => runner({
        getSettings: () => settings,
        onProgress,
        confirm,
    });
}

/** The dry run over the same collection, so the report and the deletion agree. */
function makeOrphanDryRun(settings) {
    return makeDryRun({
        entries: legacyEntriesOf(settings),
        collections: [{ collectionId: 'A' }],
        chunksByCollection: { A: ORPHAN_CHUNKS['qdrant:A'] },
    });
}

function orphanStatusOf(health) {
    return health.querySelector('#vectfox_size_orphan_status').textContent;
}

describe("Size Inspector — deleting orphans behind a confirmation", () => {
    it("offers the button but runs nothing until it is clicked", async () => {
        const settings = orphanDeleteSettings();
        const runDeleteOrphans = vi.fn(makeOrphanDelete(settings));

        const health = healthOf(openTab(settings, { runDeleteOrphans }));
        await settle();

        const button = health.querySelector('#vectfox_size_delete_orphans');
        expect(button).not.toBeNull();
        expect(button.disabled).toBe(false);
        expect(runDeleteOrphans).not.toHaveBeenCalled();
    });

    it("asks with the count and the released size, then deletes and re-measures", async () => {
        const settings = orphanDeleteSettings();
        const runDeleteOrphans = vi.fn(makeOrphanDelete(settings));
        const before = settingsByteSize(settings);
        let asked = null;
        const confirmOrphans = vi.fn((view) => {
            asked = view;
            // Nothing may be gone before the dialog has an answer.
            expect(settings['vectfox_chunk_meta_gone']).toBeDefined();
            expect(settings['vectfox_chunk_meta_gone2']).toBeDefined();
            return true;
        });
        const health = healthOf(openTab(settings, { runDeleteOrphans, confirmOrphans }));

        health.querySelector('#vectfox_size_delete_orphans').click();
        await settle();

        expect(confirmOrphans).toHaveBeenCalledTimes(1);
        expect(asked.headline).toContain('2 orphan settings entries');
        expect(asked.entries.label).toBe('2');
        expect(asked.bytes.bytes).toBeGreaterThan(0);
        expect(asked.detail).toContain('none of the registered collections this scan read');

        delete settings['vectfox_chunk_meta_gone'];
        delete settings['vectfox_chunk_meta_gone2'];
        expect(settingsByteSize(settings)).toBe(before - asked.bytes.bytes);
        expect(settings['vectfox_chunk_meta_beta']).toBeDefined();

        const result = health.querySelector('#vectfox_size_orphan_result');
        expect(result.querySelector('[data-orphan="headline"]').textContent)
            .toContain('Deleted 2 orphan settings entries');
        expect(result.querySelector('[data-orphan="deleted"]').textContent).toBe('2');
        expect(result.querySelector('[data-orphan="released"]').textContent)
            .toBe(asked.bytes.sizeLabel);
        expect(orphanStatusOf(health)).toContain('Deleted 2');
        // The block re-measured itself, so the smaller payload is visible.
        expect(health.querySelector('[data-health="chunk-meta"]').textContent)
            .toContain('2 entries');
    });

    it("deletes nothing when the user cancels and keeps the dry-run report", async () => {
        const settings = orphanDeleteSettings();
        const runDeleteOrphans = vi.fn(makeOrphanDelete(settings));
        const runDryRun = vi.fn(makeOrphanDryRun(settings));
        const confirmOrphans = vi.fn(() => false);
        const health = healthOf(openTab(settings, { runDeleteOrphans, runDryRun, confirmOrphans }));

        health.querySelector('#vectfox_size_dry_run').click();
        await settle();
        expect(health.querySelector('[data-dry-run="total-orphan"]').textContent).toBe('2');

        health.querySelector('#vectfox_size_delete_orphans').click();
        await settle();

        expect(settings['vectfox_chunk_meta_gone']).toBeDefined();
        expect(settings['vectfox_chunk_meta_gone2']).toBeDefined();
        expect(orphanStatusOf(health)).toContain('Nothing was deleted');
        expect(health.querySelector('[data-orphan="headline"]').textContent)
            .toContain('Nothing was deleted');
        expect(health.querySelector('[data-orphan="deleted"]').textContent).toBe('0');
        // Nothing was removed, so nothing was released — never the size the
        // dialog offered.
        expect(health.querySelector('[data-orphan="released"]').textContent).toBe('0 B');
        // The report still describes the settings, so it is not dropped.
        expect(health.querySelector('[data-dry-run="total-orphan"]').textContent).toBe('2');
    });

    it("drops the stale dry-run report after the orphans are gone", async () => {
        const settings = orphanDeleteSettings();
        const runDeleteOrphans = vi.fn(makeOrphanDelete(settings));
        const runDryRun = vi.fn(makeOrphanDryRun(settings));
        const health = healthOf(openTab(settings, {
            runDeleteOrphans,
            runDryRun,
            confirmOrphans: () => true,
        }));

        health.querySelector('#vectfox_size_dry_run').click();
        await settle();
        health.querySelector('#vectfox_size_delete_orphans').click();
        await settle();

        expect(health.querySelector('[data-dry-run="headline"]')).toBeNull();
        expect(health.querySelector('[data-orphan="headline"]').textContent)
            .toContain('Deleted 2 orphan settings entries');
    });

    it("shows a failed save beside the deletion instead of calling it a failure", async () => {
        const settings = orphanDeleteSettings();
        const runDeleteOrphans = vi.fn(makeOrphanDelete(settings, {
            persistSettings: vi.fn(() => { throw new Error('disk full'); }),
        }));
        const health = healthOf(openTab(settings, {
            runDeleteOrphans,
            confirmOrphans: () => true,
        }));

        health.querySelector('#vectfox_size_delete_orphans').click();
        await settle();

        expect(health.querySelector('[data-orphan="save-warning"]').textContent)
            .toContain('could not be saved');
        expect(health.querySelector('[data-orphan="failure"]')).toBeNull();
    });

    it("shows the refusal instead of a deletion when a collection could not be read", async () => {
        const runDeleteOrphans = vi.fn(async () => ({
            status: 'measured',
            outcome: 'refused',
            trusted: false,
            headline: 'No orphans were deleted — the scan could not verify every collection.',
            refusal: 'Deletion is refused for this run — 1 of 2 collections could not be read.',
            failure: null,
            saveWarning: null,
            counts: {
                entries: { count: 0, label: '0' },
                deleted: { count: 0, label: '0' },
                released: { bytes: 0, sizeLabel: '0 B', exactLabel: '0' },
            },
        }));
        const health = healthOf(openTab(orphanDeleteSettings(), {
            runDeleteOrphans,
            confirmOrphans: () => true,
        }));

        health.querySelector('#vectfox_size_delete_orphans').click();
        await settle();

        expect(health.querySelector('[data-orphan="refusal"]').textContent)
            .toContain('could not be read');
        expect(health.querySelector('[data-orphan="headline"]').textContent)
            .toContain('could not verify');
        expect(orphanStatusOf(health)).toContain('could not verify');
    });

    it("reports an unavailable deletion instead of pretending it ran", async () => {
        const runDeleteOrphans = vi.fn(async () => ({
            status: 'unavailable',
            reason: 'The Similharity plugin is not available, so there is no chunk payload to compare against.',
        }));
        const health = healthOf(openTab(orphanDeleteSettings(), { runDeleteOrphans }));

        health.querySelector('#vectfox_size_delete_orphans').click();
        await settle();

        expect(orphanStatusOf(health)).toContain('Similharity plugin is not available');
        expect(health.querySelector('[data-orphan="headline"]')).toBeNull();
        expect(health.querySelector('#vectfox_size_delete_orphans').disabled).toBe(false);
    });

    it("says the deletion is unavailable when no runner is wired", async () => {
        const health = healthOf(openTab(orphanDeleteSettings()));

        health.querySelector('#vectfox_size_delete_orphans').click();
        await settle();

        expect(orphanStatusOf(health)).toContain('not available in this build');
    });

    it("reports a runner failure and leaves the button usable", async () => {
        const runDeleteOrphans = vi.fn(async () => { throw new Error('backend went away'); });
        const health = healthOf(openTab(orphanDeleteSettings(), { runDeleteOrphans }));

        health.querySelector('#vectfox_size_delete_orphans').click();
        await settle();

        expect(orphanStatusOf(health)).toContain('Orphan deletion failed: backend went away');
        expect(health.querySelector('#vectfox_size_delete_orphans').disabled).toBe(false);
    });

    it("refuses to start while another collection action is in flight", async () => {
        let release;
        const runDeleteOrphans = vi.fn(() => new Promise((resolve) => { release = resolve; }));
        const runDryRun = vi.fn(makeOrphanDryRun(orphanDeleteSettings()));
        const health = healthOf(openTab(orphanDeleteSettings(), { runDeleteOrphans, runDryRun }));
        const button = health.querySelector('#vectfox_size_delete_orphans');

        button.click();
        await settle();

        expect(button.disabled).toBe(true);
        for (const selector of [
            '#vectfox_size_dry_run',
            '#vectfox_size_backup_download',
            '#vectfox_size_run_sweep',
        ]) {
            expect(health.querySelector(selector).disabled).toBe(true);
        }

        button.click();
        health.querySelector('#vectfox_size_dry_run').click();
        await settle();
        expect(runDeleteOrphans).toHaveBeenCalledTimes(1);
        expect(runDryRun).not.toHaveBeenCalled();

        release({
            status: 'measured',
            outcome: 'cancelled',
            headline: 'Nothing was deleted — the removal of 2 orphan settings entries was cancelled.',
            failure: null,
            saveWarning: null,
            refusal: null,
            counts: {
                entries: { count: 2, label: '2' },
                deleted: { count: 0, label: '0' },
                released: { bytes: 0, sizeLabel: '0 B', exactLabel: '0' },
            },
        });
        await settle();

        expect(health.querySelector('#vectfox_size_delete_orphans').disabled).toBe(false);
        expect(health.querySelector('[data-orphan="headline"]').textContent)
            .toContain('Nothing was deleted');
    });
});
