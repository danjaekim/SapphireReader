import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { fakeEngine } from "./test-engine.js";
import { groupHits, normalizeTitle, rankByQuery, titleMatch, type SeriesGroup, type SourceHit } from "./search.js";

const hit = (title: string, sourceName: string, mangaId = 1): SourceHit => ({
  mangaId,
  sourceId: sourceName,
  sourceName,
  title,
  thumbnailUrl: null,
});

describe("normalizeTitle", () => {
  it("ignores case, punctuation, accents and spacing", () => {
    expect(normalizeTitle("Solo Leveling!")).toBe("solo leveling");
    expect(normalizeTitle("  solo-leveling ")).toBe("solo leveling");
    expect(normalizeTitle("Café Manga")).toBe("cafe manga");
    expect(normalizeTitle("Tom & Jerry")).toBe("tom and jerry");
  });
});

describe("groupHits", () => {
  it("merges the same series across sources and puts the widest coverage first", () => {
    const groups = groupHits([
      hit("Nano Machine", "Asura", 1),
      hit("Eleceed", "Asura", 2),
      hit("nano machine", "MangaFire", 3),
      hit("NANO MACHINE!", "Mangafreak", 4),
    ]);
    expect(groups.map((g) => g.hits.length)).toEqual([3, 1]);
    expect(groups[0].title).toBe("Nano Machine");
  });

  it("drops hits whose title has nothing searchable in it", () => {
    expect(groupHits([hit("!!!", "Asura")])).toEqual([]);
  });
});

const testConfig = () => loadConfig({ WEB_DIR: "./does-not-exist" });

describe("search api", () => {
  it("searches English and multi-language sources, skips 18+ and other languages, reports failures", async () => {
    const app = await buildApp(testConfig(), { fetchImpl: fakeEngine() });
    const res = await app.inject({ method: "GET", url: "/api/search?q=nano" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.searched).toBe(3);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].hits.map((h: SourceHit) => h.sourceName).sort()).toEqual([
      "Asura Scans",
      "MangaFire",
    ]);
    expect(body.failed).toEqual([{ sourceName: "Broken Site", error: "engine answered 500" }]);
  });

  it("rejects searches that are too short", async () => {
    const app = await buildApp(testConfig(), { fetchImpl: fakeEngine() });
    const res = await app.inject({ method: "GET", url: "/api/search?q=a" });
    expect(res.statusCode).toBe(400);
  });

  it("returns the highest chapter number and ignores unnumbered chapters", async () => {
    const app = await buildApp(testConfig(), { fetchImpl: fakeEngine() });
    const res = await app.inject({ method: "GET", url: "/api/manga/10/latest" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ chapterCount: 3, latestNumber: 236.5 });
  });

  it("returns series details with chapters in reading order, oldest first", async () => {
    const app = await buildApp(testConfig(), { fetchImpl: fakeEngine() });
    const res = await app.inject({ method: "GET", url: "/api/manga/10" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.manga).toMatchObject({ title: "Nano Machine", sourceName: "Asura Scans", genre: ["Action", "Murim"] });
    // One chapter is unnumbered, so order falls back to upload date: unknown date first, then oldest to newest.
    expect(body.chapters.map((c: { id: number }) => c.id)).toEqual([500, 501, 502]);
    expect(body.latest.latestNumber).toBe(236.5);
  });

  it("lists a chapter's pages as Sapphire addresses", async () => {
    const app = await buildApp(testConfig(), { fetchImpl: fakeEngine() });
    const res = await app.inject({ method: "GET", url: "/api/chapters/501/pages" });
    expect(res.statusCode).toBe(200);
    expect(res.json().pages).toEqual(["/api/read/10/2/0", "/api/read/10/2/1"]);
  });

  it("refuses page addresses that don't look like the engine's own", async () => {
    const app = await buildApp(testConfig(), { fetchImpl: fakeEngine() });
    const res = await app.inject({ method: "GET", url: "/api/chapters/999/pages" });
    expect(res.statusCode).toBe(502);
  });

  it("proxies a page image and rejects odd addresses", async () => {
    const app = await buildApp(testConfig(), { fetchImpl: fakeEngine() });
    const ok = await app.inject({ method: "GET", url: "/api/read/10/2/0" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/webp");
    const bad = await app.inject({ method: "GET", url: "/api/read/10/2/..%2F..%2Fsecret" });
    expect(bad.statusCode).toBe(400);
  });

  it("serves covers through Sapphire", async () => {
    const app = await buildApp(testConfig(), { fetchImpl: fakeEngine() });
    const res = await app.inject({ method: "GET", url: "/api/manga/10/thumbnail" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });
});

describe("rankByQuery", () => {
  const g = (title: string, sources = 1): SeriesGroup => ({ key: title.toLowerCase(), title, hits: Array.from({ length: sources }, (_, i) => ({ mangaId: i, sourceId: String(i), sourceName: `S${i}`, title, thumbnailUrl: null })) });
  it("puts titles that match the words first", () => {
    const groups = [
      g("The Mysterious World's Greatest Martial Artist Little Disciple", 2),
      g("The Twin Swords Of The Sima Clan"),
      g("The Great Villain of Gods and Demons: I Set Up the Divine Hall"),
      g("Set Up (Kim Mundo)"),
      g("Sonna Kaoshite Sasotteru?"),
    ];
    expect(rankByQuery(groups, "set up").map((x) => x.title).slice(0, 2)).toEqual(["Set Up (Kim Mundo)", "The Great Villain of Gods and Demons: I Set Up the Divine Hall"]);
  });
  it("scores exact, prefix, phrase and word matches", () => {
    expect(titleMatch("Set Up!", "set up")).toBe(100);
    expect(titleMatch("Set Up (Kim Mundo)", "set up")).toBe(80);
    expect(titleMatch("I Set Up a Shop", "set up")).toBe(60);
    expect(titleMatch("Up and Set", "set up")).toBe(40);
    expect(titleMatch("Sets of Swords", "set up")).toBe(0);
  });
  it("keeps more sources first among equal matches", () => {
    expect(rankByQuery([g("Alpha Set Up"), g("Beta Set Up", 3)], "set up").map((x) => x.title)).toEqual(["Beta Set Up", "Alpha Set Up"]);
  });
});
