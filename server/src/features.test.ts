import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { rankByAnilist } from "./ratings.js";
import { Store } from "./store.js";
import { fakeEngine } from "./test-engine.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

describe("history", () => {
  it("lists series you've read, newest first, including ones not in the library, and hides 18+ unless unlocked", () => {
    const store = new Store(":memory:");
    store.recordSeriesMeta(1, "Solo", "Asura", false);
    store.recordSeriesMeta(2, "Secret", "NH", true);
    store.saveProgress(1, { chapterId: 11, chapterNumber: 3, chapterName: "3", pageIndex: 0, pageOffset: 0 });
    store.saveProgress(2, { chapterId: 21, chapterNumber: 1, chapterName: "1", pageIndex: 0, pageOffset: 0 });
    expect(store.history().map((h) => h.title)).toEqual(["Solo"]);
    expect(store.history(true).map((h) => h.mangaId).sort()).toEqual([1, 2]);
    store.removeHistory(1);
    expect(store.history()).toEqual([]);
  });
});

describe("categories", () => {
  it("creates shelves, files series on them, and cleans up when a shelf or series goes", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store });
    store.addToLibrary({ mangaId: 10, sourceId: "1", sourceName: "Asura", title: "Nano Machine" });
    const { id } = (await app.inject({ method: "POST", url: "/api/categories", payload: { name: "Reading" } })).json();
    expect((await app.inject({ method: "POST", url: "/api/categories", payload: { name: " " } })).statusCode).toBe(400);
    await app.inject({ method: "PUT", url: "/api/library/10/categories", payload: { ids: [id, 999] } });
    expect(store.library()[0].categories).toEqual([id]);
    expect((await app.inject({ url: "/api/categories" })).json().categories).toEqual([{ id, name: "Reading", count: 1 }]);
    await app.inject({ method: "DELETE", url: `/api/categories/${id}` });
    expect(store.library()[0].categories).toEqual([]);
  });
});

describe("switching source", () => {
  it("moves the library entry, read chapters (by number), place and shelves to the other source", () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "a", sourceName: "Slow", title: "Nano" });
    const cat = store.createCategory("Reading");
    store.setSeriesCategories(1, [cat]);
    store.saveProgress(1, { chapterId: 102, chapterNumber: 2, chapterName: "2", pageIndex: 3, pageOffset: 0.5, finished: true });
    store.setChaptersRead(1, [101], true);
    store.switchSource(
      1,
      { mangaId: 2, sourceId: "b", sourceName: "Fast", title: "Nano" },
      { from: [{ id: 101, chapterNumber: 1 }, { id: 102, chapterNumber: 2 }], to: [1, 2, 3].map((n) => ({ id: 200 + n, chapterNumber: n, name: `${n}` })) },
    );
    expect(store.inLibrary(1)).toBe(false);
    const item = store.library()[0];
    expect(item).toMatchObject({ mangaId: 2, sourceName: "Fast", categories: [cat], latestNumber: 3, unread: 1 });
    expect(store.readChapterIds(2).sort()).toEqual([201, 202]);
    expect(store.getProgress(2)).toMatchObject({ chapterId: 202, pageIndex: 3 });
  });
});

describe("switch offers", () => {
  it("asks once, and after a no only asks again when the other source gets even further ahead", () => {
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "a", sourceName: "Slow", title: "Nano" });
    const offer = { mangaId: 1, toMangaId: 2, toSourceId: "b", toSourceName: "Fast", toLatest: 10, fromLatest: 8 };
    expect(store.offerSwitch(offer)).toBe(true);
    expect(store.switchOffers()).toMatchObject([{ title: "Nano", toSourceName: "Fast", toLatest: 10 }]);
    store.dismissSwitchOffer(1);
    expect(store.switchOffers()).toEqual([]);
    expect(store.offerSwitch(offer)).toBe(false);
    expect(store.offerSwitch({ ...offer, toLatest: 11 })).toBe(true);
    expect(store.getSwitchOffer(1)?.toLatest).toBe(11);
  });
});

describe("AniList ranking", () => {
  it("orders by score in one batched request, unknown titles last, and remembers answers", async () => {
    const store = new Store(":memory:");
    let calls = 0;
    const fake = (async (_u: string, init?: RequestInit) => {
      calls++;
      const vars = JSON.parse(String(init?.body)).variables as Record<string, string>;
      const data = Object.fromEntries(
        Object.entries(vars).map(([k, title]) => [`m${k.slice(1)}`, title === "Unknown" ? null : { id: title.length, averageScore: title === "Great" ? 90 : 60, meanScore: null, popularity: 100 }]),
      );
      return new Response(JSON.stringify({ data }));
    }) as unknown as typeof fetch;
    const groups = ["Okay", "Unknown", "Great"].map((t) => ({ key: t.toLowerCase(), title: t, hits: [] }));
    const out = await rankByAnilist(store, groups, "rating", fake);
    expect(out.map((g) => g.title)).toEqual(["Great", "Okay", "Unknown"]);
    expect(out[0].score).toBe(90);
    await rankByAnilist(store, groups, "rating", fake);
    expect(calls).toBe(1);
  });
});

describe("/api/ratings", () => {
  it("returns scores by title and rejects an empty list", async () => {
    const fake = (async (u: string, init?: RequestInit) => {
      if (!String(u).includes("anilist")) return new Response("x", { status: 500 });
      const vars = JSON.parse(String(init?.body)).variables as Record<string, string>;
      const data = Object.fromEntries(Object.keys(vars).map((k) => [`m${k.slice(1)}`, { id: 1, averageScore: 84, meanScore: null, popularity: 5, bannerImage: "https://s4.anilist.co/file/anilistcdn/media/manga/banner/1.jpg" }]));
      return new Response(JSON.stringify({ data }));
    }) as unknown as typeof fetch;
    const app = await buildApp(config, { fetchImpl: fake, store: new Store(":memory:") });
    const res = await app.inject({ method: "POST", url: "/api/ratings", payload: { titles: ["Solo Leveling"] } });
    expect(res.json()).toEqual({ ratings: { "Solo Leveling": { score: 84, popularity: 5, banner: "https://s4.anilist.co/file/anilistcdn/media/manga/banner/1.jpg", mu: null } } });
    expect((await app.inject({ method: "POST", url: "/api/ratings", payload: { titles: [] } })).statusCode).toBe(400);
  });
});

describe("rating fallbacks", () => {
  it("tries other names on AniList, then MangaUpdates (exact title only)", async () => {
    const asked: string[] = [];
    const fake = (async (u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(u).includes("anilist")) {
        const vars = body.variables as Record<string, string>;
        asked.push(...Object.values(vars));
        // AniList only knows "Breakers" by its Korean name.
        const data = Object.fromEntries(Object.entries(vars).map(([k, t]) => [`m${k.slice(1)}`, t === "브레이커즈" ? { id: 9, averageScore: 62, meanScore: null, popularity: 1 } : null]));
        return new Response(JSON.stringify({ data }));
      }
      // MangaUpdates: one near miss, one exact match by another name.
      return new Response(JSON.stringify({ results: [
        { hit_title: "Obscure Tale Returns", record: { series_id: 1, title: "Obscure Tale Returns", bayesian_rating: 9.9 } },
        { hit_title: "Obscure Tale", record: { series_id: 2, title: "Obscure Tale Official", bayesian_rating: "7.40" } },
      ] }));
    }) as unknown as typeof fetch;
    const app = await buildApp(config, { fetchImpl: fake, store: new Store(":memory:") });
    const res = await app.inject({
      method: "POST",
      url: "/api/ratings",
      payload: { titles: ["Breakers", "Obscure Tale", "Nobody Knows This"], alts: { Breakers: ["Beureikeojeu", "브레이커즈"] } },
    });
    const r = res.json().ratings;
    expect(asked[asked.indexOf("Breakers") + 3]).toBe("브레이커즈"); // native name tried first among the others
    expect(r.Breakers.score).toBe(62);
    expect(r["Obscure Tale"]).toMatchObject({ score: null, mu: 7.4 });
    expect(r["Nobody Knows This"]).toMatchObject({ score: null, mu: null });
  });
});

describe("automation settings", () => {
  it("defaults to 3 chapters ahead and auto-switch on, and validates changes", async () => {
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store: new Store(":memory:") });
    expect((await app.inject({ url: "/api/settings/automation" })).json()).toEqual({ autoDownload: 3, autoSwitch: true, autoDelete: true });
    expect((await app.inject({ method: "PUT", url: "/api/settings/automation", payload: { autoDownload: 0 } })).json()).toEqual({ autoDownload: 0, autoSwitch: true, autoDelete: true });
    expect((await app.inject({ method: "PUT", url: "/api/settings/automation", payload: { autoDownload: 50 } })).statusCode).toBe(400);
  });
});

describe("source scoping", () => {
  it("keeps one source per name, preferring English", async () => {
    const { scopedSources } = await import("./search.js");
    const src = (id: string, name: string, lang: string, isNsfw: boolean) => ({ id, name, lang, isNsfw });
    const all = [src("1", "NHentai.xxx", "all", true), src("2", "NHentai.xxx", "en", true), src("3", "Asura", "en", false), src("4", "Other", "fr", true)];
    expect(scopedSources(all, "adult").map((s) => s.id)).toEqual(["2"]);
    expect(scopedSources(all, "safe").map((s) => s.id)).toEqual(["3"]);
  });

  it("lets you re-flag a source by hand without unlocking 18+ mode", async () => {
    const { adultOverrideFor, setAdultOverrides } = await import("./search.js");
    setAdultOverrides({});
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store: new Store(":memory:") });
    const res = await app.inject({ method: "PUT", url: "/api/sources/9/adult", payload: { adult: false } });
    expect(res.statusCode).toBe(200);
    expect(adultOverrideFor("9")).toBe(false);
    setAdultOverrides({});
  });
});

describe("reading mode", () => {
  it("falls back from the series to its source to the default", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store });
    const put = (id: number, payload: object) => app.inject({ method: "PUT", url: `/api/manga/${id}/reader`, payload }).then((r) => r.json());
    expect(await put(10, { mode: "paged", direction: "rtl", scope: "source" })).toMatchObject({ mode: "paged", direction: "rtl", level: "source" });
    expect(await put(10, { mode: "scroll", direction: "ltr" })).toMatchObject({ mode: "scroll", level: "series" });
    // Setting it for the source clears this series' own choice.
    expect(await put(10, { mode: "paged", direction: "ltr", scope: "source" })).toMatchObject({ mode: "paged", direction: "ltr", level: "source" });
    expect(await put(10, { mode: "scroll", direction: "ltr", everywhere: true })).toMatchObject({ mode: "scroll", level: "default" });
  });
});

describe("reading mode per device", () => {
  it("keeps each device's choice apart, over the shared one", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store });
    const put = (device: string | null, payload: object) =>
      app.inject({ method: "PUT", url: "/api/manga/10/reader", payload, headers: device ? { "x-sapphire-device": device } : {} }).then((r) => r.json());
    const get = (device: string | null) =>
      app.inject({ method: "GET", url: "/api/manga/10", headers: device ? { "x-sapphire-device": device } : {} }).then((r) => r.json().reader);
    await put(null, { mode: "paged", direction: "ltr", scope: "all" });
    await put("phone-device-1", { mode: "paged", direction: "rtl", scope: "all" });
    expect(await get("phone-device-1")).toMatchObject({ mode: "paged", direction: "rtl" });
    // The desktop and a device that never chose anything still see the shared default.
    expect(await get("desk-device-1")).toMatchObject({ mode: "paged", direction: "ltr" });
    expect(await get(null)).toMatchObject({ direction: "ltr" });
    // Setting it for a source on one device leaves the others alone.
    await put("desk-device-1", { mode: "scroll", direction: "ltr", scope: "source" });
    expect(await get("desk-device-1")).toMatchObject({ mode: "scroll", level: "source" });
    expect(await get("phone-device-1")).toMatchObject({ direction: "rtl", level: "default" });
  });
});

describe("read state across sources", () => {
  it("carries read chapters to the same series on another source by title and chapter number", () => {
    const store = new Store(":memory:");
    store.recordSeriesMeta(1, "Solo Leveling!", "Asura", false);
    store.recordSeriesMeta(2, "solo leveling", "MangaFire", false);
    store.recordSeriesMeta(3, "Another Series", "MangaFire", false);
    store.saveProgress(1, { chapterId: 101, chapterNumber: 5, chapterName: "Ch 5", pageIndex: 0, pageOffset: 0, finished: true });
    store.recordReadNumbers(1, [6, 7], true);
    const other = [1, 2, 5, 6, 7, 8].map((n) => ({ id: 200 + n, chapterNumber: n, name: `Ch ${n}` }));
    expect(store.applyReadFromOtherSources(2, other).map((c) => c.chapterNumber)).toEqual([5, 6, 7]);
    expect(store.readChapterIds(2).sort()).toEqual([205, 206, 207]);
    // A different series isn't touched, and unreading forgets the number.
    expect(store.applyReadFromOtherSources(3, other)).toEqual([]);
    store.recordReadNumbers(1, [7], false);
    expect(store.applyReadFromOtherSources(2, [{ id: 999, chapterNumber: 7, name: "7" }])).toEqual([]);
  });
});

describe("adult check for mixed sources", () => {
  it("decides from tags, then AniList, then the site, and remembers", async () => {
    const { classifyAdult, tagsAreAdult } = await import("./adultcheck.js");
    expect(tagsAreAdult(["Action", "Smut"])).toBe(true);
    expect(tagsAreAdult(["Action", "Mature", "Ecchi"])).toBe(false);
    const store = new Store(":memory:");
    store.recordSeriesTags(1, ["Hentai"]);
    store.recordSeriesTags(2, ["Action"]);
    let siteCalls = 0;
    // No AniList (offline), so the rest comes from the site.
    const fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const details = async (id: number) => { siteCalls++; return id === 3 ? ["Adult", "Drama"] : id === 4 ? ["Drama"] : []; };
    const items = [1, 2, 3, 4, 5].map((mangaId) => ({ mangaId, title: `Title ${mangaId}` }));
    const out = await classifyAdult(store, items, { fetchImpl, details });
    expect([...out.entries()]).toEqual([[1, true], [2, false], [3, true], [4, false], [5, null]]);
    expect(siteCalls).toBe(3);
    // Answered ones are remembered; only the unknown one is asked about again.
    await classifyAdult(store, items, { fetchImpl, details });
    expect(siteCalls).toBe(4);
  });
});

describe("marking a title 18+", () => {
  it("moves it to the 18+ side everywhere, for every source of it, and can be taken back", async () => {
    const { classifyAdult } = await import("./adultcheck.js");
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "a", sourceName: "Asura", title: "Spicy Title!" });
    store.addToLibrary({ mangaId: 2, sourceId: "b", sourceName: "Other", title: "Plain One" });
    store.recordSeriesMeta(1, "Spicy Title!", "Asura", false);
    store.recordSeriesMeta(9, "spicy title", "MangaFire", false); // the same series on another source
    store.saveProgress(1, { chapterId: 11, chapterNumber: 1, chapterName: "1", pageIndex: 0, pageOffset: 0 });
    store.addUpdate({ mangaId: 1, title: "Spicy Title!", sourceName: "Asura", adult: false, latestNumber: 5, newCount: 1, caughtUp: true });

    store.setAdultMarked("Spicy Title", true);
    expect(store.adultMarked("spicy title!")).toBe(true);
    // Out of the regular lists (and so out of notifications and tab titles), into the 18+ ones.
    expect(store.library().map((i) => i.title)).toEqual(["Plain One"]);
    expect(store.library(true).map((i) => i.title).sort()).toEqual(["Plain One", "Spicy Title!"]);
    expect(store.history().map((h) => h.title)).toEqual([]);
    expect(store.updates()).toEqual([]);
    expect(store.seriesAdult([1, 9])).toEqual(new Map([[1, true], [9, true]]));
    // The adult check agrees without asking anyone.
    const out = await classifyAdult(store, [{ mangaId: 55, title: "Spicy Title" }], { details: async () => [] });
    expect(out.get(55)).toBe(true);

    store.setAdultMarked("Spicy Title", false);
    expect(store.library().map((i) => i.title).sort()).toEqual(["Plain One", "Spicy Title!"]);
    expect(store.seriesAdult([1])).toEqual(new Map());
  });

  it("is refused for series on 18+ sources and needs the 18+ unlock to take back", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store });
    const res = await app.inject({ method: "PUT", url: "/api/manga/1/adult", payload: { on: false } });
    expect(res.statusCode).toBe(403);
  });
});

describe("marking a title not 18+", () => {
  it("brings a series on an 18+ source over to the regular side, and back when cleared", async () => {
    const { classifyAdult } = await import("./adultcheck.js");
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "tg", sourceName: "ToonGod", title: "Safe Romance", adult: true });
    expect(store.library().map((i) => i.title)).toEqual([]);
    store.setAdultMark("Safe Romance", false);
    expect(store.adultMark("safe romance")).toBe(false);
    expect(store.library().map((i) => i.title)).toEqual(["Safe Romance"]);
    expect(store.safeMarkedKeys()).toEqual(new Set(["safe romance"]));
    expect((await classifyAdult(store, [{ mangaId: 1, title: "Safe Romance" }], { details: async () => ["Mature"] })).get(1)).toBe(false);
    // Cleared: back to what its source says.
    store.setAdultMark("Safe Romance", null, (src) => src.id === "tg");
    expect(store.library().map((i) => i.title)).toEqual([]);
  });
});

describe("merging titles", () => {
  it("makes differently named listings group as one series, until unmerged", async () => {
    const { groupHits, normalizeTitle, rawTitleKey, setTitleAliases } = await import("./search.js");
    const store = new Store(":memory:");
    const hits = [
      { mangaId: 1, sourceId: "a", sourceName: "Asura", title: "The Return of the Crazy Demon", thumbnailUrl: null },
      { mangaId: 2, sourceId: "b", sourceName: "Flame", title: "Return of the Mad Demon", thumbnailUrl: null },
    ];
    expect(groupHits(hits)).toHaveLength(2);
    store.mergeTitles(rawTitleKey("Return of the Mad Demon"), "Return of the Mad Demon", normalizeTitle("The Return of the Crazy Demon"), "The Return of the Crazy Demon");
    setTitleAliases(store.titleAliases());
    try {
      const groups = groupHits(hits);
      expect(groups).toHaveLength(1);
      expect(groups[0].hits.map((h) => h.sourceName)).toEqual(["Asura", "Flame"]);
      expect(store.mergedNames(normalizeTitle("The Return of the Crazy Demon")).map((n) => n.title)).toEqual(["Return of the Mad Demon"]);
      // Merging a third name into the alias's group joins the same series.
      store.mergeTitles(rawTitleKey("Crazy Demon Returns"), "Crazy Demon Returns", normalizeTitle("Return of the Mad Demon"), "The Return of the Crazy Demon");
      setTitleAliases(store.titleAliases());
      expect(normalizeTitle("Crazy Demon Returns")).toBe(normalizeTitle("The Return of the Crazy Demon"));
      store.unmergeTitle(rawTitleKey("Return of the Mad Demon"));
      setTitleAliases(store.titleAliases());
      expect(groupHits(hits)).toHaveLength(2);
    } finally {
      setTitleAliases(new Map());
    }
  });
});

describe("a merged series' primary listing", () => {
  it("names and covers the merged series, can be switched, and falls back when its listing is unmerged", async () => {
    const { groupHits, normalizeTitle, rawTitleKey, setTitleAliases, displayTitle, primaryCover } = await import("./search.js");
    const store = new Store(":memory:");
    const canon = rawTitleKey("The Return of the Crazy Demon");
    store.mergeTitles(rawTitleKey("Return of the Mad Demon"), "Return of the Mad Demon", canon, "The Return of the Crazy Demon", { alias: 2, canon: 1 });
    setTitleAliases(store.titleAliases(), store.titlePrimaries());
    try {
      const hits = [
        { mangaId: 2, sourceId: "b", sourceName: "Flame", title: "Return of the Mad Demon", thumbnailUrl: null },
        { mangaId: 1, sourceId: "a", sourceName: "Asura", title: "The Return of the Crazy Demon", thumbnailUrl: null },
      ];
      // The first hit is the merged-in listing, but the card shows the primary's name and cover.
      expect(groupHits(hits)[0]).toMatchObject({ title: "The Return of the Crazy Demon", cover: 1 });
      expect(displayTitle("Return of the Mad Demon")).toBe("The Return of the Crazy Demon");

      store.setPrimary(normalizeTitle("Return of the Mad Demon"), rawTitleKey("Return of the Mad Demon"));
      setTitleAliases(store.titleAliases(), store.titlePrimaries());
      expect(groupHits(hits)[0]).toMatchObject({ title: "Return of the Mad Demon", cover: 2 });
      expect(primaryCover("The Return of the Crazy Demon")).toBe(2);
      // Matching doesn't move: the canonical key stays the same.
      expect(normalizeTitle("Return of the Mad Demon")).toBe(canon);

      store.unmergeTitle(rawTitleKey("Return of the Mad Demon"));
      setTitleAliases(store.titleAliases(), store.titlePrimaries());
      expect(displayTitle("The Return of the Crazy Demon")).toBe("The Return of the Crazy Demon");
      expect(primaryCover("The Return of the Crazy Demon")).toBeNull();
    } finally {
      setTitleAliases(new Map());
    }
  });
});

describe("marking several titles at once", () => {
  it("marks them all; showing titles (not 18+, or clearing) needs 18+ unlocked", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { fetchImpl: fakeEngine(), store });
    const ok = await app.inject({ method: "PUT", url: "/api/adult-marks", payload: { titles: ["One", "Two!"], mark: true } });
    expect(ok.statusCode).toBe(200);
    expect([store.adultMark("one"), store.adultMark("two")]).toEqual([true, true]);
    expect((await app.inject({ method: "PUT", url: "/api/adult-marks", payload: { titles: ["One"], mark: false } })).statusCode).toBe(403);
    expect((await app.inject({ method: "PUT", url: "/api/adult-marks", payload: { titles: [], mark: true } })).statusCode).toBe(400);
  });
});
