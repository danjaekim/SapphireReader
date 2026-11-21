import { describe, expect, it } from "vitest";
import { checkLibrary } from "./checker.js";
import { loadConfig } from "./config.js";
import { createNotifier, type Notification } from "./notify.js";
import { Store } from "./store.js";

const config = loadConfig({ PUBLIC_URL: "http://nas:8080/", NTFY_URL: "http://ntfy:80", NTFY_USER: "dan", NTFY_PASSWORD: "pw" });

function setup() {
  const store = new Store(":memory:");
  store.addToLibrary({ mangaId: 1, sourceId: "s", sourceName: "A", title: "Caught Up" });
  store.addToLibrary({ mangaId: 2, sourceId: "s", sourceName: "A", title: "Behind" });
  store.addToLibrary({ mangaId: 3, sourceId: "s", sourceName: "A", title: "Never Checked" });
  store.setChapterNumbers(1, [1, 2, 3]);
  store.setChapterNumbers(2, [1, 2, 3]);
  store.saveProgress(1, { chapterId: 1, chapterNumber: 3, chapterName: "3", pageIndex: 0, pageOffset: 0, finished: true });
  store.saveProgress(2, { chapterId: 1, chapterNumber: 1, chapterName: "1", pageIndex: 0, pageOffset: 0, finished: true });
  return store;
}

describe("new chapter alerts", () => {
  it("alerts only for series you were caught up on, once", async () => {
    const store = setup();
    const sent: Notification[] = [];
    const notify = async (n: Notification) => void sent.push(n);
    const numbers: Record<number, number[]> = { 1: [1, 2, 3, 4, 5], 2: [1, 2, 3, 4], 3: [1, 2] };
    const run = () => checkLibrary({ config, store, notify, pauseMs: 0, loadNumbers: async (id) => numbers[id] });

    expect(await run()).toMatchObject({ checked: 3, alerts: 1 });
    expect(sent).toEqual([{ title: "Caught Up", message: "2 new chapters, latest Ch. 5", click: "http://nas:8080/#/series/1" }]);

    await run(); // nothing new the second time
    expect(sent).toHaveLength(1);
  });

  it("keeps going when one source fails and when ntfy is down", async () => {
    const store = setup();
    const result = await checkLibrary({
      config,
      store,
      pauseMs: 0,
      notify: async () => {
        throw new Error("down");
      },
      loadNumbers: async (id) => {
        if (id === 2) throw new Error("source down");
        return [1, 2, 3, 4];
      },
    });
    expect(result.failed).toEqual([2]);
    expect(result.alerts).toBe(0);
    expect(store.library().find((i) => i.mangaId === 1)?.latestNumber).toBe(4);
  });
});

describe("ntfy notifier", () => {
  it("posts JSON with login to the topic, and is off without a URL", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response("{}");
    }) as unknown as typeof fetch;
    await createNotifier(config, fake)!({ title: "Tëst", message: "hi" });
    expect(seen!.url).toBe("http://ntfy:80");
    expect(JSON.parse(String(seen!.init.body))).toMatchObject({ topic: "sapphire", title: "Tëst", message: "hi" });
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("dan:pw").toString("base64")}`);
    expect(createNotifier(loadConfig({}))).toBeNull();
  });
});

describe("updates feed", () => {
  it("records new chapters for every checked series, and flags the ones you were caught up on", async () => {
    const store = setup();
    await checkLibrary({
      config,
      store,
      pauseMs: 0,
      notify: null,
      loadNumbers: async (id) => ({ 1: [1, 2, 3, 4], 2: [1, 2, 3, 4, 5], 3: [1, 2] })[id as 1 | 2 | 3],
    });
    const feed = store.updates();
    expect(feed.map((u) => [u.title, u.caughtUp, u.newCount])).toEqual(expect.arrayContaining([["Caught Up", true, 1], ["Behind", false, 2]]));
    expect(feed.find((u) => u.title === "Never Checked")).toBeUndefined(); // first check is a baseline, not news
    expect(store.updates({ caughtUpOnly: true }).map((u) => u.title)).toEqual(["Caught Up"]);
    expect(store.lastChecked()).toBeTruthy();
  });
});

describe("home and updates api", () => {
  it("shows what to continue and what's new", async () => {
    const { buildApp } = await import("./app.js");
    const store = setup();
    store.setChapterNumbers(2, [1, 2, 3]);
    const app = await buildApp(config, { store });
    await checkLibrary({ config, store, pauseMs: 0, notify: null, loadNumbers: async (id) => (id === 1 ? [1, 2, 3, 4] : id === 2 ? [1, 2, 3, 4] : [1]) });
    const home = (await app.inject({ url: "/api/home" })).json();
    expect(home.continueReading.map((i: { title: string }) => i.title).sort()).toEqual(["Behind", "Caught Up"]); // both now have unread chapters
    expect(home.newChapters.map((u: { title: string }) => u.title)).toEqual(["Caught Up"]);
    expect(home.libraryCount).toBe(3);
    expect((await app.inject({ url: "/api/updates" })).json().items.length).toBe(2);
  });
});
