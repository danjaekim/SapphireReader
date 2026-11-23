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
    expect(parseDescription(d, "X")).toEqual({ body: d, altTitles: [], stats: [], facets: [], tags: [], info: {} });
    expect(parseDescription(null, "X")).toEqual({ body: "", altTitles: [], stats: [], facets: [], tags: [], info: {} });
  });
});

describe("facets", () => {
  it("pulls gallery-style lists (parodies, characters, groups…) out of the description", () => {
    const d = "**Parodies**: original\n\n**Characters**: rem, ram, Rem\n\n**Groups**: circle a\n\n**Languages**: english, translated\n\n**Pages**: 24\n\nA short note.";
    const r = parseDescription(d, "X");
    expect(r.facets).toEqual([
      { label: "Characters", values: ["rem", "ram"] },
      { label: "Groups", values: ["circle a"] },
      { label: "Languages", values: ["english", "translated"] },
    ]);
    expect(r.stats).toEqual([{ label: "Pages", value: "24" }]);
    expect(r.body).toBe("A short note.");
  });
});

describe("details written into the description", () => {
  it("takes a star rating, year, notes and a links list out (MangaDex-style)", () => {
    const d = `★★★★✬ 9.1 (89)
2021

In his past life, Liam was hardworking and honest. Time for some payback.

*Source: Seven Seas Entertainment, Vol. 1*

Alternative Names:
- Ore wa Seikan Kokka no Akutoku Ryoushu!
- 俺は星間国家の悪徳領主！
- I am the Villainous Lord of the Interstellar Nation

Links:
- [MyAnimeList](https://myanimelist.net/manga/142425/)
- [AniList](https://anilist.co/manga/139699/)
- [MangaBaka](https://mangabaka.org/685/)`;
    const a = parseDescription(d, "I'm the Evil Lord of an Intergalactic Empire!");
    expect(a.stats).toEqual([{ label: "Rating", value: "9.1" }, { label: "Votes", value: "89" }]);
    expect(a.info).toEqual({ year: "2021" });
    expect(a.body).toBe("In his past life, Liam was hardworking and honest. Time for some payback.");
    expect(a.altTitles).toEqual(["Ore wa Seikan Kokka no Akutoku Ryoushu!", "俺は星間国家の悪徳領主！", "I am the Villainous Lord of the Interstellar Nation"]);
  });

  it("mines a ToonGod blurb for names, people, year, status and tags, and drops the site's ads", () => {
    const d = `To regain his peace, Gangchan must welcome his smoking neighbor into his home.

[Someone Stop Her (Uncensored) Manhwa](https://www.toongod.org/webtoon/someone-stop-her-uncensored/) also known as 담배피지 마세요! , お隣さんと俺の××攻防戦 , Arrêtez-la! , Stop Smoking!. This on-going [webtoon](https://www.toongod.org) was released in 2025. This series was written by AA and illustrations by Momobird. [Someone Stop Her (Uncensored) Webtoon](https://www.toongod.org/webtoon/someone-stop-her-uncensored/) is about Comedy, Drama, Romance, Uncensored story.

Read the latest Manhwa Someone Stop Her (Uncensored) all chapters in English at ToonGod. Manhwa Someone Stop Her (Uncensored) is always updated at ToonGod. Don’t forget to read the other Manhwa updates.

Browse more than 1000+ Webtoons online for free. Find your favorite [free premium Manhwa](https://www.toongod.org/) for free.

Connect with ToonGod on Social Media:

Alternative Names:
- 담배피지 마세요! , お隣さんと俺の××攻防戦 , Arrêtez-la! , Stop Smoking!`;
    const a = parseDescription(d, "Someone Stop Her (Uncensored)");
    expect(a.body).toBe("To regain his peace, Gangchan must welcome his smoking neighbor into his home.");
    expect(a.altTitles).toEqual(["담배피지 마세요!", "お隣さんと俺の××攻防戦", "Arrêtez-la!", "Stop Smoking!"]);
    expect(a.tags).toEqual(["Comedy", "Drama", "Romance", "Uncensored"]);
    expect(a.info).toEqual({ author: "AA", artist: "Momobird", status: "Ongoing", year: "2025" });
  });

  it("drops upload notes and unescapes Markdown, and splits names on slashes", () => {
    const d = `When I opened my eyes, I was inside a novel.
\\[The Birth of a Hero\\].

*NOTE: \\*\\* Reupload chapter 9-18 – replace with better version \\*\\**

[Trash of the Count’s Family Manhwa](https://www.toongod.org/webtoon/x/) also known as TCF / Trash Count / 백작가의 망나니가 되었다. This on-going [webtoon](https://www.toongod.org) was released in 2020. This series was written by Elegant Yoo Ryeo Han and illustrations by PAN4. [Trash of the Count’s Family Webtoon](https://www.toongod.org/webtoon/x/) is about Action, Adventure, Fantasy story.

Alternative Names:
- TCF / Trash Count / 백작가의 망나니가 되었다`;
    const a = parseDescription(d, "Trash of the Count’s Family");
    expect(a.body).toBe("When I opened my eyes, I was inside a novel.\n[The Birth of a Hero].");
    expect(a.altTitles).toEqual(["TCF", "Trash Count", "백작가의 망나니가 되었다"]);
    expect(a.info).toEqual({ author: "Elegant Yoo Ryeo Han", artist: "PAN4", status: "Ongoing", year: "2020" });
    expect(a.tags).toEqual(["Action", "Adventure", "Fantasy"]);
  });
});

describe("bold or heading-marked section labels", () => {
  it("still finds **Alternative Names:** and **Links:**", () => {
    const d = `In his past life, Liam was honest.

**Alternative Names:**
- Ore wa Seikan Kokka no Akutoku Ryoushu!
- 俺は星間国家の悪徳領主！

**Links:**
- [MyAnimeList](https://myanimelist.net/manga/142425/)
- [AniList](https://anilist.co/manga/139699/)`;
    const a = parseDescription(d, "X");
    expect(a.body).toBe("In his past life, Liam was honest.");
    expect(a.altTitles).toEqual(["Ore wa Seikan Kokka no Akutoku Ryoushu!", "俺は星間国家の悪徳領主！"]);
  });

  it("handles ### headings and a Links list before the names", () => {
    const d = `To regain his peace, Gangchan moves.\n\n### Links:\n* [AniList](https://anilist.co/manga/1/)\n\n### Alternative Names:\n- A one , B two`;
    const a = parseDescription(d, "X");
    expect(a.body).toBe("To regain his peace, Gangchan moves.");
    expect(a.altTitles).toEqual(["A one", "B two"]);
  });
});
