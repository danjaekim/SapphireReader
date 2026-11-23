import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { pairKey, splitVersion, suggestMerges } from "./mergehints.js";
import { normalizeTitle } from "./search.js";
import { Store } from "./store.js";

describe("version words in names", () => {
  it("takes a version word off a name and turns it into a label", () => {
    expect(splitVersion("Someone Stop Her (Uncensored)")).toEqual({ base: "Someone Stop Her", label: "Uncensored" });
    expect(splitVersion("Someone Stop Her [Raw]")).toEqual({ base: "Someone Stop Her", label: "Raw" });
    expect(splitVersion("Solo Leveling - Colored")).toEqual({ base: "Solo Leveling", label: "Colored" });
    expect(splitVersion("Painter of the Night Uncensored")).toEqual({ base: "Painter of the Night", label: "Uncensored" });
    expect(splitVersion("The Official Handbook")).toEqual({ base: "The Official Handbook", label: null });
    expect(splitVersion("Uncensored")).toEqual({ base: "Uncensored", label: null });
  });
});

describe("suggestMerges", () => {
  const L = (mangaId: number, title: string, sourceName = "Site") => ({ mangaId, title, sourceName, adult: false });
  it("pairs names that differ only by a version word, and listings on the same MangaBaka entry", () => {
    const mb = new Map([[normalizeTitle("Stop Smoking"), 42], [normalizeTitle("Someone Stop Her!"), 42]]);
    const out = suggestMerges(
      [L(1, "Someone Stop Her (Uncensored)"), L(2, "Someone Stop Her"), L(3, "Stop Smoking"), L(4, "Someone Stop Her!"), L(5, "Nano Machine")],
      (k) => mb.get(k) ?? null,
      new Set(),
    );
    expect(out[0].reason).toBe("mangabaka");
    expect([out[0].a.title, out[0].b.title].sort()).toEqual(["Someone Stop Her", "Stop Smoking"]);
    // "Someone Stop Her" and "Someone Stop Her!" are one key already; the versioned name pairs with it.
    expect(out.find((s) => s.reason === "version")).toMatchObject({ a: { title: "Someone Stop Her (Uncensored)", label: "Uncensored" }, b: { title: "Someone Stop Her", label: null } });
    expect(out.some((s) => s.a.title === "Nano Machine" || s.b.title === "Nano Machine")).toBe(false);
  });

  it("leaves out pairs you said are different", () => {
    const listings = [L(1, "X (Uncensored)"), L(2, "X")];
    expect(suggestMerges(listings, () => null, new Set([pairKey(normalizeTitle("X (Uncensored)"), normalizeTitle("X"))]))).toEqual([]);
  });

  it("doesn't pair two plain names just because they're the same", () => {
    expect(suggestMerges([L(1, "Same"), L(2, "Same")], () => null, new Set())).toEqual([]);
  });
});

describe("merge suggestion endpoints", () => {
  const config = loadConfig({ WEB_DIR: "./does-not-exist" });
  const engine = (async () => new Response(JSON.stringify({ data: { sources: { nodes: [] } } }))) as unknown as typeof fetch;
  it("lists suggestions from listings Sapphire has met, and forgets dismissed ones", async () => {
    const store = new Store(":memory:");
    store.recordSeriesMeta(1, "Lookism (Colored)", "Site A", false);
    store.addToLibrary({ mangaId: 2, sourceId: "1", sourceName: "Site B", title: "Lookism" });
    const app = await buildApp(config, { fetchImpl: engine, store });
    const first = (await app.inject({ url: "/api/merge-suggestions" })).json().suggestions;
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ reason: "version", a: { mangaId: 1, label: "Colored" }, b: { mangaId: 2 } });
    await app.inject({ method: "POST", url: "/api/merge-suggestions/dismiss", payload: { key: first[0].key } });
    expect((await app.inject({ url: "/api/merge-suggestions" })).json().suggestions).toEqual([]);
  });

  it("keeps 18+ listings out while 18+ mode is locked", async () => {
    const store = new Store(":memory:");
    store.recordSeriesMeta(1, "Spicy (Uncensored)", "Site A", true);
    store.recordSeriesMeta(2, "Spicy", "Site B", false);
    const app = await buildApp(config, { fetchImpl: engine, store });
    expect((await app.inject({ url: "/api/merge-suggestions" })).json().suggestions).toEqual([]);
  });
});
