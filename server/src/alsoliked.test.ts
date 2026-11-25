import { describe, expect, it } from "vitest";
import { alsoLiked } from "./alsoliked.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { fakeEngine } from "./test-engine.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist", ENGINE_URL: "http://engine.test" });

/** AniList knows "Solo Leveling" (id 1); its readers recommend Nano Machine, an adult title, and one no source has. */
function world(log: string[] = []): typeof fetch {
  const engine = fakeEngine();
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (!String(url).includes("anilist")) {
      const body = JSON.parse(String(init?.body));
      if (body.variables?.input?.type === "SEARCH") log.push(body.variables.input.query);
      return engine(url, init);
    }
    const body = JSON.parse(String(init?.body));
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (String(body.query).includes("recommendations")) {
      const node = (id: number, english: string, isAdult = false) => ({ rating: 50, mediaRecommendation: { id, isAdult, synonyms: [], title: { english, romaji: null, native: null } } });
      return json({ m0: { recommendations: { nodes: [node(2, "Nano Machine"), node(3, "Adult Thing", true), node(4, "Nowhere To Be Found")] } } });
    }
    return json({ m0: { id: 1, averageScore: 80, meanScore: 80, popularity: 1, bannerImage: null, isAdult: false } });
  }) as typeof fetch;
}

describe("readers also liked", () => {
  it("finds AniList's recommendations on your sources by exact title, skipping adult ones on the ordinary page", async () => {
    const store = new Store(":memory:");
    const log: string[] = [];
    const rows = await alsoLiked(config, store, [{ mangaId: 99, title: "Solo Leveling", weight: 3 }], { fetchImpl: world(log), scope: "safe", skip: () => false });
    expect(rows).toHaveLength(1);
    expect(rows[0].from).toBe("Solo Leveling");
    expect(rows[0].groups.map((g) => g.title)).toEqual(["Nano Machine"]);
    expect(log).not.toContain("Adult Thing");
    // Matches (and misses) are remembered, so a second run doesn't search again.
    const before = log.length;
    await alsoLiked(config, store, [{ mangaId: 99, title: "Solo Leveling", weight: 3 }], { fetchImpl: world(log), scope: "safe", skip: () => false });
    expect(log.length).toBe(before);
  });

  it("leaves out what the caller says to skip", async () => {
    const rows = await alsoLiked(config, new Store(":memory:"), [{ mangaId: 99, title: "Solo Leveling", weight: 3 }], { fetchImpl: world(), scope: "safe", skip: (g) => g.title === "Nano Machine" });
    expect(rows).toEqual([]);
  });

  it("adds MangaUpdates' reader recommendations, taking turns with AniList's and naming both", async () => {
    const store = new Store(":memory:");
    const log: string[] = [];
    const rows = await alsoLiked(config, store, [{ mangaId: 99, title: "Solo Leveling", weight: 3 }], {
      fetchImpl: world(log),
      scope: "safe",
      skip: () => false,
      updates: async () => [{ id: "mu1", title: "Not Anywhere" }, { id: "mu2", title: "Nano Machine" }],
    });
    // Nano Machine was recommended by both; it shows once.
    expect(rows[0].groups.map((g) => g.title)).toEqual(["Nano Machine"]);
    expect(rows[0].via).toEqual(["AniList"]);
    expect(log).toContain("Not Anywhere");
  });

  it("makes a row from MangaUpdates alone when AniList doesn't know the series", async () => {
    const rows = await alsoLiked(config, new Store(":memory:"), [{ mangaId: 99, title: "Solo Leveling", weight: 3 }], {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
        String(url).includes("anilist") ? new Response(JSON.stringify({ data: { m0: null } })) : fakeEngine()(url, init)) as typeof fetch,
      scope: "adult",
      skip: () => false,
      updates: async () => [{ id: "mu2", title: "Nano Machine" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].via).toEqual(["MangaUpdates"]);
  });
});
