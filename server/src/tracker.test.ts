import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });
const TOKEN = "a".repeat(40);

function anilistFake(calls: { query: string; variables: Record<string, unknown>; auth: string | null }[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    expect(String(url)).toBe("https://graphql.anilist.co");
    const body = JSON.parse(String(init?.body));
    const auth = (init?.headers as Record<string, string>).authorization ?? null;
    calls.push({ query: body.query, variables: body.variables, auth });
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (body.query.includes("Viewer")) return auth === `Bearer ${TOKEN}` ? json({ Viewer: { name: "dan" } }) : new Response(JSON.stringify({ errors: [{ message: "Invalid token" }] }), { status: 400 });
    if (body.query.includes("Page")) {
      return json({ Page: { media: [{ id: 99, title: { romaji: "Nano Mashin", english: "Nano Machine" }, chapters: null, status: "RELEASING", coverImage: { medium: "http://c" } }] } });
    }
    return json({ SaveMediaListEntry: { id: 1, progress: body.variables.progress } });
  }) as unknown as typeof fetch;
}

const progress = (chapterNumber: number, finished: boolean) => ({
  chapterId: 100 + chapterNumber, chapterNumber, chapterName: `Ch ${chapterNumber}`, pageIndex: 0, pageOffset: 0, finished,
});

describe("AniList tracking", () => {
  it("connects with a token, links a series, and only moves progress forward", async () => {
    const calls: { query: string; variables: Record<string, unknown>; auth: string | null }[] = [];
    const app = await buildApp(config, { fetchImpl: anilistFake(calls), store: new Store(":memory:") });

    expect((await app.inject({ method: "PUT", url: "/api/trackers/anilist", payload: { token: "short" } })).statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: "/api/trackers/anilist", payload: { token: TOKEN } });
    expect(ok.json()).toEqual({ anilist: { connected: true, user: "dan" } });

    const found = (await app.inject({ url: "/api/trackers/anilist/search?q=nano" })).json();
    expect(found.matches[0]).toMatchObject({ mediaId: 99, title: "Nano Machine" });

    await app.inject({ method: "PUT", url: "/api/manga/10/tracking", payload: { mediaId: 99, title: "Nano Machine" } });
    const save = (n: number, finished = true) => app.inject({ method: "PUT", url: "/api/progress/10", payload: progress(n, finished) });
    const updates = () => calls.filter((c) => c.query.includes("SaveMediaListEntry"));

    await save(5, false); // not finished: nothing sent
    await save(5);
    await new Promise((r) => setTimeout(r, 20));
    expect(updates()).toHaveLength(1);
    expect(updates()[0].variables).toEqual({ mediaId: 99, progress: 5 });
    expect(updates()[0].auth).toBe(`Bearer ${TOKEN}`);

    await save(3); // re-reading an old chapter doesn't move AniList backwards
    await save(5.5); // half chapters round down, already synced
    await save(6);
    await new Promise((r) => setTimeout(r, 20));
    expect(updates().map((u) => u.variables.progress)).toEqual([5, 6]);
  });

  it("never touches AniList for an unlinked series, and reading survives a tracker failure", async () => {
    const calls: unknown[] = [];
    const store = new Store(":memory:");
    store.setSetting("anilist_token", TOKEN);
    const app = await buildApp(config, { fetchImpl: (async () => { calls.push(1); throw new Error("offline"); }) as unknown as typeof fetch, store });
    expect((await app.inject({ method: "PUT", url: "/api/progress/10", payload: progress(2, true) })).statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    store.setTrackerLink(10, "anilist", 99, "X");
    expect((await app.inject({ method: "PUT", url: "/api/progress/10", payload: progress(3, true) })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getTrackerLink(10, "anilist")?.syncedProgress).toBe(0);
  });

  it("disconnects", async () => {
    const store = new Store(":memory:");
    store.setSetting("anilist_token", TOKEN);
    const app = await buildApp(config, { store });
    await app.inject({ method: "DELETE", url: "/api/trackers/anilist" });
    expect((await app.inject({ url: "/api/trackers" })).json().anilist.connected).toBe(false);
  });
});
