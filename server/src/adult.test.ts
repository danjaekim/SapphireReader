import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { checkLibrary } from "./checker.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { fakeEngine } from "./test-engine.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

async function setup() {
  const store = new Store(":memory:");
  const app = await buildApp(config, { fetchImpl: fakeEngine(), store });
  return { app, store };
}

const cookieOf = (res: { headers: Record<string, unknown> }) => String(res.headers["set-cookie"]).split(";")[0];

describe("18+ lock", () => {
  it("sets a PIN, unlocks with it, and locks again", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/api/adult" })).json()).toEqual({ pinSet: false, unlocked: false });
    expect((await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "12" } })).statusCode).toBe(400);

    const set = await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } });
    const cookie = cookieOf(set);
    expect((await app.inject({ url: "/api/adult", headers: { cookie } })).json().unlocked).toBe(true);

    await app.inject({ method: "POST", url: "/api/adult/lock", headers: { cookie } });
    expect((await app.inject({ url: "/api/adult", headers: { cookie } })).json()).toEqual({ pinSet: true, unlocked: false });

    expect((await app.inject({ method: "POST", url: "/api/adult/unlock", payload: { pin: "0000" } })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/adult/unlock", payload: { pin: "4321" } });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers["set-cookie"])).toContain("HttpOnly");
  });

  it("locks out after repeated wrong PINs, and changing the PIN needs the old one", async () => {
    const { app } = await setup();
    await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } });
    for (let i = 0; i < 5; i++) await app.inject({ method: "POST", url: "/api/adult/unlock", payload: { pin: "0000" } });
    expect((await app.inject({ method: "POST", url: "/api/adult/unlock", payload: { pin: "4321" } })).statusCode).toBe(429);
  });

  it("changing the PIN requires the current one", async () => {
    const { app } = await setup();
    await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } });
    expect((await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "9999" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "9999", currentPin: "4321" } })).statusCode).toBe(200);
  });

  it("uses 18+ sources and shows the 18+ library only while unlocked", async () => {
    const { app } = await setup();
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } }));
    const names = (r: { json: () => { groups: { hits: { sourceName: string }[] }[] } }) =>
      r.json().groups.flatMap((g) => g.hits.map((h) => h.sourceName));

    expect(names(await app.inject({ url: "/api/search?q=nano" }))).not.toContain("ToonGod");
    expect(names(await app.inject({ url: "/api/search?q=nano", headers: { cookie } }))).toContain("ToonGod");

    // Adding an 18+ series needs the lock open, and it stays hidden when locked.
    const body = { sourceId: "3", sourceName: "ToonGod", title: "Secret" };
    expect((await app.inject({ method: "PUT", url: "/api/library/30", payload: body })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/library/30", payload: body, headers: { cookie } })).statusCode).toBe(200);
    await app.inject({ method: "PUT", url: "/api/library/10", payload: { sourceId: "1", sourceName: "Asura Scans", title: "Nano Machine" } });
    const titles = async (headers?: { cookie: string }) =>
      (await app.inject({ url: "/api/library", headers })).json().items.map((i: { title: string }) => i.title);
    expect(await titles()).toEqual(["Nano Machine"]);
    expect((await titles({ cookie })).sort()).toEqual(["Nano Machine", "Secret"]);
  });

  it("keeps the 18+ discover page behind the lock and apart from the ordinary one", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/api/discover?adult=1" })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/for-you?adult=1" })).statusCode).toBe(403);
    const cookie = cookieOf(await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } }));
    const adult = await app.inject({ url: "/api/discover?adult=1", headers: { cookie } });
    expect(adult.json().searched).toBe(1); // only the 18+ source
    expect((await app.inject({ url: "/api/discover" , headers: { cookie } })).json().searched).toBe(3);
  });

  it("keeps 18+ titles out of push notifications", async () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "3", sourceName: "ToonGod", title: "Secret Title", adult: true });
    store.setChapterNumbers(1, [1]);
    store.saveProgress(1, { chapterId: 1, chapterNumber: 1, chapterName: "1", pageIndex: 0, pageOffset: 0, finished: true });
    const sent: { title: string; message: string }[] = [];
    await checkLibrary({ config, store, pauseMs: 0, notify: async (n) => void sent.push(n), loadNumbers: async () => [1, 2] });
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("Secret Title");
  });

  it("keeps separate taste profiles", () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "1", sourceName: "A", title: "Plain" });
    store.addToLibrary({ mangaId: 2, sourceId: "3", sourceName: "T", title: "Racy", adult: true });
    store.setGenres(1, ["Action"]);
    store.setGenres(2, ["Romance"]);
    expect(store.tasteProfile(false).map((p) => p.genre)).toEqual(["Action"]);
    expect(store.tasteProfile(true).map((p) => p.genre)).toEqual(["Romance"]);
  });
});

describe("18+ session lifetime", () => {
  it("survives a server restart, and ends after two hours without use", async () => {
    const store = new Store(":memory:");
    const first = await buildApp(config, { fetchImpl: fakeEngine(), store });
    const cookie = cookieOf(await first.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } }));
    // A new server process on the same database (an app update).
    const second = await buildApp(config, { fetchImpl: fakeEngine(), store });
    expect((await second.inject({ url: "/api/adult", headers: { cookie } })).json().unlocked).toBe(true);

    const real = Date.now;
    try {
      Date.now = () => real() + 90 * 60 * 1000;
      // Using it at 90 minutes keeps it open...
      expect((await second.inject({ url: "/api/adult", headers: { cookie } })).json().unlocked).toBe(true);
      Date.now = () => real() + 90 * 60 * 1000 + 100 * 60 * 1000;
      expect((await second.inject({ url: "/api/adult", headers: { cookie } })).json().unlocked).toBe(true);
      // ...but not using it for over two hours does not.
      Date.now = () => real() + 90 * 60 * 1000 + 100 * 60 * 1000 + 121 * 60 * 1000;
      expect((await second.inject({ url: "/api/adult", headers: { cookie } })).json().unlocked).toBe(false);
    } finally {
      Date.now = real;
    }
  });

  it("sets a browser-session cookie, so closing the browser drops it", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } });
    expect(String(res.headers["set-cookie"])).not.toMatch(/Max-Age|Expires/i);
  });
});
