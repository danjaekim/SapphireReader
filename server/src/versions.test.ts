import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

/**
 * Three listings of "Dual": 100 on Asura (the one in the library), 200 on MangaFire, 300 on Flame.
 * `latest` says how many chapters each has.
 */
function engine(latest: Record<number, number>): typeof fetch {
  return (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (q.includes("sources {")) {
      return json({ sources: { nodes: [
        { id: "1", name: "Asura", lang: "en", isNsfw: false },
        { id: "2", name: "MangaFire", lang: "en", isNsfw: false },
        { id: "3", name: "Flame", lang: "en", isNsfw: false },
      ] } });
    }
    if (q.includes("fetchSourceManga")) {
      const src = Number(body.variables.input.source);
      return json({ fetchSourceManga: { mangas: [{ id: src * 100, title: "Dual", thumbnailUrl: null }] } });
    }
    if (q.includes("fetchChapters")) {
      const id = body.variables.input.mangaId as number;
      const n = latest[id] ?? 0;
      return json({ fetchChapters: { chapters: Array.from({ length: n }, (_, i) => ({ id: id * 1000 + i + 1, name: `Ch ${i + 1}`, chapterNumber: i + 1, uploadDate: "1700000000000", scanlator: null })) } });
    }
    if (q.includes("manga(id")) {
      const id = body.variables.id as number;
      return json({ manga: { id, sourceId: String(id / 100), title: "Dual", thumbnailUrl: null, author: null, artist: null, description: null, genre: [], status: "ONGOING" } });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

async function setup(latest: Record<number, number>, versions: Record<number, string>, reading = 100) {
  const store = new Store(":memory:");
  for (const [id, label] of Object.entries(versions)) store.setVersion(Number(id), label);
  const app = await buildApp(config, { fetchImpl: engine(latest), store });
  const src = reading / 100;
  store.addToLibrary({ mangaId: reading, sourceId: String(src), sourceName: ["", "Asura", "MangaFire", "Flame"][src], title: "Dual" });
  const last = latest[reading];
  store.saveProgress(reading, { chapterId: reading * 1000 + last, chapterNumber: last, chapterName: `Ch ${last}`, pageIndex: 0, pageOffset: 0, finished: true });
  store.setChaptersRead(reading, [reading * 1000 + last], true);
  await app.runCheck(0);
  // The move offers are worked out in the background after the check.
  for (let i = 0; i < 50 && store.switchOffers(true).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  return { app, store, offer: store.switchOffers(true)[0] ?? null };
}

describe("versions", () => {
  it("stays on your version: offers the same version further ahead before another version", async () => {
    const { offer } = await setup({ 100: 10, 200: 20, 300: 15 }, { 100: "Uncensored", 200: "Censored", 300: "Uncensored" });
    expect(offer).toMatchObject({ toMangaId: 300, kind: "ahead", toVersion: "Uncensored" });
  });

  it("says when only another version has the newer chapters", async () => {
    const { offer } = await setup({ 100: 10, 200: 20, 300: 10 }, { 100: "Uncensored", 200: "Censored" });
    expect(offer).toMatchObject({ toMangaId: 200, kind: "other-version", toVersion: "Censored" });
  });

  it("offers the way back once the preferred version has caught up", async () => {
    // Reading the censored copy (200); the uncensored one (100) now has as many chapters.
    const { offer } = await setup({ 100: 20, 200: 20, 300: 0 }, { 100: "Uncensored", 200: "Censored" }, 200);
    expect(offer).toMatchObject({ toMangaId: 100, kind: "back", toVersion: "Uncensored" });
  });

  it("labels listings and keeps a chosen preferred version, shown on the series", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: engine({ 100: 3, 200: 5 }), store });
    expect((await app.inject({ method: "PUT", url: "/api/manga/200/version", payload: { label: " Censored " } })).json()).toEqual({ version: "Censored" });
    expect((await app.inject({ method: "PUT", url: "/api/manga/100/preferred-version", payload: { label: "Colored" } })).json()).toEqual({ preferredVersion: "Colored" });
    const s = (await app.inject({ url: "/api/manga/200" })).json();
    expect(s).toMatchObject({ version: "Censored", preferredVersion: "Colored" });
    await app.inject({ method: "PUT", url: "/api/manga/100/preferred-version", payload: { label: null } });
    await app.inject({ method: "PUT", url: "/api/manga/100/version", payload: { label: "uncensored" } });
    // With no choice made, an Uncensored listing is preferred... once it's among the series' listings.
    expect((await app.inject({ url: "/api/manga/100" })).json().preferredVersion).toBe("uncensored");
    await app.inject({ method: "PUT", url: "/api/manga/200/version", payload: { label: null } });
    expect(store.versionOf(200)).toBeNull();
    expect((await app.inject({ method: "PUT", url: "/api/manga/200/version", payload: { label: 5 } })).statusCode).toBe(400);
  });
});
