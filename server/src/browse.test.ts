import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { browseByGenres, planGenreFilters, type EngineFilter } from "./browse.js";
import { loadConfig } from "./config.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

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
    expect(planGenreFilters(groupSource, ["action", "martial arts"])).toEqual([
      { position: 1, groupChange: { position: 0, triState: "INCLUDE" } },
      { position: 1, groupChange: { position: 1, triState: "INCLUDE" } },
    ]);
  });

  it("skips sources that lack a genre, or can only pick one genre at a time", () => {
    expect(planGenreFilters(groupSource, ["Action", "Isekai"])).toBeNull();
    expect(planGenreFilters(selectSource, ["Romance"])).toEqual([{ position: 0, selectState: 2 }]);
    expect(planGenreFilters(selectSource, ["Action", "Romance"])).toBeNull();
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
  it("searches only sources that support every genre and says which were left out", async () => {
    const sent: unknown[] = [];
    const out = await browseByGenres(config, ["Action", "Romance"], { fetchImpl: engine(sent), query: "nano" });
    expect(out.searched).toBe(1);
    expect(out.skipped).toEqual(["Plain Site"]);
    expect(out.groups[0].title).toBe("Nano Machine");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ source: "1", type: "SEARCH", query: "nano" });
    expect((sent[0] as { filters: unknown[] }).filters).toHaveLength(2);
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
