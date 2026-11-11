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

function openTab(settings) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderSizeInspectorTab(container, () => settings);
    return container;
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
