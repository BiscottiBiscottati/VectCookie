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
import { createFakeChunkListing } from './fixtures/chunk-listing.js';

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
        const independent = Buffer.byteLength(JSON.stringify(settings), "utf8");

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
