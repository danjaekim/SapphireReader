import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { clearFilterCache } from "./browse.js";
import { loadConfig } from "./config.js";
import { canonKey, canonLabel } from "./genres.js";

describe("genre names", () => {
  it("treats different spellings of one genre as the same", () => {
    expect(canonKey("Sci-Fi")).toBe(canonKey("Science Fiction"));
    expect(canonKey("Scifi")).toBe(canonKey("sci fi"));
    expect(canonKey("Martial Art")).toBe(canonKey("Martial Arts"));
    expect(canonKey("Slice-of-Life")).toBe(canonKey("Slice of Life"));
    expect(canonKey("Shonen")).toBe(canonKey("Shounen"));
    expect(canonKey("Humor")).toBe(canonKey("Comedy"));
    expect(canonKey("Action")).not.toBe(canonKey("Adventure"));
    expect(canonLabel("Science Fiction")).toBe("Sci-Fi");
    expect(canonLabel("Murim")).toBe("Murim");
  });
});

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

/** A source whose genre list is empty until something has been fetched from it, like many extensions. */
function lazyGenres(log: string[], nsfwGenre = false): typeof fetch {
  let loaded = false;
  return (async (_u: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (q.includes("sources {")) {
      return json({ sources: { nodes: [
        { id: "1", name: "Lazy Site", lang: "en", isNsfw: false },
        { id: "2", name: "Racy Site", lang: "en", isNsfw: true },
      ] } });
    }
    if (q.includes("source(id")) {
      const adultSite = q.includes('"2"');
      const genres = adultSite ? ["Ecchi", "Smut"] : loaded ? ["Science Fiction", "Action"] : [];
      return json({ source: { filters: [{ __typename: "GroupFilter", name: "Genres", filters: genres.map((name) => ({ __typename: "CheckBoxFilter", name })) }] } });
    }
    if (q.includes("fetchSourceManga")) {
      log.push(body.variables.input.type);
      loaded = true;
      return json({ fetchSourceManga: { mangas: [{ id: 1, title: "A", thumbnailUrl: null }] } });
    }
    return new Response("?", { status: 500 });
  }) as unknown as typeof fetch;
}

describe("genre list", () => {
  it("loads a source's lazily-fetched genres by fetching one page first, and merges spellings", async () => {
    clearFilterCache();
    const log: string[] = [];
    const app = await buildApp(config, { fetchImpl: lazyGenres(log) });
    const { genres } = (await app.inject({ url: "/api/genres" })).json();
    expect(log).toContain("POPULAR");
    expect(genres.map((g: { name: string }) => g.name).sort()).toEqual(["Action", "Sci-Fi"]);
  });

  it("shows ordinary genres on Discover and 18+ genres on Discover (18+)", async () => {
    clearFilterCache();
    const app = await buildApp(config, { fetchImpl: lazyGenres([]) });
    const cookie = String((await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } })).headers["set-cookie"]).split(";")[0];
    const names = async (scope: string, headers?: { cookie: string }) =>
      (await app.inject({ url: `/api/genres?scope=${scope}`, headers })).json().genres.map((g: { name: string }) => g.name).sort();
    expect(await names("safe", { cookie })).toEqual(["Action", "Sci-Fi"]);
    expect(await names("adult", { cookie })).toEqual(["Ecchi", "Smut"]);
    // Without the lock open, asking for 18+ genres quietly gives the ordinary ones.
    expect(await names("adult")).toEqual(["Action", "Sci-Fi"]);
  });
});
