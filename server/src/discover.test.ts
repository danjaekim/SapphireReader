import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { recommendationQueries } from "./discover.js";
import { Store } from "./store.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

const genreFilters = [
  { __typename: "GroupFilter", name: "Genres", filters: [
    { __typename: "TriStateFilter", name: "Action" },
    { __typename: "TriStateFilter", name: "Murim" },
    { __typename: "TriStateFilter", name: "Romance" },
  ] },
];

function engine(log: { type?: string; filters?: unknown }[] = []): typeof fetch {
  return (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (q.includes("sources {")) {
      return json({ sources: { nodes: [
        { id: "1", name: "Asura Scans", lang: "en", isNsfw: false },
        { id: "2", name: "MangaFire", lang: "all", isNsfw: false },
      ] } });
    }
    if (q.includes("source(id")) return json({ source: { filters: genreFilters } });
    if (q.includes("manga(id")) {
      return json({ manga: { id: 10, sourceId: "1", title: "Nano Machine", thumbnailUrl: null, author: null, artist: null, description: null, genre: ["Action", "Murim"], status: "ONGOING" } });
    }
    if (q.includes("fetchChapters")) return json({ fetchChapters: { chapters: [{ id: 1, name: "Chapter 1", chapterNumber: 1, uploadDate: "1700000000000", scanlator: null }] } });
    if (q.includes("fetchSourceManga")) {
      const input = body.variables.input;
      log.push({ type: input.type, filters: input.filters });
      const src = input.source;
      const titles = input.type === "LATEST" ? ["Fresh One", "Fresh Two"] : ["Nano Machine", `Hit ${src}`, "Shared Hit"];
      return json({ fetchSourceManga: { mangas: titles.map((t, i) => ({ id: Number(src) * 100 + i, title: t, thumbnailUrl: null })) } });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("discover", () => {
  it("merges each source's popular or latest list, interleaved by rank", async () => {
    const log: { type?: string }[] = [];
    const app = await buildApp(config, { fetchImpl: engine(log), store: new Store(":memory:") });
    const pop = (await app.inject({ url: "/api/discover?sort=popular" })).json();
    expect(pop.groups.map((g: { title: string }) => g.title)).toEqual(["Nano Machine", "Hit 1", "Hit 2", "Shared Hit"]);
    const latest = (await app.inject({ url: "/api/discover?sort=latest" })).json();
    expect(latest.groups.map((g: { title: string }) => g.title)).toEqual(["Fresh One", "Fresh Two"]);
    expect(log.some((l) => l.type === "LATEST")).toBe(true);
  });
});

describe("similar and for you", () => {
  it("finds similar series by the title's top genres, without the series itself", async () => {
    const log: { filters?: unknown }[] = [];
    const app = await buildApp(config, { fetchImpl: engine(log), store: new Store(":memory:") });
    const { groups } = (await app.inject({ url: "/api/manga/10/similar" })).json();
    expect(groups.map((g: { title: string }) => g.title)).not.toContain("Nano Machine");
    expect(groups.map((g: { title: string }) => g.title)).toContain("Shared Hit");
    expect((log.at(-1)!.filters as unknown[]).length).toBe(2); // Action + Murim
  });

  it("recommends from the genres in your library and skips what you already have", async () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 10, sourceId: "1", sourceName: "Asura Scans", title: "Shared Hit" });
    store.setGenres(10, ["Action", "Murim"]);
    store.saveProgress(10, { chapterId: 1, chapterNumber: 1, chapterName: "1", pageIndex: 0, pageOffset: 0 });
    expect(store.tasteProfile()).toEqual([{ genre: "Action", weight: 2 }, { genre: "Murim", weight: 2 }]);
    const app = await buildApp(config, { fetchImpl: engine(), store });
    const out = (await app.inject({ url: "/api/for-you" })).json();
    const titles = out.groups.map((g: { title: string }) => g.title);
    expect(titles).toContain("Nano Machine");
    expect(titles).not.toContain("Shared Hit");
    expect(out.because).toEqual(["Action", "Murim"]);
  });

  it("returns nothing to recommend from an empty library", async () => {
    const app = await buildApp(config, { fetchImpl: engine(), store: new Store(":memory:") });
    expect((await app.inject({ url: "/api/for-you" })).json()).toEqual({ groups: [], because: [] });
    expect(recommendationQueries([{ genre: "A" }, { genre: "B" }, { genre: "C" }])).toEqual([["A", "B"], ["A"], ["B"], ["C"]]);
  });
});
