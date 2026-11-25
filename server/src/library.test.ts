import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { fakeEngine } from "./test-engine.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

describe("store", () => {
  it("keeps progress, marks finished chapters, and counts unread chapters", () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "s", sourceName: "Asura", title: "Nano Machine" });
    expect(store.library()[0].unread).toBeNull(); // chapter list not loaded yet

    store.setChapterNumbers(1, [1, 2, 3, 4, 5, -1]);
    expect(store.library()[0]).toMatchObject({ unread: 5, latestNumber: 5, chapterCount: 6 });

    // Reading chapter 3 but not finishing it: chapters 3, 4 and 5 are still unread.
    store.saveProgress(1, { chapterId: 103, chapterNumber: 3, chapterName: "Ch 3", pageIndex: 4, pageOffset: 0.5 });
    expect(store.library()[0].unread).toBe(3);
    expect(store.getProgress(1)).toMatchObject({ chapterId: 103, pageIndex: 4, pageOffset: 0.5 });

    // Finishing it leaves chapters 4 and 5.
    store.saveProgress(1, { chapterId: 103, chapterNumber: 3, chapterName: "Ch 3", pageIndex: 9, pageOffset: 1, finished: true });
    expect(store.library()[0].unread).toBe(2);
    expect(store.readChapterIds(1)).toEqual([103]);
  });

  it("keeps reading history when a series leaves the library", () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "s", sourceName: null, title: "X" });
    store.saveProgress(1, { chapterId: 5, chapterNumber: 5, chapterName: "5", pageIndex: 0, pageOffset: 0, finished: true });
    store.removeFromLibrary(1);
    expect(store.inLibrary(1)).toBe(false);
    expect(store.getProgress(1)?.chapterId).toBe(5);
  });

  it("lists most recently read series first", () => {
    const store = new Store(":memory:");
    for (const id of [1, 2, 3]) store.addToLibrary({ mangaId: id, sourceId: "s", sourceName: null, title: `T${id}` });
    store.saveProgress(2, { chapterId: 1, chapterNumber: 1, chapterName: "1", pageIndex: 0, pageOffset: 0 });
    expect(store.library()[0].mangaId).toBe(2);
  });
});

describe("library api", () => {
  it("adds a series, saves progress, and reports both on the series page and library", async () => {
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store: new Store(":memory:") });

    const add = await app.inject({
      method: "PUT",
      url: "/api/library/10",
      payload: { sourceId: "1", sourceName: "Asura Scans", title: "Nano Machine" },
    });
    expect(add.statusCode).toBe(200);

    const save = await app.inject({
      method: "PUT",
      url: "/api/progress/10",
      payload: { chapterId: 501, chapterNumber: 3, chapterName: "Chapter 3", pageIndex: 2, pageOffset: 0.25, finished: true },
    });
    expect(save.statusCode).toBe(200);

    const page = (await app.inject({ method: "GET", url: "/api/manga/10" })).json();
    expect(page.inLibrary).toBe(true);
    expect(page.progress).toMatchObject({ chapterId: 501, pageIndex: 2 });
    expect(page.readChapterIds).toEqual([501]);

    const lib = (await app.inject({ method: "GET", url: "/api/library" })).json();
    expect(lib.items).toHaveLength(1);
    // Fake engine has chapters 236.5, 3 and one unnumbered; finishing chapter 3 leaves 236.5.
    expect(lib.items[0]).toMatchObject({ title: "Nano Machine", unread: 1, latestNumber: 236.5 });

    const refreshed = (await app.inject({ method: "POST", url: "/api/library/refresh" })).json();
    expect(refreshed.failed).toEqual([]);
    expect(refreshed.items).toHaveLength(1);

    await app.inject({ method: "DELETE", url: "/api/library/10" });
    expect((await app.inject({ method: "GET", url: "/api/library" })).json().items).toEqual([]);
  });

  it("rejects malformed progress", async () => {
    const app = await buildApp(config, { fetchImpl: fakeEngine() });
    const res = await app.inject({ method: "PUT", url: "/api/progress/10", payload: { chapterId: "nope" } });
    expect(res.statusCode).toBe(400);
  });

  it("adds a series even when the source can't be reached", async () => {
    const down = (async () => new Response("down", { status: 500 })) as typeof fetch;
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: down, store });
    const res = await app.inject({ method: "PUT", url: "/api/library/7", payload: { sourceId: "1", title: "X" } });
    expect(res.statusCode).toBe(200);
    expect(store.inLibrary(7)).toBe(true);
  });
});

describe("marking chapters by hand", () => {
  it("marks read ahead (moving your place) and unread (moving it back)", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store });
    const mark = (chapterIds: number[], read: boolean) => app.inject({ method: "POST", url: "/api/manga/10/read", payload: { chapterIds, read } });
    let res = await mark([501, 502], true);
    expect(res.statusCode).toBe(200);
    expect(res.json().readChapterIds.sort()).toEqual([501, 502]);
    expect(store.getProgress(10)?.chapterId).toBe(502);
    res = await mark([502], false);
    expect(res.json().readChapterIds).toEqual([501]);
    expect(store.getProgress(10)?.chapterId).toBe(501);
    res = await mark([501], false);
    expect(store.getProgress(10)).toBeNull();
    expect((await mark([1], "yes" as unknown as boolean)).statusCode).toBe(400);
  });



  it("counts a series once in your taste, however many listings of it you have", () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "s", sourceName: null, title: "Someone Stop Her" });
    store.setGenres(1, ["Romance", "Harem"]);
    store.addToLibrary({ mangaId: 2, sourceId: "t", sourceName: null, title: "Someone Stop Her!" });
    store.setGenres(2, ["Romance", "Big Breasts"]);
    store.recordSeriesTags(3, ["Drama"]);
    store.setLiked(3, "Someone Stop Her", false, true);
    const liked = store.likedSeries();
    expect(liked).toHaveLength(1);
    expect(liked[0].tags).toEqual(["Romance", "Harem", "Big Breasts"]);
    // The ♥ on another listing still adds to the series.
    expect(liked[0].weight).toBe(4);
  });
});
