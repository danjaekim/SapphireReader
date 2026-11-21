import { describe, expect, it } from "vitest";
import { parseDescription } from "./description.js";

describe("parseDescription", () => {
  it("splits Asura's stats line, story and alternative titles", () => {
    const d = `Rank: #11 • Rating: 9.76 • Bookmarks: 121.4K "Please send me back to the past." If he cannot kill that person, he goes back. This is his first step to taking his revenge. Alternative Titles: - 花對日歸 - Jeoldae Hoegwi - 절대회귀 - Absolute Return - Absolute Regression`;
    const a = parseDescription(d, "Absolute Regression");
    expect(a.stats).toEqual([
      { label: "Rank", value: "#11" },
      { label: "Rating", value: "9.76" },
      { label: "Bookmarks", value: "121.4K" },
    ]);
    expect(a.body).toBe(`"Please send me back to the past." If he cannot kill that person, he goes back. This is his first step to taking his revenge.`);
    expect(a.altTitles).toEqual(["花對日歸", "Jeoldae Hoegwi", "절대회귀", "Absolute Return"]);
  });

  it("treats a first line of other names as alternative titles", () => {
    const a = parseDescription("The 100th Regression of the Max-Level Player, 만렙 플레이어의 100번째 회귀\nEveryone between 15 and 25 must play.", "The Max-Level Player's 100th Regression");
    expect(a.altTitles).toEqual(["The 100th Regression of the Max-Level Player", "만렙 플레이어의 100번째 회귀"]);
    expect(a.body).toBe("Everyone between 15 and 25 must play.");
  });

  it("leaves an ordinary description alone", () => {
    const d = "A boy wakes up.\nHe fights monsters.";
    expect(parseDescription(d, "X")).toEqual({ body: d, altTitles: [], stats: [] });
    expect(parseDescription(null, "X")).toEqual({ body: "", altTitles: [], stats: [] });
  });
});
