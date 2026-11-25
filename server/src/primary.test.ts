import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { clearFilterCache } from "./browse.js";
import { loadConfig } from "./config.js";
import { MangaBaka } from "./mangabaka.js";
import { Store } from "./store.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

/** One source with Action/Fantasy/Comedy genres. Nothing carries both Action and Fantasy; "Naruto" finds a doujin. */
function world(): { f: typeof fetch; browses: number[] } {
  const browses: number[] = [];
  const f = (async (u: string, init?: RequestInit) => {
    const url = String(u);
    const j = (d: unknown) => new Response(JSON.stringify(d));
    if (url.startsWith("https://api.mangabaka.org")) return j({ status: 200, data: [] });
    if (url.includes("anilist")) return j({ data: {} });
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    const json = (data: unknown) => j({ data });
    if (q.includes("sources {")) return json({ sources: { nodes: [{ id: "1", name: "Site", lang: "en", isNsfw: false }] } });
    if (q.includes("source(id")) return json({ source: { filters: [{ __typename: "GroupFilter", name: "Genres", filters: ["Action", "Fantasy", "Comedy"].map((name) => ({ __typename: "CheckBoxFilter", name })) }] } });
    if (q.includes("fetchSourceManga")) {
      const input = body.variables.input;
      if (input.type === "SEARCH" && input.query) {
        return json({ fetchSourceManga: { mangas: /naruto/i.test(input.query) ? [{ id: 80, title: "Naruto Doujin", thumbnailUrl: null }] : [] } });
      }
      const n = (input.filters ?? []).filter((x: { groupChange?: unknown }) => x.groupChange).length;
      browses.push(n);
      if (n >= 2) return json({ fetchSourceManga: { mangas: [] } });
      return json({ fetchSourceManga: { mangas: [{ id: 61, title: "One Tag Match", thumbnailUrl: null }] } });
    }
    if (q.includes("fetchChapters")) return json({ fetchChapters: { chapters: [] } });
    if (q.includes("manga(id")) {
      const id = body.variables.id as number;
      return json({ manga: { id, sourceId: "1", title: id === 50 ? "Story" : `Other ${id}`, thumbnailUrl: null, author: null, artist: null, description: id === 50 ? "A story.\nParodies: Naruto\nGroups: Circle X" : null, genre: ["Action", "Fantasy", "Comedy"], status: "ONGOING" } });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { f, browses };
}

describe("primary tags", () => {
  it("are saved per series and come back with it", async () => {
    clearFilterCache();
    const { f } = world();
    const app = await buildApp(config, { fetchImpl: f, store: new Store(":memory:"), baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const put = await app.inject({ method: "PUT", url: "/api/manga/50/primary-tags", payload: { tags: ["Action", "action", " Naruto "] } });
    expect(put.json().tags).toEqual(["Action", "Naruto"]);
    expect((await app.inject({ url: "/api/manga/50" })).json().primaryTags).toEqual(["Action", "Naruto"]);
    const tooMany = await app.inject({ method: "PUT", url: "/api/manga/50/primary-tags", payload: { tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] } });
    expect(tooMany.statusCode).toBe(400);
  });

  it("Similar matches on them together, and offers smaller sets when nothing has them all", async () => {
    clearFilterCache();
    const { f, browses } = world();
    const app = await buildApp(config, { fetchImpl: f, store: new Store(":memory:"), baka: new MangaBaka(f, { search: 0, other: 0 }) });
    await app.inject({ method: "PUT", url: "/api/manga/50/primary-tags", payload: { tags: ["Action", "Fantasy"] } });
    const out = (await app.inject({ url: "/api/manga/50/similar" })).json();
    expect(browses[0]).toBe(2);
    expect(out.primary.matchedAll).toBe(false);
    expect(out.primary.subsets.map((s: { tags: string[] }) => s.tags)).toEqual([["Fantasy"], ["Action"]]);
    expect(out.groups.map((g: { title: string }) => g.title)).toEqual(["One Tag Match"]);
    expect(out.basedOn).toHaveLength(1);
    // Trying one of the smaller sets.
    const one = (await app.inject({ url: "/api/manga/50/similar?tags=Action" })).json();
    expect(one.primary.matchedAll).toBe(true);
    expect(one.basedOn).toEqual(["Action"]);
  });

  it("Similar adds rows for the same parody and group", async () => {
    clearFilterCache();
    const { f } = world();
    const app = await buildApp(config, { fetchImpl: f, store: new Store(":memory:"), baka: new MangaBaka(f, { search: 0, other: 0 }) });
    const out = (await app.inject({ url: "/api/manga/50/similar" })).json();
    expect(out.primary).toBeUndefined();
    expect(out.facetRows).toEqual([{ label: "Same parody", value: "Naruto", groups: [expect.objectContaining({ title: "Naruto Doujin" })] }]);
  });
});
