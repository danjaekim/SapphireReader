import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

const genreFilters = [
  { __typename: "GroupFilter", name: "Genres", filters: [
    { __typename: "TriStateFilter", name: "Action" },
    { __typename: "TriStateFilter", name: "Murim" },
    { __typename: "TriStateFilter", name: "Romance" },
  ] },
];

function engine(log: { type?: string; filters?: unknown; page?: number }[] = []): typeof fetch {
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
      log.push({ type: input.type, filters: input.filters, page: input.page });
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

describe("paging", () => {
  it("asks each source for the requested page, and treats a bad page as 1", async () => {
    const log: { page?: number }[] = [];
    const app = await buildApp(config, { fetchImpl: engine(log), store: new Store(":memory:") });
    await app.inject({ url: "/api/discover?sort=popular&page=3" });
    await app.inject({ url: "/api/search?q=nano&page=2" });
    await app.inject({ url: "/api/browse?genres=Action&page=4" });
    await app.inject({ url: "/api/discover?page=abc" });
    expect([...new Set(log.map((l) => l.page))].sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("similar and for you", () => {
  it("finds similar series by the title's top genres, without the series itself", async () => {
    const log: { filters?: unknown }[] = [];
    const app = await buildApp(config, { fetchImpl: engine(log), store: new Store(":memory:") });
    const { groups } = (await app.inject({ url: "/api/manga/10/similar" })).json();
    expect(groups.map((g: { title: string }) => g.title)).not.toContain("Nano Machine");
    expect(groups.map((g: { title: string }) => g.title)).toContain("Shared Hit");
    // Tries both genres together first, then relaxes to one.
    expect(log.map((l) => (l.filters as unknown[] | undefined)?.length)).toEqual(expect.arrayContaining([2, 1]));
  });

  it("recommends from the genres in your library and skips what you already have", async () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 10, sourceId: "1", sourceName: "Asura Scans", title: "Shared Hit" });
    store.setGenres(10, ["Action", "Murim"]);
    store.saveProgress(10, { chapterId: 1, chapterNumber: 1, chapterName: "1", pageIndex: 0, pageOffset: 0 });
    expect(store.tasteProfile()).toEqual([{ genre: "Action", weight: 2 }, { genre: "Murim", weight: 2 }]);
    // Murim is this series' primary tag, so it counts for more than Action (rarity no longer decides, Nov 24).
    store.setSetting("primary_tags.shared hit", JSON.stringify(["Murim"]));
    const app = await buildApp(config, { fetchImpl: engine(), store });
    const out = (await app.inject({ url: "/api/for-you" })).json();
    const titles = out.groups.map((g: { title: string }) => g.title);
    expect(titles).toContain("Nano Machine");
    expect(titles).not.toContain("Shared Hit");
    expect(out.because).toEqual(["Murim", "Action"]);
    expect(out.shelves[0]).toMatchObject({ tags: ["Murim", "Action"], from: "Shared Hit" });
  });

  it("returns nothing to recommend from an empty library", async () => {
    const app = await buildApp(config, { fetchImpl: engine(), store: new Store(":memory:") });
    expect((await app.inject({ url: "/api/for-you" })).json()).toMatchObject({ shelves: [], groups: [], because: [], stale: false });
  });
});

describe("for you rows", () => {
  it("makes a row per mix of tags your series have, not one blend of your top tags", async () => {
    const { planShelves } = await import("./discover.js");
    const flat = () => 1;
    const liked = [
      { mangaId: 1, title: "Murim Return", tags: ["Action", "Murim", "Regression"], weight: 3 },
      { mangaId: 2, title: "Another Murim", tags: ["Murim", "Regression", "Comedy"], weight: 2 },
      { mangaId: 3, title: "Villainess Story", tags: ["Romance", "Villainess", "Isekai"], weight: 2 },
      { mangaId: 4, title: "Office Love", tags: ["Romance", "Office Workers", "Manhwa"], weight: 1 },
    ];
    const plan = planShelves(liked, flat);
    const keys = plan.map((p) => p.tags.slice().sort().join("+"));
    expect(keys[0]).toBe("Murim+Regression");
    expect(plan[0].from).toBe("Murim Return");
    // The romance side of the library gets its own row, and format tags never seed one.
    expect(keys.some((k) => k.includes("Romance"))).toBe(true);
    expect(keys.join(" ")).not.toContain("Manhwa");
    // No tag carries more than two rows.
    const counts = new Map<string, number>();
    for (const p of plan) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(2);
  });

  it("never suggests a series marked not interested, and counts its tags against", async () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 10, sourceId: "1", sourceName: "Asura Scans", title: "Shared Hit" });
    store.setGenres(10, ["Action", "Murim"]);
    const app = await buildApp(config, { fetchImpl: engine(), store });
    const titles = async () => ((await app.inject({ url: "/api/for-you" })).json().groups as { title: string }[]).map((g) => g.title);
    expect(await titles()).toContain("Nano Machine");
    const res = await app.inject({ method: "PUT", url: "/api/manga/20/not-interested", payload: { title: "Nano Machine" } });
    expect(res.statusCode).toBe(200);
    expect(await titles()).not.toContain("Nano Machine");
    await app.inject({ method: "PUT", url: "/api/manga/20/not-interested", payload: { title: "Nano Machine", on: false } });
    expect(await titles()).toContain("Nano Machine");
  });

  it("learns from a liked series that isn't in the library", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: engine(), store });
    expect((await app.inject({ url: "/api/for-you" })).json().shelves).toEqual([]);
    const res = await app.inject({ method: "PUT", url: "/api/manga/10/like", payload: { on: true } });
    expect(res.json()).toEqual({ liked: true });
    expect((await app.inject({ url: "/api/manga/10" })).json().liked).toBe(true);
    expect(store.likedSeries().map((l) => l.title)).toEqual(["Nano Machine"]);
    const out = (await app.inject({ url: "/api/for-you" })).json();
    expect(out.shelves.length).toBeGreaterThan(0);
    await app.inject({ method: "PUT", url: "/api/manga/10/like", payload: { on: false } });
    expect(store.likedSeries()).toEqual([]);
  });

  it("tries other mixes, then single tags, when a mix finds nothing", async () => {
    const { recommendShelves } = await import("./discover.js");
    const tried: string[] = [];
    const hit = (title: string) => ({ key: title.toLowerCase(), title, hits: [{ mangaId: title.length, sourceId: "3", sourceName: "Site", title, thumbnailUrl: null }] });
    const out = await recommendShelves(config, [{ mangaId: 1, title: "Mine", tags: ["Sports", "Romance", "Harem"], weight: 2 }], ["Mine"], {
      knowledge: { weight: () => 1, tagsOf: () => null },
      // The site only knows Romance: every pair comes back empty.
      browse: async (tags) => {
        tried.push(tags.join("+"));
        return { groups: tags.length === 1 && tags[0] === "Romance" ? [hit("Love Story")] : [], failed: [], searched: 1 };
      },
    });
    expect(tried.some((t) => t.includes("+"))).toBe(true);
    expect(out.shelves.map((s) => s.tags)).toEqual([["Romance"]]);
    expect(out.shelves[0].from).toBe("Mine");
    expect(out.groups.map((g) => g.title)).toEqual(["Love Story"]);
  });

  it("leaves hidden tags out of the plan", async () => {
    const { planShelves } = await import("./discover.js");
    const plan = planShelves([{ mangaId: 1, title: "X", tags: ["Boys' Love", "Romance", "Drama"], weight: 2 }], () => 1, new Set(["boys love"]));
    expect(plan.flatMap((p) => p.tags)).not.toContain("Boys' Love");
  });
});

describe("similar scoring", () => {
  it("searches the most telling tags first and ranks series sharing more of them higher", async () => {
    const { similarTo } = await import("./discover.js");
    (await import("./browse.js")).clearFilterCache();
    const filterSets: string[][] = [];
    const fake = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const q: string = body.query;
      const json = (data: unknown) => new Response(JSON.stringify({ data }));
      if (q.includes("sources {")) return json({ sources: { nodes: [{ id: "1", name: "Site", lang: "en", isNsfw: false }] } });
      if (q.includes("source(id")) return json({ source: { filters: [{ __typename: "GroupFilter", name: "Genres", filters: ["Action", "Murim", "Glasses"].map((name) => ({ __typename: "CheckBoxFilter", name })) }] } });
      if (q.includes("fetchSourceManga")) {
        const picked = (body.variables.input.filters as { groupChange: { position: number } }[]).map((f) => ["Action", "Murim", "Glasses"][f.groupChange.position]);
        filterSets.push(picked);
        const has = (t: string) => picked.includes(t);
        const titles = has("Glasses") && has("Murim") ? ["Best Match"] : has("Glasses") ? ["Best Match", "Glasses Only"] : ["Action Thing"];
        return json({ fetchSourceManga: { mangas: titles.map((t, i) => ({ id: 50 + i + (t === "Action Thing" ? 10 : 0), title: t, thumbnailUrl: null })) } });
      }
      return new Response("?", { status: 500 });
    }) as unknown as typeof fetch;
    const weights: Record<string, number> = { action: 0.1, murim: 0.6, glass: 0.9 };
    const out = await similarTo(config, "Me", ["Action", "Murim", "Glasses"], {
      fetchImpl: fake,
      knowledge: { weight: (t) => weights[t.toLowerCase().replace(/es$/, "")] ?? 1, tagsOf: () => null },
    });
    expect(out.basedOn).toEqual(["Glasses", "Murim", "Action"]);
    expect(filterSets[0].sort()).toEqual(["Glasses", "Murim"]);
    expect(out.groups[0].title).toBe("Best Match");
    expect(out.groups.map((g) => g.title).indexOf("Glasses Only")).toBeLessThan(out.groups.map((g) => g.title).indexOf("Action Thing"));
  });
});

describe("favorite tags", () => {
  it("can fill rows on their own, named for your favorites rather than a series", async () => {
    const { planShelves, FAVORITES_ID, FAVORITES_WEIGHT } = await import("./discover.js");
    const plan = planShelves([{ mangaId: FAVORITES_ID, title: "", tags: ["Murim", "Regression", "Revenge"], weight: FAVORITES_WEIGHT }], () => 1);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((p) => p.from === "")).toBe(true);
  });

  it("outweigh a tag a single liked series happens to have", async () => {
    const { tasteWeights, FAVORITES_ID, FAVORITES_WEIGHT } = await import("./discover.js");
    const taste = tasteWeights(
      [
        { mangaId: 1, title: "A", tags: ["Action", "Romance"], weight: 2 },
        { mangaId: FAVORITES_ID, title: "", tags: ["Romance"], weight: FAVORITES_WEIGHT },
      ],
      () => 1,
    );
    expect(taste.get("romance")!.w).toBeGreaterThan(taste.get("action")!.w * 3);
  });
});

describe("for you caching", () => {
  const searches = (log: unknown[]) => log.length;
  async function setup() {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 10, sourceId: "1", sourceName: "Asura Scans", title: "Shared Hit" });
    store.setGenres(10, ["Action", "Murim"]);
    const log: { type?: string }[] = [];
    const app = await buildApp(config, { fetchImpl: engine(log), store });
    return { store, log, app, get: async (q = "") => (await app.inject({ url: `/api/for-you${q}` })).json() };
  }

  it("serves the saved answer while nothing it learns from has changed", async () => {
    const { log, get } = await setup();
    const first = await get();
    const calls = searches(log);
    expect(calls).toBeGreaterThan(0);
    expect(first.stale).toBe(false);
    const second = await get();
    expect(searches(log)).toBe(calls);
    expect(second.computedAt).toBe(first.computedAt);
  });

  it("holds off rebuilding after a library change until the gap has passed, and Refresh forces it", async () => {
    const { store, log, get } = await setup();
    const first = await get();
    const calls = searches(log);
    store.addToLibrary({ mangaId: 11, sourceId: "1", sourceName: "Asura Scans", title: "Another One" });
    store.setGenres(11, ["Romance"]);
    const soon = await get();
    expect(soon.stale).toBe(true);
    expect(soon.computedAt).toBe(first.computedAt);
    expect(searches(log)).toBe(calls);
    const fresh = await get("?refresh=1");
    expect(fresh.stale).toBe(false);
    expect(searches(log)).toBeGreaterThan(calls);
    expect(fresh.computedAt).toBeGreaterThanOrEqual(first.computedAt);
  });

  it("applies Not interested at once, without rebuilding", async () => {
    const { app, log, get } = await setup();
    const titles = (v: { groups: { title: string }[] }) => v.groups.map((g) => g.title);
    expect(titles(await get())).toContain("Nano Machine");
    const calls = searches(log);
    await app.inject({ method: "PUT", url: "/api/manga/20/not-interested", payload: { title: "Nano Machine" } });
    expect(titles(await get())).not.toContain("Nano Machine");
    expect(searches(log)).toBe(calls);
  });

  it("takes a title you mark 18+ out of the answer without rebuilding it", async () => {
    const { app, log, get } = await setup();
    const titles = (v: { groups: { title: string }[] }) => v.groups.map((g) => g.title);
    expect(titles(await get())).toContain("Nano Machine");
    const calls = searches(log);
    await app.inject({ method: "PUT", url: "/api/adult-marks", payload: { titles: ["Nano Machine"], mark: true } });
    expect(titles(await get())).not.toContain("Nano Machine");
    expect(searches(log)).toBe(calls);
  });

  it("keeps the ordinary and 18+ pages' answers apart", async () => {
    const { store } = await setup();
    store.recCacheSet("for-you", true, "k", 1, { groups: [{ key: "x" }] });
    expect(store.recCacheGet("for-you", false)).toBeNull();
    expect(store.recCacheGet("for-you", true)?.key).toBe("k");
  });
});

describe("tag importance in recommendations", () => {
  it("counts a series' central tags for more than its incidental ones, whatever their rarity", async () => {
    const { tasteWeights, planShelves } = await import("./discover.js");
    const liked = [
      { mangaId: 1, title: "A", tags: ["Action", "Cooking", "Revenge"], weight: 2, importance: (t: string) => (t === "Revenge" ? 3 : t === "Cooking" ? 0.6 : 1) },
    ];
    const taste = tasteWeights(liked, () => 1);
    expect(taste.get("revenge")!.w).toBeGreaterThan(taste.get("action")!.w);
    expect(taste.get("action")!.w).toBeGreaterThan(taste.get("cooking")!.w);
    // The series' row leads with its most central pair.
    expect(planShelves(liked, () => 1)[0].tags).toEqual(["Revenge", "Action"]);
  });

  it("makes a series with primary tags vote only for pairs of them, however common its other tags are", async () => {
    const { planShelves } = await import("./discover.js");
    const prim = new Set(["big breasts", "harem", "tall female lead"]);
    const liked = [
      { mangaId: 1, title: "Someone Stop Her", tags: ["Romance", "Drama", "Big Breasts", "Harem", "Tall Female Lead"], weight: 4, primary: ["Big Breasts", "Harem", "Tall Female Lead"], importance: (t: string) => (prim.has(t.toLowerCase()) ? 3 : 1) },
      // Lots of other series pile weight onto Romance and Drama.
      ...[2, 3, 4, 5].map((id) => ({ mangaId: id, title: `Other ${id}`, tags: ["Romance", "Drama"], weight: 3 })),
    ];
    const plan = planShelves(liked, () => 1);
    const mine = plan.filter((p) => p.from === "Someone Stop Her");
    expect(mine.length).toBeGreaterThan(0);
    for (const p of mine) expect(p.tags.every((t) => prim.has(t.toLowerCase()))).toBe(true);
  });
});

describe("candidate tag importance", () => {
  it("ranks a candidate whose matching tags are central to it above one where they're incidental", async () => {
    const { recommendShelves, centralSum } = await import("./discover.js");
    const hit = (title: string, id: number) => ({ key: title.toLowerCase(), title, hits: [{ mangaId: id, sourceId: "3", sourceName: "Site", title, thumbnailUrl: null }] });
    const tags: Record<number, string[]> = { 1: ["Revenge", "Office", "Cooking"], 2: ["Revenge", "Office", "Cooking"] };
    const out = await recommendShelves(config, [{ mangaId: 9, title: "Mine", tags: ["Revenge", "Office"], weight: 2 }], ["Mine"], {
      knowledge: {
        weight: () => 1,
        tagsOf: (m) => tags[m] ?? null,
        // Both carry the same tags, but for "Side Dish" revenge is incidental and cooking is what it's about.
        importanceOf: (g) => (g.title === "Side Dish" ? (t) => (t === "cooking" ? 2 : 0.6) : (t) => (t === "cooking" ? 0.6 : 2)),
      },
      browse: async () => ({ groups: [hit("Side Dish", 1), hit("Main Course", 2)], failed: [], searched: 1 }),
    });
    expect(out.groups.map((g) => g.title)).toEqual(["Main Course", "Side Dish"]);
    // Knowing importance never inflates a score on its own: all-equal importance gives the plain sum.
    expect(centralSum(["a", "b"], () => 1, () => 2)).toBeCloseTo(2);
    expect(centralSum(["a", "b"], () => 1, null)).toBe(2);
  });
});
