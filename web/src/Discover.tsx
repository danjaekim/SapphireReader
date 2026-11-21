import { Loading } from "./Loading";
import { browse, discoverList, forYou, type SearchResult } from "./api";
import { GenrePicker } from "./GenrePicker";
import { Results } from "./Results";
import { navigate, pageHref, type PageName } from "./route";
import { usePaged } from "./usePaged";
import { useState } from "react";
import { SortSelect, sortFrom, unsortedNote } from "./SortSelect";

type Mode = "for-you" | "popular" | "latest" | "rating" | "newest";
const MODES: { id: Mode; label: string }[] = [
  { id: "for-you", label: "For you" },
  { id: "popular", label: "Popular" },
  { id: "latest", label: "Latest" },
  { id: "rating", label: "Top rated" },
  { id: "newest", label: "Newest" },
];

/**
 * Browse without a search term: recommendations, each site's popular and latest lists, or genre filters.
 * Mode and genres live in the address, so Back restores them. The 18+ page uses only 18+ sources
 * and offers only their genres; the ordinary page does the opposite.
 */
export function Discover({ adult = false, params, scopeTag }: { adult?: boolean; params: URLSearchParams; scopeTag: string }) {
  const page: PageName = adult ? "discover-18" : "discover";
  const mode: Mode = MODES.some((m) => m.id === params.get("mode")) ? (params.get("mode") as Mode) : "for-you";
  const genres = params.getAll("genre");
  const seed = params.get("seed") ?? undefined;
  const sort = sortFrom(params.get("sort"));
  const [empty, setEmpty] = useState<string | undefined>();

  const { result, busy, error, more, loadMore } = usePaged(
    async (p): Promise<SearchResult> => {
      if (p === 1) setEmpty(undefined);
      if (genres.length > 0) {
        const b = await browse(genres, "", p, adult ? "adult" : "safe", seed, sort);
        const notes = [b.textFallback ? "No series matched those genres exactly, so these are plain text-search results for them." : undefined, unsortedNote(b.unsorted)].filter(Boolean);
        return { ...b, note: notes.length ? notes.join(" ") : undefined };
      }
      if (mode === "for-you") {
        // Recommendations come as one list, not pages.
        if (p > 1) return { groups: [], failed: [], searched: 0 };
        const f = await forYou(adult);
        setEmpty(
          f.because.length === 0
            ? adult
              ? "Add a few 18+ series to your library and this page will start recommending similar ones. It never mixes with your regular recommendations."
              : "Add a few series to your library and Sapphire will start recommending similar ones here."
            : undefined,
        );
        return { groups: f.groups, failed: [], searched: 0, note: f.because.length ? `Because you like ${f.because.join(", ")}.` : undefined };
      }
      const list = await discoverList(mode, adult, p);
      return { ...list, note: unsortedNote(list.unsorted) };
    },
    `${page}|${scopeTag}|${mode}|${genres.join(",")}|${seed ?? ""}|${sort}`,
  );

  return (
    <section>
      <div className="chips" role="tablist" aria-label="Discover">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            className={`chip ${genres.length === 0 && mode === m.id ? "on" : ""}`}
            aria-selected={genres.length === 0 && mode === m.id}
            onClick={() => navigate(pageHref(page, { mode: m.id }))}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <GenrePicker selected={genres} scope={adult ? "adult" : "safe"} onChange={(g) => navigate(pageHref(page, { mode: genres.length ? undefined : mode, genre: g, seed, sort: sort === "relevance" ? undefined : sort }))} />
        {genres.length > 0 && (
          <SortSelect value={sort} onChange={(next) => navigate(pageHref(page, { genre: genres, seed, sort: next === "relevance" ? undefined : next }))} />
        )}
      </div>
      {error && <p className="bad">{error}</p>}
      {busy && <Loading label="Asking your sources. This can take several seconds." />}
      {result && <Results result={result} empty={empty ?? (genres.length ? "No series have all of those genres. Try removing one." : undefined)} lookups={false} hasMore={more} onMore={loadMore} />}
    </section>
  );
}
