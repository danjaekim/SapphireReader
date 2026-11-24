import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { bakaVector, boostFrom, cosine, tasteVector } from "./bakatags.js";
import { clearFilterCache } from "./browse.js";
import { loadConfig } from "./config.js";
import { MangaBaka } from "./mangabaka.js";
import { normalizeTitle } from "./search.js";
import { Store } from "./store.js";
import type { BakaTag } from "./mangabaka.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });
const tag = (id: number, name: string, path: string, weight: BakaTag["weight"], extra: Partial<BakaTag> = {}): BakaTag => ({ id, name, path, weight, genre: false, spoiler: false, ...extra });

describe("MangaBaka tag math", () => {
  it("weighs tags by how central they are, skips spoilers, and lets related tags meet at their parent", () => {
    const v = bakaVector([
      tag(1, "Body Horror", "Themes > Horror > Body Horror", "core"),
      tag(2, "Action", "Genres > Action", "core", { genre: true }),
      tag(3, "Twist", "Plot > Twist", "core", { spoiler: true }),
    ]);
    expect(v.get("themes>horror>body horror")).toBe(3);
    expect(v.get("themes>horror")).toBeCloseTo(3 * 0.35);
    expect(v.has("themes")).toBe(false); // top-level buckets say nothing
    expect(v.get("genres>action")).toBeCloseTo(0.9);
    expect(v.has("plot>twist")).toBe(false);
    const other = bakaVector([tag(4, "Psychological Horror", "Themes > Horror > Psychological Horror", "core")]);
    expect(cosine(v, other)).toBeGreaterThan(0);
    expect(cosine(v, bakaVector([tag(5, "Cooking", "Activities > Cooking", "core")]))).toBe(0);
  });

  it("adds liked series into one taste, dislikes subtracting", () => {
    const a = bakaVector([tag(1, "Murim", "Settings > Murim", "core")]);
    const b = bakaVector([tag(2, "Office", "Settings > Office", "core")]);
    const t = tasteVector([{ weight: 2, vec: a }, { weight: -0.8, vec: b }]);
    expect(t.get("settings>murim")).toBe(6);
    expect(t.has("settings>office")).toBe(false);
  });

  it("boosts only with data, and a poor fit counts a little against", () => {
    expect(boostFrom(null)).toBe(1);
    expect(boostFrom(0)).toBeLessThan(1);
    expect(boostFrom(1)).toBeGreaterThan(1.5);
  });
});

// Overgeared's MangaBaka record: two central story tags (Crafting, Weak to Strong).
const rec = (id: number, title: string, tags: unknown[], extra: Record<string, unknown> = {}) => ({ id, state: "active", title, content_rating: "safe", source: {}, tags_v2: tags, ...extra });
const t2 = (id: number, name: string, path: string, weight: string) => ({ id, name, name_path: path, weight, is_genre: false, is_spoiler: false });
const CRAFT = t2(5, "Crafting", "Activities > Art Forms > Crafting", "core");
const WEAK = t2(3, "Weak to Strong", "Narrative Tropes > Character Change > Weak to Strong", "defining");
const VR = t2(8, "Virtual Reality", "Settings > Virtual Reality", "core");
const COOK = t2(9, "Cooking", "Activities > Cooking", "core");
const SELF_SAFE = rec(685, "Overgeared", [CRAFT, WEAK, VR]);
const LUCKY = rec(700, "Lucky Striker", [CRAFT, WEAK, VR]);
const STRANGER = rec(701, "Stranger", [COOK]);
const SPICY = rec(702, "Spicy Smith", [CRAFT, WEAK], { content_rating: "erotica" });
// Not on MangaBaka's similar list, only found by carrying Overgeared's tags.
const TAGGED = rec(703, "Forge Master", [CRAFT, VR]);
const ODD = rec(704, "Odd Crafter", [CRAFT, COOK, t2(10, "Gardening", "Activities > Gardening", "core"), t2(11, "Fishing", "Activities > Fishing", "core")]);

function world(selfRating = "safe"): typeof fetch {
  const SELF = { ...SELF_SAFE, content_rating: selfRating };
  return (async (u: string, init?: RequestInit) => {
    const url = String(u);
    const j = (d: unknown) => new Response(JSON.stringify(d));
    if (url.startsWith("https://api.mangabaka.org")) {
      if (url.includes("/series/685/similar")) {
        const item = (series: unknown, score: number) => ({ score, shared_tags: [{ id: 5, name: "Crafting", weight: "core" }, { id: 3, name: "Weak to Strong", weight: "defining" }], shared_tags_total: 2, matched_author: false, matched_related: false, series });
        return j({ status: 200, data: [item(STRANGER, 0.1), item(LUCKY, 0.6), item(SPICY, 0.5)] });
      }
      if (url.includes("/series/search") && url.includes("tag=")) return j({ status: 200, data: [SELF, ODD, TAGGED] });
      if (url.includes("/series/search")) return j({ status: 200, data: [SELF] });
      if (url.includes("/series/685")) return j({ status: 200, data: SELF });
      return new Response("{}", { status: 404 });
    }
    if (url.includes("anilist")) return j({ data: {} });
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    const json = (data: unknown) => j({ data });
    if (q.includes("sources {")) return json({ sources: { nodes: [{ id: "1", name: "Site", lang: "en", isNsfw: false }] } });
    if (q.includes("source(id")) return json({ source: { filters: [{ __typename: "GroupFilter", name: "Genres", filters: ["Action", "Fantasy"].map((name) => ({ __typename: "CheckBoxFilter", name })) }] } });
    if (q.includes("fetchSourceManga")) {
      const input = body.variables.input;
      if (input.type === "SEARCH" && input.query) {
        const hit = /lucky/i.test(input.query)
          ? [{ id: 70, title: "Lucky Striker", thumbnailUrl: null }]
          : /spicy/i.test(input.query)
            ? [{ id: 72, title: "Spicy Smith", thumbnailUrl: null }]
            : /forge/i.test(input.query)
              ? [{ id: 73, title: "Forge Master", thumbnailUrl: null }]
              : /odd/i.test(input.query)
                ? [{ id: 74, title: "Odd Crafter", thumbnailUrl: null }]
                : [];
        return json({ fetchSourceManga: { mangas: hit } });
      }
      return json({ fetchSourceManga: { mangas: [{ id: 61, title: "Far One", thumbnailUrl: null }, { id: 60, title: "Close One", thumbnailUrl: null }] } });
    }
    if (q.includes("manga(id")) {
      const id = body.variables.id as number;
      const title = id === 50 ? "Overgeared" : id === 60 ? "Close One" : id === 61 ? "Far One" : "Other";
      return json({ manga: { id, sourceId: "1", title, thumbnailUrl: null, author: null, artist: null, description: null, genre: ["Action", "Fantasy"], status: "ONGOING" } });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("Similar with MangaBaka", () => {
  it("leads with MangaBaka's own similar series found on your sources, and drops genre matches MangaBaka knows are unrelated", async () => {
    clearFilterCache();
    const store = new Store(":memory:");
    // Two source candidates already known to MangaBaka: one close to Overgeared, one not.
    store.putBakaLink(normalizeTitle("Close One"), 1, false, { id: 1, title: "Close One", titles: [], tags: [{ name: "Crafting", path: "Activities > Art Forms > Crafting", weight: "core", genre: false, spoiler: false }] });
    store.putBakaLink(normalizeTitle("Far One"), 2, false, { id: 2, title: "Far One", titles: [], tags: [{ name: "Cooking", path: "Activities > Cooking", weight: "core", genre: false, spoiler: false }] });
    const f = world();
    const app = await buildApp(config, { fetchImpl: f, store, baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const out = (await app.inject({ url: "/api/manga/50/similar" })).json();
    const titles = out.groups.map((g: { title: string }) => g.title);
    expect(titles[0]).toBe("Lucky Striker");
    expect(titles).toContain("Close One");
    expect(titles).not.toContain("Far One");
    // Not on your sources, or explicit for a series that isn't 18+.
    expect(titles).not.toContain("Stranger");
    expect(titles).not.toContain("Spicy Smith");
    expect(titles).not.toContain("Overgeared");
    expect(out.basedOn[0]).toBe("Crafting");
    expect(out.basedOn).toHaveLength(3);
    // What MangaBaka returned is remembered for later.
    expect(store.bakaLink(normalizeTitle("Lucky Striker"))?.mbId).toBe(700);
  });

  it("without MangaBaka picks, ranks genre matches by MangaBaka closeness instead of dropping them", async () => {
    clearFilterCache();
    const store = new Store(":memory:");
    store.putBakaLink(normalizeTitle("Close One"), 1, false, { id: 1, title: "Close One", titles: [], tags: [{ name: "Crafting", path: "Activities > Art Forms > Crafting", weight: "core", genre: false, spoiler: false }] });
    store.putBakaLink(normalizeTitle("Far One"), 2, false, { id: 2, title: "Far One", titles: [], tags: [{ name: "Cooking", path: "Activities > Cooking", weight: "core", genre: false, spoiler: false }] });
    const base = world();
    const f = (async (u: string, init?: RequestInit) => (String(u).includes("/similar") || String(u).includes("tag=") ? new Response(JSON.stringify({ status: 200, data: [] })) : base(u, init))) as unknown as typeof fetch;
    const app = await buildApp(config, { fetchImpl: f, store, baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const titles = (await app.inject({ url: "/api/manga/50/similar" })).json().groups.map((g: { title: string }) => g.title);
    expect(titles.indexOf("Close One")).toBeGreaterThanOrEqual(0);
    expect(titles.indexOf("Close One")).toBeLessThan(titles.indexOf("Far One"));
  });
});

describe("Similar by MangaBaka tags", () => {
  it("also finds series carrying this one's most telling tags, ranked by how closely all their tags match", async () => {
    clearFilterCache();
    const store = new Store(":memory:");
    const calls: string[] = [];
    const base = world();
    const f = (async (u: string, init?: RequestInit) => {
      if (String(u).includes("tag=")) calls.push(String(u));
      return base(u, init);
    }) as unknown as typeof fetch;
    const app = await buildApp(config, { fetchImpl: f, store, baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const titles = (await app.inject({ url: "/api/manga/50/similar" })).json().groups.map((g: { title: string }) => g.title);
    // Lucky Striker shares everything; Forge Master most; Odd Crafter only one tag among unrelated ones.
    expect(titles.indexOf("Forge Master")).toBeGreaterThan(titles.indexOf("Lucky Striker"));
    expect(titles.indexOf("Forge Master")).toBeLessThan(titles.indexOf("Odd Crafter") === -1 ? Infinity : titles.indexOf("Odd Crafter"));
    // One search per telling tag (core first, no genres), remembered afterwards.
    expect(calls.length).toBe(3);
    await app.inject({ url: "/api/manga/50/similar?x=1" });
    expect(calls.length).toBe(3);
  });
});

describe("Similar for explicit series", () => {
  it("skips broad tags, searches tags within the series' own rating, and explains itself with ?debug=1", async () => {
    clearFilterCache();
    const store = new Store(":memory:");
    const calls: string[] = [];
    const SEINEN = { ...t2(20, "Seinen", "Demographic > Seinen", "core") };
    const LEAD = t2(21, "Male Lead", "Cast > Male Lead", "core");
    const base = world("pornographic");
    const f = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.includes("tag=")) calls.push(url);
      if (url.includes("/series/685") && !url.includes("similar")) return new Response(JSON.stringify({ status: 200, data: { ...SELF_SAFE, content_rating: "pornographic", tags_v2: [SEINEN, LEAD, CRAFT, WEAK, VR] } }));
      if (url.includes("/series/search") && !url.includes("tag=")) return new Response(JSON.stringify({ status: 200, data: [{ ...SELF_SAFE, content_rating: "pornographic", tags_v2: [SEINEN, LEAD, CRAFT, WEAK, VR] }] }));
      if (url.includes("tag=")) return new Response(JSON.stringify({ status: 200, data: [{ ...TAGGED, content_rating: "pornographic" }] }));
      return base(u, init);
    }) as unknown as typeof fetch;
    const app = await buildApp(config, { fetchImpl: f, store, baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const out = (await app.inject({ url: "/api/manga/50/similar?debug=1" })).json();
    expect(calls.some((c) => c.includes("tag=20") || c.includes("tag=21"))).toBe(false);
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.includes("content_rating=pornographic"))).toBe(true);
    expect(out.groups.map((g: { title: string }) => g.title)).toContain("Forge Master");
    expect(out.basedOn).not.toContain("Seinen");
    expect(out.debug.explicit).toBe(true);
    expect(out.debug.baka.telling).toEqual(["Crafting", "Virtual Reality", "Weak to Strong"]);
    expect(out.debug.baka.found).toBeGreaterThan(0);
  });
});

describe("Similar keeps to the same content rating", () => {
  it("an explicit series only suggests explicit ones; series of unknown rating are left out", async () => {
    clearFilterCache();
    const store = new Store(":memory:");
    store.putBakaLink(normalizeTitle("Close One"), 1, false, { id: 1, title: "Close One", titles: [], tags: [{ name: "Crafting", path: "Activities > Art Forms > Crafting", weight: "core", genre: false, spoiler: false }] });
    const f = world("pornographic");
    const app = await buildApp(config, { fetchImpl: f, store, baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const titles = (await app.inject({ url: "/api/manga/50/similar" })).json().groups.map((g: { title: string }) => g.title);
    expect(titles).toEqual(["Spicy Smith"]);
  });

  it("a series tagged Adult or Hentai on its source counts as explicit when MangaBaka doesn't know it", async () => {
    clearFilterCache();
    const store = new Store(":memory:");
    store.recordSeriesTags(61, ["Action", "Hentai"]);
    const f = world("pornographic");
    const app = await buildApp(config, { fetchImpl: f, store, baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const titles = (await app.inject({ url: "/api/manga/50/similar" })).json().groups.map((g: { title: string }) => g.title);
    expect(titles).toContain("Far One");
    expect(titles).not.toContain("Close One");
  });
});

describe("For you with MangaBaka", () => {
  it("moves candidates whose MangaBaka tags fit your library up", async () => {
    clearFilterCache();
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 50, sourceId: "1", sourceName: "Site", title: "Overgeared" });
    store.setGenres(50, ["Action", "Fantasy"]);
    store.saveProgress(50, { chapterId: 1, chapterNumber: 1, chapterName: "1", pageIndex: 0, pageOffset: 0 });
    store.putBakaLink(normalizeTitle("Overgeared"), 685, false, { id: 685, title: "Overgeared", titles: [], tags: [{ name: "Crafting", path: "Activities > Art Forms > Crafting", weight: "core", genre: false, spoiler: false }] });
    store.putBakaLink(normalizeTitle("Close One"), 1, false, { id: 1, title: "Close One", titles: [], tags: [{ name: "Crafting", path: "Activities > Art Forms > Crafting", weight: "core", genre: false, spoiler: false }] });
    store.putBakaLink(normalizeTitle("Far One"), 2, false, { id: 2, title: "Far One", titles: [], tags: [{ name: "Cooking", path: "Activities > Cooking", weight: "core", genre: false, spoiler: false }] });
    const f = world();
    const app = await buildApp(config, { fetchImpl: f, store, baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const out = (await app.inject({ url: "/api/for-you" })).json();
    const titles = out.groups.map((g: { title: string }) => g.title);
    expect(titles.indexOf("Close One")).toBeGreaterThanOrEqual(0);
    expect(titles.indexOf("Close One")).toBeLessThan(titles.indexOf("Far One"));
  });
});
