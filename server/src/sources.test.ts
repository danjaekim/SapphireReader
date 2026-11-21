import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { fakeEngine } from "./test-engine.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

describe("source health", () => {
  it("tracks successes, failures and a moving average", () => {
    const store = new Store(":memory:");
    store.recordSource("1", "Asura", { ok: true, ms: 1000 });
    store.recordSource("1", "Asura", { ok: true, ms: 2000 });
    store.recordSource("1", "Asura", { ok: false, ms: 0, error: "timeout" });
    expect(store.sourceHealth()[0]).toMatchObject({ okCount: 2, failCount: 1, lastError: "timeout", avgMs: 1300 });
  });

  it("records health from searches and lists sources with it", async () => {
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store: new Store(":memory:") });
    await app.inject({ url: "/api/search?q=nano" });
    const { sources } = (await app.inject({ url: "/api/sources" })).json();
    const asura = sources.find((s: { name: string }) => s.name === "Asura Scans");
    const broken = sources.find((s: { name: string }) => s.name === "Broken Site");
    expect(asura.health.okCount).toBe(1);
    expect(broken.health.failCount).toBe(1);
  });
});

describe("other sources for a series", () => {
  it("finds the same series on other sources with their latest chapter", async () => {
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store: new Store(":memory:") });
    const res = await app.inject({ url: "/api/manga/10/alternatives" });
    expect(res.statusCode).toBe(200);
    const { alternatives } = res.json();
    expect(alternatives).toHaveLength(1);
    expect(alternatives[0]).toMatchObject({ mangaId: 20, sourceName: "MangaFire", latestNumber: 236.5 });
  });
});
