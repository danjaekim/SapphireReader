import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MangaBaka, findOnBaka, parseSeries } from "./mangabaka.js";
import { Store } from "./store.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

const OVERGEARED = {
  id: 685,
  state: "active",
  title: "Overgeared",
  titles: [{ language: "ko", title: "템빨", is_primary: false }],
  type: "manhwa",
  content_rating: "safe",
  rating: 79,
  published: { start_date: "2020-04-01" },
  source: { anilist: { id: 139699 }, my_anime_list: { id: 142425 }, manga_updates: { id: "g9ej9ao" } },
  tags_v2: [
    { tag: { name: "Action", name_path: "Genres > Action", is_genre: true }, weight: "core", is_spoiler: false },
    { tag: { name: "Incidental Thing", name_path: "Themes > Incidental Thing" }, weight: "incidental", is_spoiler: false },
    { tag: { name: "Weak to Strong", name_path: "Narrative Tropes > Character Change > Weak to Strong" }, weight: "defining", is_spoiler: false },
    { tag: { name: "Big Reveal", name_path: "Plot > Big Reveal" }, weight: "core", is_spoiler: true },
  ],
};
const DECOY = { id: 9, title: "Overgeared Too", titles: [], source: { anilist: { id: 1 } } };

/** Fake MangaBaka plus a fake engine with one series ("Overgeared", id 50). */
function world(opts: { searchHits?: unknown[]; calls?: string[]; title?: string } = {}): typeof fetch {
  return (async (u: string, init?: RequestInit) => {
    const url = String(u);
    if (url.startsWith("https://api.mangabaka.org")) {
      opts.calls?.push(url);
      if (url.includes("/v2/series/search")) return new Response(JSON.stringify({ status: 200, data: opts.searchHits ?? [DECOY, OVERGEARED] }));
      const m = /\/v2\/series\/(\d+)/.exec(url);
      if (m && Number(m[1]) === 685) return new Response(JSON.stringify({ status: 200, data: OVERGEARED }));
      if (m && Number(m[1]) === 9) return new Response(JSON.stringify({ status: 200, data: DECOY }));
      return new Response("{}", { status: 404 });
    }
    if (url.includes("graphql.anilist.co")) return new Response(JSON.stringify({ data: {} }));
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (q.includes("sources {")) return json({ sources: { nodes: [{ id: "1", name: "Asura", lang: "en", isNsfw: false }] } });
    if (q.includes("manga(id")) return json({ manga: { id: 50, sourceId: "1", title: opts.title ?? "Overgeared", thumbnailUrl: null, author: null, artist: null, description: null, genre: ["Action"], status: "ONGOING" } });
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
}
const quick = (f: typeof fetch) => new MangaBaka(f, { search: 0, other: 0 });

describe("MangaBaka parsing and matching", () => {
  it("reads tags with weights, paths and spoiler flags, and provider ids", () => {
    const s = parseSeries({ data: OVERGEARED })!;
    expect(s).toMatchObject({ id: 685, title: "Overgeared", year: "2020", contentRating: "safe", anilistId: 139699, muId: "g9ej9ao", titles: ["Overgeared", "템빨"] });
    expect(s.tags.map((t) => [t.name, t.weight, t.spoiler])).toEqual([
      ["Action", "core", false],
      ["Incidental Thing", "incidental", false],
      ["Weak to Strong", "defining", false],
      ["Big Reveal", "core", true],
    ]);
    expect(s.tags[2].path).toBe("Narrative Tropes > Character Change > Weak to Strong");
  });

  it("matches on an exact title and never on a near miss", async () => {
    expect((await findOnBaka(quick(world()), ["Overgeared"], null))?.id).toBe(685);
    expect(await findOnBaka(quick(world({ searchHits: [DECOY] })), ["Overgeared"], null)).toBeNull();
  });

  it("trusts the same AniList entry over the title, and refuses a title match tied to a different AniList entry", async () => {
    expect((await findOnBaka(quick(world({ searchHits: [{ ...OVERGEARED, title: "Overgeared (Remake)", titles: [] }] })), ["Overgeared"], 139699))?.id).toBe(685);
    expect(await findOnBaka(quick(world()), ["Overgeared"], 555)).toBeNull();
  });
});

describe("MangaBaka endpoints", () => {
  it("finds, remembers and serves a series' tags without spoilers, most telling first", async () => {
    const calls: string[] = [];
    const f = world({ calls });
    const app = await buildApp(config, { fetchImpl: f, store: new Store(":memory:"), baka: quick(f) });
    const r = (await app.inject({ method: "GET", url: "/api/manga/50/mangabaka" })).json();
    expect(r.status).toBe("matched");
    expect(r.match).toMatchObject({ id: 685, url: "https://mangabaka.org/685", contentRating: "safe", year: "2020" });
    expect(r.match.tags.map((t: { name: string }) => t.name)).toEqual(["Action", "Weak to Strong", "Incidental Thing"]);
    const before = calls.length;
    await app.inject({ method: "GET", url: "/api/manga/50/mangabaka" });
    expect(calls.length).toBe(before); // remembered
  });

  it("remembers a miss, and lets you pick the entry by hand or say there is none", async () => {
    const f = world({ title: "Something Else" });
    const app = await buildApp(config, { fetchImpl: f, store: new Store(":memory:"), baka: quick(f) });
    expect((await app.inject({ method: "GET", url: "/api/manga/50/mangabaka" })).json()).toEqual({ status: "none", match: null });
    const picked = (await app.inject({ method: "PUT", url: "/api/manga/50/mangabaka", payload: { mbId: 685 } })).json();
    expect(picked.match).toMatchObject({ id: 685, manual: true });
    expect((await app.inject({ method: "GET", url: "/api/manga/50/mangabaka?refresh=1" })).json().match).toMatchObject({ id: 685, manual: true });
    expect((await app.inject({ method: "PUT", url: "/api/manga/50/mangabaka", payload: { mbId: null } })).json()).toEqual({ status: "none-manual", match: null });
    expect((await app.inject({ method: "GET", url: "/api/manga/50/mangabaka?refresh=1" })).json().status).toBe("none-manual");
    // Back to automatic.
    expect((await app.inject({ method: "DELETE", url: "/api/manga/50/mangabaka" })).json().status).toBe("none");
  });

  it("searches by name or by a pasted address", async () => {
    const f = world();
    const app = await buildApp(config, { fetchImpl: f, store: new Store(":memory:"), baka: quick(f) });
    expect((await app.inject({ method: "GET", url: "/api/mangabaka/search?q=overgeared" })).json().hits.map((h: { id: number }) => h.id)).toEqual([9, 685]);
    expect((await app.inject({ method: "GET", url: "/api/mangabaka/search?q=" + encodeURIComponent("https://mangabaka.org/685/") })).json().hits.map((h: { id: number }) => h.id)).toEqual([685]);
  });

  it("falls back to what it knew when MangaBaka can't be reached", async () => {
    let down = false;
    const base = world();
    const f = (async (u: string, init?: RequestInit) => (down && String(u).includes("mangabaka") ? Promise.reject(new Error("offline")) : base(u, init))) as unknown as typeof fetch;
    const app = await buildApp(config, { fetchImpl: f, store: new Store(":memory:"), baka: quick(f) });
    await app.inject({ method: "GET", url: "/api/manga/50/mangabaka" });
    down = true;
    const r = (await app.inject({ method: "GET", url: "/api/manga/50/mangabaka?refresh=1" })).json();
    expect(r.status).toBe("unavailable");
    expect(r.match.id).toBe(685);
  });
});
