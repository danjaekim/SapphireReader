import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { groupHits, normalizeTitle, type SourceHit } from "./search.js";

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

/** A fake engine: answers the GraphQL calls Sapphire makes. */
function fakeEngine(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/thumbnail")) {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (q.includes("sources")) {
      return json({
        sources: {
          nodes: [
            { id: "1", name: "Asura Scans", lang: "en", isNsfw: false },
            { id: "2", name: "MangaFire", lang: "all", isNsfw: false },
            { id: "3", name: "ToonGod", lang: "en", isNsfw: true },
            { id: "4", name: "Japanese Site", lang: "ja", isNsfw: false },
            { id: "5", name: "Broken Site", lang: "en", isNsfw: false },
          ],
        },
      });
    }
    if (q.includes("fetchSourceManga")) {
      const source = body.variables.input.source;
      if (source === "5") return new Response("nope", { status: 500 });
      return json({
        fetchSourceManga: {
          mangas: [{ id: Number(source) * 10, title: "Nano Machine", thumbnailUrl: "/x" }],
        },
      });
    }
    if (q.includes("fetchChapters")) {
      return json({
        fetchChapters: {
          chapters: [
            { chapterNumber: 3, uploadDate: "1700000000000" },
            { chapterNumber: 236.5, uploadDate: "1795000000000" },
            { chapterNumber: -1, uploadDate: "0" },
          ],
        },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

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

  it("serves covers through Sapphire", async () => {
    const app = await buildApp(testConfig(), { fetchImpl: fakeEngine() });
    const res = await app.inject({ method: "GET", url: "/api/manga/10/thumbnail" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
  });
});
