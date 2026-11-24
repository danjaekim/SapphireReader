import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { fakeEngine } from "./test-engine.js";

const testConfig = () => loadConfig({ WEB_DIR: "./does-not-exist" });

/** The fake engine, with a saved copy of series 10 and a count of trips to the source site. */
function engineWithSaved(opts: { initialized: boolean; slowSource?: boolean }) {
  const base = fakeEngine();
  const trips: string[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const q = init?.body ? String(JSON.parse(String(init.body)).query) : "";
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (q.includes("initialized")) {
      return json({ manga: { id: 10, sourceId: "1", title: "Nano Machine", thumbnailUrl: null, author: "Saved Author", artist: null, description: "Saved.", genre: ["Action"], status: "ONGOING", initialized: opts.initialized } });
    }
    if (q.includes("chapters(condition")) {
      return json({ chapters: { nodes: [{ id: 501, name: "Chapter 3", chapterNumber: 3, uploadDate: "1700000000000", scanlator: null }] } });
    }
    if (q.includes("fetchChapters") || q.includes("fetchManga(")) {
      trips.push(q.includes("fetchChapters") ? "chapters" : "details");
      if (opts.slowSource) await new Promise((r) => setTimeout(r, 300));
    }
    return base(url, init);
  }) as unknown as typeof fetch;
  return { f, trips };
}

describe("series page: saved copy first", () => {
  it("answers from what the engine saved, without asking the source site", async () => {
    const { f, trips } = engineWithSaved({ initialized: true, slowSource: true });
    const app = await buildApp(testConfig(), { fetchImpl: f });
    const t0 = Date.now();
    const res = await app.inject({ url: "/api/manga/10/saved" });
    expect(Date.now() - t0).toBeLessThan(250);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.saved).toBe(true);
    expect(body.manga.author).toBe("Saved Author");
    expect(body.chapters.map((c: { id: number }) => c.id)).toEqual([501]);
    expect(trips).toEqual([]);
  });

  it("the live answer uses saved details at once, refreshes them behind, and lists chapters fresh from the source", async () => {
    const { f, trips } = engineWithSaved({ initialized: true });
    const app = await buildApp(testConfig(), { fetchImpl: f });
    const body = (await app.inject({ url: "/api/manga/10" })).json();
    expect(body.saved).toBeUndefined();
    expect(body.manga.author).toBe("Saved Author");
    expect(body.chapters.map((c: { id: number }) => c.id)).toEqual([500, 501, 502]);
    expect(trips).toContain("chapters");
    expect(trips).toContain("details");
  });

  it("a series never filled in waits for the source's details", async () => {
    const { f } = engineWithSaved({ initialized: false });
    const app = await buildApp(testConfig(), { fetchImpl: f });
    const body = (await app.inject({ url: "/api/manga/10" })).json();
    expect(body.manga.author).not.toBe("Saved Author");
  });
});
