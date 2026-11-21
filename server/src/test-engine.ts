/** A fake engine: answers the GraphQL calls Sapphire makes. */
export function fakeEngine(): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("/page/")) {
      return new Response(new Uint8Array([9, 9]), { headers: { "content-type": "image/webp" } });
    }
    if (String(url).includes("/thumbnail")) {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
    }
    const body = JSON.parse(String(init?.body));
    const q: string = body.query;
    const json = (data: unknown) => new Response(JSON.stringify({ data }));
    if (q.includes("sources")) {
      return json({
        sources: {
          nodes: [
            { id: "1", name: "Asura Scans", lang: "en", isNsfw: false },
            { id: "2", name: "MangaFire", lang: "all", isNsfw: false },
            { id: "3", name: "ToonGod", lang: "en", isNsfw: true },
            { id: "4", name: "Japanese Site", lang: "ja", isNsfw: false },
            { id: "5", name: "Broken Site", lang: "en", isNsfw: false },
          ],
        },
      });
    }
    if (q.includes("fetchSourceManga")) {
      const source = body.variables.input.source;
      if (source === "5") return new Response("nope", { status: 500 });
      return json({
        fetchSourceManga: {
          mangas: [{ id: Number(source) * 10, title: "Nano Machine", thumbnailUrl: "/x" }],
        },
      });
    }
    if (q.includes("fetchChapters")) {
      return json({
        fetchChapters: {
          chapters: [
            { id: 502, name: "Chapter 236.5", chapterNumber: 236.5, uploadDate: "1795000000000", scanlator: null },
            { id: 501, name: "Chapter 3", chapterNumber: 3, uploadDate: "1700000000000", scanlator: "Group" },
            { id: 500, name: "Special", chapterNumber: -1, uploadDate: "0", scanlator: null },
          ],
        },
      });
    }
    if (q.includes("manga(id")) {
      return json({
        manga: {
          id: 10, sourceId: "1", title: "Nano Machine", thumbnailUrl: "/x", author: "A. Author",
          artist: null, description: "A story.", genre: ["Action", "Murim"], status: "ONGOING",
        },
      });
    }
    if (q.includes("fetchChapterPages")) {
      const ok = body.variables.input.chapterId === 501;
      return json({
        fetchChapterPages: {
          pages: ok
            ? ["/api/v1/manga/10/chapter/2/page/0", "/api/v1/manga/10/chapter/2/page/1"]
            : ["https://evil.example/steal"],
        },
      });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
}

