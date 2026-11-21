import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { rankByAnilist } from "./ratings.js";
import { Store } from "./store.js";
import { fakeEngine } from "./test-engine.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

describe("history", () => {
  it("lists series you've read, newest first, including ones not in the library, and hides 18+ unless unlocked", () => {
    const store = new Store(":memory:");
    store.recordSeriesMeta(1, "Solo", "Asura", false);
    store.recordSeriesMeta(2, "Secret", "NH", true);
    store.saveProgress(1, { chapterId: 11, chapterNumber: 3, chapterName: "3", pageIndex: 0, pageOffset: 0 });
    store.saveProgress(2, { chapterId: 21, chapterNumber: 1, chapterName: "1", pageIndex: 0, pageOffset: 0 });
    expect(store.history().map((h) => h.title)).toEqual(["Solo"]);
    expect(store.history(true).map((h) => h.mangaId).sort()).toEqual([1, 2]);
    store.removeHistory(1);
    expect(store.history()).toEqual([]);
  });
});

describe("categories", () => {
  it("creates shelves, files series on them, and cleans up when a shelf or series goes", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store });
    store.addToLibrary({ mangaId: 10, sourceId: "1", sourceName: "Asura", title: "Nano Machine" });
    const { id } = (await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Reading" } })).json();
    expect((await app.inject({ method: "POST", url: "/api/categories", payload: { name: " " } })).statusCode).toBe(400);
    await app.inject({ method: "PUT", url: "/api/library/10/categories", payload: { ids: [id, 999] } });
    expect(store.library()[0].categories).toEqual([id]);
    expect((await app.inject({ url: "/api/categories" })).json().categories).toEqual([{ id, name: "Reading", count: 1 }]);
    await app.inject({ method: "DELETE", url: `/api/categories/${id}` });
    expect(store.library()[0].categories).toEqual([]);
  });
});

describe("switching source", () => {
  it("moves the library entry, read chapters (by number), place and shelves to the other source", () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "a", sourceName: "Slow", title: "Nano" });
    const cat = store.createCategory("Reading");
    store.setSeriesCategories(1, [cat]);
    store.saveProgress(1, { chapterId: 102, chapterNumber: 2, chapterName: "2", pageIndex: 3, pageOffset: 0.5, finished: true });
    store.setChaptersRead(1, [101], true);
    store.switchSource(
      1,
      { mangaId: 2, sourceId: "b", sourceName: "Fast", title: "Nano" },
      { from: [{ id: 101, chapterNumber: 1 }, { id: 102, chapterNumber: 2 }], to: [1, 2, 3].map((n) => ({ id: 200 + n, chapterNumber: n, name: `${n}` })) },
    );
    expect(store.inLibrary(1)).toBe(false);
    const item = store.library()[0];
    expect(item).toMatchObject({ mangaId: 2, sourceName: "Fast", categories: [cat], latestNumber: 3, unread: 1 });
    expect(store.readChapterIds(2).sort()).toEqual([201, 202]);
    expect(store.getProgress(2)).toMatchObject({ chapterId: 202, pageIndex: 3 });
  });
});

describe("AniList ranking", () => {
  it("orders by score in one batched request, unknown titles last, and remembers answers", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const fake = (async (_u: string, init?: RequestInit) => {
      calls++;
      const vars = JSON.parse(String(init?.body)).variables as Record<string, string>;
      const data = Object.fromEntries(
        Object.entries(vars).map(([k, title]) => [`m${k.slice(1)}`, title === "Unknown" ? null : { id: title.length, averageScore: title === "Great" ? 90 : 60, meanScore: null, popularity: 100 }]),
      );
      return new Response(JSON.stringify({ data }));
    }) as unknown as typeof fetch;
    const groups = ["Okay", "Unknown", "Great"].map((t) => ({ key: t.toLowerCase(), title: t, hits: [] }));
    const out = await rankByAnilist(store, groups, "rating", fake);
    expect(out.map((g) => g.title)).toEqual(["Great", "Okay", "Unknown"]);
    expect(out[0].score).toBe(90);
    await rankByAnilist(store, groups, "rating", fake);
    expect(calls).toBe(1);
  });
});

describe("automation settings", () => {
  it("defaults to 3 chapters ahead and auto-switch on, and validates changes", async () => {
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store: new Store(":memory:") });
    expect((await app.inject({ url: "/api/settings/automation" })).json()).toEqual({ autoDownload: 3, autoSwitch: true });
    expect((await app.inject({ method: "PUT", url: "/api/settings/automation", payload: { autoDownload: 0 } })).json()).toEqual({ autoDownload: 0, autoSwitch: true });
    expect((await app.inject({ method: "PUT", url: "/api/settings/automation", payload: { autoDownload: 50 } })).statusCode).toBe(400);
  });
});
