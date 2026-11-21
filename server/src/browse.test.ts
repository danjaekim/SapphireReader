import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { browseByGenres, clearFilterCache, planGenreFilters, type EngineFilter } from "./browse.js";
import { loadConfig } from "./config.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

// Each test sets up its own fake sources, so filters cached by an earlier test must not leak in.
beforeEach(() => clearFilterCache());

const groupSource: EngineFilter[] = [
  { __typename: "TextFilter" },
  {
    __typename: "GroupFilter",
    name: "Genres",
    filters: [
      { __typename: "TriStateFilter", name: "Action" },
      { __typename: "TriStateFilter", name: "Martial Arts" },
      { __typename: "TriStateFilter", name: "Romance" },
    ],
  },
];
const selectSource: EngineFilter[] = [{ __typename: "SelectFilter", name: "Genre", values: ["All", "Action", "Romance"] }];

describe("genre filters", () => {
  it("turns several genres into one change per genre inside the genre group", () => {
    expect(planGenreFilters(groupSource, ["action", "martial arts"])).toEqual({
      changes: [
        { position: 1, groupChange: { position: 0, triState: "INCLUDE" } },
        { position: 1, groupChange: { position: 1, triState: "INCLUDE" } },
      ],
      missing: [],
    });
  });

  it("matches genres spelled differently, and asks for AND when the source has an OR/AND switch", () => {
    const withCondition: EngineFilter[] = [
      { __typename: "SelectFilter", name: "Genres condition", values: ["OR", "AND"] },
      { __typename: "GroupFilter", name: "Genres", filters: [
        { __typename: "CheckBoxFilter", name: "Sci-fi" },
        { __typename: "CheckBoxFilter", name: "Martial Art" },
      ] },
    ];
    const plan = planGenreFilters(withCondition, ["Science Fiction", "Martial Arts"])!;
    expect(plan.missing).toEqual([]);
    expect(plan.changes).toEqual([
      { position: 1, groupChange: { position: 0, checkBoxState: true } },
      { position: 1, groupChange: { position: 1, checkBoxState: true } },
      { position: 0, selectState: 1 },
    ]);
  });

  it("filters by what it can and reports the rest, and gives up only when it can filter by none", () => {
    expect(planGenreFilters(groupSource, ["Action", "Isekai"])).toMatchObject({ missing: ["isekai"] });
    expect(planGenreFilters(selectSource, ["Romance"])).toEqual({ changes: [{ position: 0, selectState: 2 }], missing: [] });
    // A single-choice list takes one genre; the other is checked afterwards.
    expect(planGenreFilters(selectSource, ["Action", "Romance"])).toEqual({ changes: [{ position: 0, selectState: 1 }], missing: ["romance"] });
    expect(planGenreFilters([{ __typename: "TextFilter" }], ["Action"])).toBeNull();
  });
});

function engine(sent: unknown[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (q.includes("sources {")) {
      return json({ sources: { nodes: [
        { id: "1", name: "Asura Scans", lang: "en", isNsfw: false },
        { id: "2", name: "Plain Site", lang: "en", isNsfw: false },
      ] } });
    }
    if (q.includes("source(id")) {
      return json({ source: { filters: q.includes('"1"') ? groupSource : [{ __typename: "TextFilter" }] } });
    }
    if (q.includes("fetchSourceManga")) {
      sent.push(body.variables.input);
      return json({ fetchSourceManga: { mangas: [{ id: 10, title: "Nano Machine", thumbnailUrl: null }] } });
    }
    return new Response("?", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("browse", () => {
  it("filters on sources that support the genres and checks the rest by their own genre lists", async () => {
    const sent: unknown[] = [];
    const out = await browseByGenres(config, ["Action", "Romance"], { fetchImpl: engine(sent), query: "nano" });
    expect(out.searched).toBe(2);
    expect(out.skipped).toEqual([]);
    expect(out.groups[0].title).toBe("Nano Machine");
    expect(sent.filter((s) => (s as { type: string; source: string }).type === "SEARCH" && (s as { source: string }).source === "1")).toHaveLength(1);
    const search = sent.find((s) => (s as { type: string }).type === "SEARCH")!;
    expect(search).toMatchObject({ source: "1", type: "SEARCH", query: "nano" });
    expect((search as { filters: unknown[] }).filters).toHaveLength(2);
  });

  it("lists genres and serves the browse route", async () => {
    const app = await buildApp(config, { fetchImpl: engine([]) });
    const genres = await app.inject({ url: "/api/genres" });
    expect(genres.json().genres.map((g: { name: string }) => g.name)).toEqual(["Action", "Martial Arts", "Romance"]);
    const res = await app.inject({ url: "/api/browse?genres=Action,Romance" });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ url: "/api/browse" })).statusCode).toBe(400);
  });
});

describe("extensions api", () => {
  it("lists, installs and uninstalls", async () => {
    const calls: string[] = [];
    const ext = { pkgName: "eu.kanade.tachiyomi.extension.en.asurascans", name: "Tachiyomi: Asura Scans", lang: "en", versionName: "1.6.72", isInstalled: false, hasUpdate: false, isObsolete: false };
    const fake = (async (_u: string, init?: RequestInit) => {
      const q: string = JSON.parse(String(init?.body)).query;
      calls.push(q.trim().split(/[({\s]/)[0] === "mutation" ? (q.match(/\b(\w+)\(input/)?.[1] ?? "") : "list");
      if (q.includes("updateExtension")) return new Response(JSON.stringify({ data: { updateExtension: { extension: { ...ext, isInstalled: true } } } }));
      return new Response(JSON.stringify({ data: { extensions: { nodes: [ext] } } }));
    }) as unknown as typeof fetch;
    const app = await buildApp(config, { fetchImpl: fake });
    expect((await app.inject({ url: "/api/extensions" })).json().extensions).toHaveLength(1);
    const r = await app.inject({ method: "POST", url: `/api/extensions/${ext.pkgName}/install` });
    expect(r.json().extension.isInstalled).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/extensions/bad..pkg;x/install" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/extensions/${ext.pkgName}/delete` })).statusCode).toBe(400);
  });
});

describe("AND across genres", () => {
  it("narrows by the genres a source can filter on, then checks the rest against each series' genres", async () => {
    const sent: { filters?: unknown[] }[] = [];
    const fake = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const q: string = body.query;
      const json = (data: unknown) => new Response(JSON.stringify({ data }));
      if (q.includes("sources {")) return json({ sources: { nodes: [{ id: "1", name: "Half Site", lang: "en", isNsfw: false }] } });
      if (q.includes("source(id")) {
        return json({ source: { filters: [{ __typename: "GroupFilter", name: "Genres", filters: [{ __typename: "CheckBoxFilter", name: "Action" }] }] } });
      }
      if (q.includes("fetchSourceManga")) {
        sent.push(body.variables.input);
        return json({ fetchSourceManga: { mangas: [
          { id: 10, title: "Has Both", thumbnailUrl: null },
          { id: 11, title: "Action Only", thumbnailUrl: null },
        ] } });
      }
      if (q.includes("fetchManga(")) return json({ fetchManga: { manga: { id: 1 } } });
      if (q.includes("manga(id")) {
        const id = body.variables.id;
        return json({ manga: { id, sourceId: "1", title: "x", thumbnailUrl: null, author: null, artist: null, description: null, genre: id === 10 ? ["Action", "Martial Arts"] : ["Action"], status: "ONGOING" } });
      }
      return new Response("?", { status: 500 });
    }) as unknown as typeof fetch;

    const out = await browseByGenres(config, ["Action", "Martial Art"], { fetchImpl: fake });
    expect(out.groups.map((g) => g.title)).toEqual(["Has Both"]);
    expect(sent[0].filters).toHaveLength(1); // only Action was sent to the site
  });
});

describe("tag-style filters", () => {
  it("finds genres under groups and lists named tags, content or themes", () => {
    const filters: EngineFilter[] = [
      { __typename: "GroupFilter", name: "Content", filters: [{ __typename: "TriStateFilter", name: "Glasses" }] },
      { __typename: "SelectFilter", name: "Tag", values: ["Any", "Isekai"] },
      { __typename: "GroupFilter", name: "Status", filters: [{ __typename: "CheckBoxFilter", name: "Ongoing" }] },
    ];
    expect(planGenreFilters(filters, ["glasses"])?.changes).toHaveLength(1);
    expect(planGenreFilters(filters, ["isekai"])?.changes).toHaveLength(1);
    expect(planGenreFilters(filters, ["ongoing"])).toBeNull();
  });
});
