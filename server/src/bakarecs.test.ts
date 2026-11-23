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
const SELF = rec(685, "Overgeared", [CRAFT, WEAK, VR]);
const LUCKY = rec(700, "Lucky Striker", [CRAFT, WEAK, VR]);
const STRANGER = rec(701, "Stranger", [COOK]);
const SPICY = rec(702, "Spicy Smith", [CRAFT, WEAK], { content_rating: "erotica" });

function world(): typeof fetch {
  return (async (u: string, init?: RequestInit) => {
    const url = String(u);
    const j = (d: unknown) => new Response(JSON.stringify(d));
    if (url.startsWith("https://api.mangabaka.org")) {
      if (url.includes("tag=")) return j({ status: 200, data: [LUCKY, STRANGER, SPICY] });
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
        const hit = /lucky/i.test(input.query) ? [{ id: 70, title: "Lucky Striker", thumbnailUrl: null }] : /spicy/i.test(input.query) ? [{ id: 72, title: "Spicy Smith", thumbnailUrl: null }] : [];
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
  it("ranks closer MangaBaka matches first and adds MangaBaka's own picks found on your sources", async () => {
    clearFilterCache();
    const store = new Store(":memory:");
    // Two source candidates already known to MangaBaka: one close to Overgeared, one not.
    store.putBakaLink(normalizeTitle("Close One"), 1, false, { id: 1, title: "Close One", titles: [], tags: [{ name: "Crafting", path: "Activities > Art Forms > Crafting", weight: "core", genre: false, spoiler: false }] });
    store.putBakaLink(normalizeTitle("Far One"), 2, false, { id: 2, title: "Far One", titles: [], tags: [{ name: "Cooking", path: "Activities > Cooking", weight: "core", genre: false, spoiler: false }] });
    const f = world();
    const app = await buildApp(config, { fetchImpl: f, store, baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const { groups } = (await app.inject({ url: "/api/manga/50/similar" })).json();
    const titles = groups.map((g: { title: string }) => g.title);
    expect(titles.indexOf("Close One")).toBeGreaterThanOrEqual(0);
    expect(titles.indexOf("Close One")).toBeLessThan(titles.indexOf("Far One"));
    expect(titles).toContain("Lucky Striker");
    // Results that don't actually carry the tags, and explicit ones for a series that isn't 18+, stay out.
    expect(titles).not.toContain("Stranger");
    expect(titles).not.toContain("Spicy Smith");
    expect(titles).not.toContain("Overgeared");
    // What the tag search returned is remembered for later.
    expect(store.bakaLink(normalizeTitle("Lucky Striker"))?.mbId).toBe(700);
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
