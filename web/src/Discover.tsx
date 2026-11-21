import { browse, discoverList, forYou, type SearchResult } from "./api";
import { GenrePicker } from "./GenrePicker";
import { Results } from "./Results";
import { navigate, pageHref, type PageName } from "./route";
import { usePaged } from "./usePaged";
import { useState } from "react";

type Mode = "for-you" | "popular" | "latest";
const MODES: { id: Mode; label: string }[] = [
  { id: "for-you", label: "For you" },
  { id: "popular", label: "Popular" },
  { id: "latest", label: "Latest" },
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
  const [empty, setEmpty] = useState<string | undefined>();

  const { result, busy, error, more, loadMore } = usePaged(
    async (p): Promise<SearchResult> => {
      if (p === 1) setEmpty(undefined);
      if (genres.length > 0) {
        const b = await browse(genres, "", p, adult ? "adult" : "safe");
        return { ...b, note: b.skipped.length ? `${b.skipped.join(", ")} can't filter by these genres, so ${b.skipped.length === 1 ? "it was" : "they were"} not searched.` : undefined };
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
      return discoverList(mode === "latest" ? "latest" : "popular", adult, p);
    },
    `${page}|${scopeTag}|${mode}|${genres.join(",")}`,
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
      <GenrePicker selected={genres} scope={adult ? "adult" : "safe"} onChange={(g) => navigate(pageHref(page, { mode: genres.length ? undefined : mode, genre: g }))} />
      {error && <p className="bad">{error}</p>}
      {busy && <p className="muted">Asking your sources. This can take several seconds.</p>}
      {result && <Results result={result} empty={empty ?? (genres.length ? "No series have all of those genres. Try removing one." : undefined)} lookups={false} hasMore={more} onMore={loadMore} />}
    </section>
  );
}
