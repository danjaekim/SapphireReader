import { Loading } from "./Loading";
import { alsoLiked, browse, deepForYou, discoverList, forYou, setNotInterested, type SearchResult, type DeepRow, type SeriesGroup, type Shelf } from "./api";
import { canonLabel } from "./genres";
import { FilterBar } from "./FilterBar";
import { Results } from "./Results";
import { navigate, pageHref, type PageName } from "./route";
import { usePaged } from "./usePaged";
import { Fragment, useEffect, useState } from "react";
import { sortFrom, unsortedNote } from "./SortSelect";

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
/** AniList rows take a while (each series is looked for on your sources), so they load after the rest. */
const alsoCache = new Map<boolean, { rows: { from: string; groups: SeriesGroup[] }[] }>();
const deepCache = new Map<boolean, DeepRow[]>();
const forgetAlsoLiked = () => {
  alsoCache.clear();
  deepCache.clear();
};

/**
 * The deeper rows: themes your series share, and the best fits from a wide pool judged on their full
 * tag lists. They take a while, so they fill in after the rest; the space is held so nothing jumps.
 */
function DeepRows({ adult, scopeTag, page, onDismiss }: { adult: boolean; scopeTag: string; page: PageName; onDismiss: (g: SeriesGroup, on: boolean) => void }) {
  const [rows, setRows] = useState(() => deepCache.get(adult) ?? null);
  useEffect(() => {
    if (deepCache.has(adult)) return;
    let live = true;
    deepForYou(adult).then(
      (r) => {
        deepCache.set(adult, r.rows);
        if (live) setRows(r.rows);
      },
      () => live && setRows([]),
    );
    return () => {
      live = false;
    };
  }, [adult, scopeTag]);
  if (rows === null)
    return (
      <section className="shelf shelfPending">
        <header className="shelfHead">
          <h3>Best matches for your taste</h3>
        </header>
        <Loading label="Comparing everything you like and reading tags for a wide pool of series…" size="sm" />
      </section>
    );
  return (
    <>
      {rows.map((r) => (
        <section key={`deep-${r.kind}-${r.tags.join("+")}`} className="shelf">
          <header className="shelfHead">
            {r.kind === "best" ? (
              <h3>Best matches for your taste</h3>
            ) : (
              <h3>
                Your theme: <em>{r.tags.map(canonLabel).join(" · ")}</em>
              </h3>
            )}
          </header>
          {r.kind === "best" ? (
            <p className="shelfSub muted">Judged on every tag, weighted toward what you like most</p>
          ) : (
            <p className="shelfSub muted">
              <span>{r.examples?.length ? `In ${r.support} of yours, like ${r.examples.slice(0, 2).join(" and ")}` : ""}</span>
              <a className="shelfMore" href={pageHref(page, { genre: r.tags })}>
                More <span aria-hidden="true">→</span>
              </a>
            </p>
          )}
          <Results result={{ groups: r.groups, failed: [], searched: 0 }} lookups={false} compact onDismiss={onDismiss} />
        </section>
      ))}
    </>
  );
}

function AlsoLikedRows({ adult, scopeTag, onDismiss }: { adult: boolean; scopeTag: string; onDismiss: (g: SeriesGroup, on: boolean) => void }) {
  const [rows, setRows] = useState(() => alsoCache.get(adult)?.rows ?? null);
  useEffect(() => {
    if (alsoCache.has(adult)) return;
    let live = true;
    alsoLiked(adult).then(
      (r) => {
        alsoCache.set(adult, r);
        if (live) setRows(r.rows);
      },
      () => live && setRows([]),
    );
    return () => {
      live = false;
    };
  }, [adult, scopeTag]);
  if (rows === null) return <Loading label="Checking what readers of your series also liked…" size="sm" />;
  return (
    <>
      {rows.map((r) => (
        <section key={`al-${r.from}`} className="shelf">
          <header className="shelfHead">
            <h3>Readers of <em>{r.from}</em> also liked</h3>
            <span className="shelfMore">from AniList</span>
          </header>
          <Results result={{ groups: r.groups, failed: [], searched: 0 }} lookups={false} compact onDismiss={onDismiss} />
        </section>
      ))}
    </>
  );
}

/** For you comes as rows, one per mix of tags; older servers sent one list. */
const shelvesOf = (r: SearchResult): Shelf[] | null => {
  const s = (r as SearchResult & { shelves?: Shelf[] }).shelves;
  return s && s.length > 0 ? s : null;
};

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
            : f.groups.length === 0
              ? "Your sources didn't answer with anything matching your taste just now. Try again in a bit, or browse Popular."
              : undefined,
        );
        const shelves = f.shelves ?? [];
        return { groups: f.groups, failed: [], searched: 0, shelves, note: f.because.length && f.groups.length ? `Because you like ${f.because.join(", ")}.` : undefined } as SearchResult & { shelves: Shelf[] };
      }
      const list = await discoverList(mode, adult, p);
      return { ...list, note: unsortedNote(list.unsorted) };
    },
    `${page}|${scopeTag}|${mode}|${genres.join(",")}|${seed ?? ""}|${sort}`,
  );

  const dismiss = (g: SeriesGroup, on: boolean) => {
    forgetAlsoLiked();
    void setNotInterested(g.hits[0].mangaId, g.title, on, adult).catch(() => {});
  };

  return (
    <section>
      <FilterBar
        tabs={{ items: MODES, active: genres.length === 0 ? mode : null, onPick: (id) => navigate(pageHref(page, { mode: id })) }}
        genres={genres}
        scope={adult ? "adult" : "safe"}
        onGenres={(g) => navigate(pageHref(page, { mode: genres.length ? undefined : mode, genre: g, seed, sort: sort === "relevance" ? undefined : sort }))}
        sort={genres.length > 0 ? sort : undefined}
        onSort={(next) => navigate(pageHref(page, { genre: genres, seed, sort: next === "relevance" ? undefined : next }))}
      />
      {error && <p className="bad">{error}</p>}
      {busy && <Loading label="Asking your sources. This can take several seconds." />}
      {result && shelvesOf(result) && (
        <div className="shelves">
          <DeepRows adult={adult} scopeTag={scopeTag} page={page} onDismiss={dismiss} />
          {shelvesOf(result)!.map((s, i) => (
            <Fragment key={s.tags.join("+")}>
            {i === 1 && <AlsoLikedRows adult={adult} scopeTag={scopeTag} onDismiss={dismiss} />}
            <section className="shelf">
              <header className="shelfHead">
                <h3>Because you read <em>{s.from}</em></h3>
                <a className="shelfMore" href={pageHref(page, { genre: s.tags })}>
                  {s.tags.map(canonLabel).join(" + ")} <span aria-hidden="true">→</span>
                </a>
              </header>
              <Results result={{ groups: s.groups, failed: [], searched: 0 }} lookups={false} compact onDismiss={dismiss} />
            </section>
            {i === 0 && shelvesOf(result)!.length === 1 && <AlsoLikedRows adult={adult} scopeTag={scopeTag} onDismiss={dismiss} />}
            </Fragment>
          ))}
        </div>
      )}
      {result && !shelvesOf(result) && <Results result={result} empty={empty ?? (genres.length ? "No series have all of those genres. Try removing one." : undefined)} lookups={false} hasMore={more} onMore={loadMore} />}
    </section>
  );
}
