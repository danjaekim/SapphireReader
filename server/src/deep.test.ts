import { describe, expect, it } from "vitest";
import { deepRecommendations, findThemes, tasteFit } from "./deep.js";
import { tasteWeights } from "./discover.js";
import { normalizeTitle, type SeriesGroup } from "./search.js";

/** Common tags count for little, rare ones for more. */
const COMMON = new Set(["romance", "drama", "comedy", "action", "fantasy"]);
const weight = (t: string) => (COMMON.has(t.toLowerCase()) ? 0.3 : 1.5);

/** Many-tag series, the way 18+ sites list them: lots of noise, a few tags they really share. */
const noise = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed} tag ${i}`);
const liked = [
  { mangaId: 1, title: "A", weight: 3, tags: ["Romance", "Drama", "Office", "Revenge", "Webtoon", ...noise(30, "a")] },
  { mangaId: 2, title: "B", weight: 2, tags: ["Romance", "Comedy", "Office", "Revenge", ...noise(30, "b")] },
  { mangaId: 3, title: "C", weight: 1, tags: ["Romance", "Office", "Revenge", "Drama", ...noise(30, "c")] },
  { mangaId: 4, title: "D", weight: 2, tags: ["Action", "Murim", "Regression", ...noise(30, "d")] },
  { mangaId: 5, title: "E", weight: 1, tags: ["Action", "Murim", "Regression", "Fantasy", ...noise(30, "e")] },
];

const group = (id: number, title: string): SeriesGroup => ({ key: normalizeTitle(title), title, hits: [{ mangaId: id, title } as SeriesGroup["hits"][number]] });

describe("findThemes", () => {
  it("finds the combinations several of your series share, not the noise or the common tags", () => {
    const themes = findThemes(liked, weight);
    const keys = themes.map((t) => t.tags.map((x) => x.toLowerCase()).sort().join("+"));
    // All three office series are also romance, so that theme grows to three tags.
    expect(keys).toContain("office+revenge+romance");
    expect(keys.some((k) => k.includes("murim") && k.includes("regression"))).toBe(true);
    const office = themes.find((t) => t.tags.includes("Office"))!;
    expect(office.support).toBe(3);
    expect(office.examples[0]).toBe("A");
    // No theme is made of tags only one series has.
    expect(themes.every((t) => t.tags.every((x) => !/tag \d/.test(x)))).toBe(true);
  });

  it("leaves out hidden tags and needs at least two series", () => {
    expect(findThemes(liked, weight, new Set(["revenge"])).some((t) => t.tags.includes("Revenge"))).toBe(false);
    expect(findThemes(liked.slice(0, 1), weight)).toEqual([]);
  });
});

describe("tasteFit", () => {
  const taste = tasteWeights(liked, weight);
  it("doesn't reward a series just for having many tags", () => {
    const focused = tasteFit(["Office", "Revenge", "Romance"], taste, weight, new Set())!;
    const sprawling = tasteFit(["Office", ...noise(60, "z")], taste, weight, new Set())!;
    expect(focused).toBeGreaterThan(sprawling);
  });
  it("is null for a series with a hidden tag", () => {
    expect(tasteFit(["Office", "Gore"], taste, weight, new Set(["gore"]))).toBeNull();
  });
});

describe("deepRecommendations", () => {
  it("ranks a wide pool by full tag lists and makes a row per theme", async () => {
    const tags: Record<number, string[]> = {
      101: ["Office", "Revenge", "Romance", "Drama"],
      102: ["Office", "Romance", ...noise(50, "x")],
      103: ["Murim", "Regression", "Action"],
      104: ["Revenge", "Office"],
      105: ["Isekai"],
      106: ["Office", "Revenge", "Gore"],
    };
    const fetched: number[] = [];
    const rows = await deepRecommendations(liked, ["A"], {
      weight,
      tagsOf: (id) => (id === 101 ? tags[101] : null),
      fetchTags: async (id) => {
        fetched.push(id);
        return tags[id] ?? [];
      },
      browse: async () => ({ groups: [101, 102, 103, 104, 105, 106, 1].map((id) => group(id, id === 1 ? "A" : `S${id}`)), failed: [], searched: 1 }),
      hidden: new Set(["gore"]),
    });
    const best = rows.find((r) => r.kind === "best")!;
    const ids = best.groups.map((g) => g.hits[0].mangaId);
    expect(ids[0]).toBe(101);
    expect(ids).not.toContain(106); // hidden tag
    expect(ids).not.toContain(105); // nothing in common
    expect(ids).not.toContain(1); // already yours
    expect(fetched).not.toContain(101); // tags already known
    // Theme rows never repeat each other (they may borrow from Best matches when short).
    const inThemes = rows.filter((r) => r.kind === "theme").flatMap((r) => r.groups.map((g) => g.key));
    expect(new Set(inThemes).size).toBe(inThemes.length);
  });

  it("returns nothing without any taste to go on", async () => {
    const rows = await deepRecommendations([], [], { weight, tagsOf: () => null, fetchTags: async () => [], browse: async () => null });
    expect(rows).toEqual([]);
  });
});
