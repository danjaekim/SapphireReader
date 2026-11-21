import { describe, expect, it } from "vitest";
import { sortChange, type EngineFilter } from "./browse.js";
import { tagWeights } from "./discover.js";
import { canonKey } from "./genres.js";

describe("sort", () => {
  const madara: EngineFilter[] = [
    { __typename: "TextFilter", name: "Author" },
    { __typename: "SelectFilter", name: "Order By", values: ["Relevance", "Latest", "A-Z", "Rating", "Trending", "Most Views", "New"] },
  ];
  it("maps each order to the site's own wording", () => {
    expect(sortChange(madara, "latest")).toEqual({ position: 1, selectState: 1 });
    expect(sortChange(madara, "az")).toEqual({ position: 1, selectState: 2 });
    expect(sortChange(madara, "rating")).toEqual({ position: 1, selectState: 3 });
    expect(sortChange(madara, "popular")).toEqual({ position: 1, selectState: 4 });
    expect(sortChange(madara, "newest")).toEqual({ position: 1, selectState: 6 });
    expect(sortChange(madara, "relevance")).toBeNull();
  });

  it("uses SortFilter with a direction, and says when a site can't sort that way", () => {
    const f: EngineFilter[] = [{ __typename: "SortFilter", name: "Sort", values: ["Popular", "Title"] }];
    expect(sortChange(f, "popular")).toEqual({ position: 0, sortState: { index: 0, ascending: false } });
    expect(sortChange(f, "az")).toEqual({ position: 0, sortState: { index: 1, ascending: true } });
    expect(sortChange(f, "rating")).toBeNull();
    expect(sortChange([{ __typename: "SelectFilter", name: "Genre", values: ["All", "Top"] }], "rating")).toBeNull();
  });
});

describe("tag weights", () => {
  it("rates rare tags above ones nearly everything has", () => {
    const counts = new Map(([["sole female", 90], ["glasses", 8], ["big breasts", 70]] as const).map(([k, v]) => [canonKey(k), v]));
    const w = tagWeights({ total: 100, counts });
    expect(w("glasses")).toBeGreaterThan(w("Big Breasts"));
    expect(w("big breasts")).toBeGreaterThan(w("sole female"));
    expect(w("never seen")).toBeGreaterThan(w("glasses"));
  });

  it("uses a built-in common-tag list until it has seen enough series", () => {
    const w = tagWeights({ total: 3, counts: new Map() });
    expect(w("Action")).toBeLessThan(w("Glasses"));
  });
});
