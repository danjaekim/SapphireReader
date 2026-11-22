import { Loading } from "./Loading";
import { ago } from "./util";
import { tidyTitle } from "./titles";
import { alsoLiked, browse, deepForYou, setAdultMarks, discoverList, forYou, setNotInterested, type SearchResult, type DeepRow, type SeriesGroup, type Shelf } from "./api";
import { canonLabel } from "./genres";
import { FilterBar, useSourceChoices } from "./FilterBar";
import { Results, SelectionContext, type Selection } from "./Results";
import { navigate, pageHref, type PageName } from "./route";
import { clearPagedCache, usePaged } from "./usePaged";
import { resetHiddenCache } from "./shared";
import { Fragment, useEffect, useState } from "react";
import { sortFrom, unsortedNote } from "./SortSelect";

type Mode = "for-you" | "popular" | "latest" | "rating" | "newest" | "az";
const MODES: { id: Mode; label: string }[] = [
  { id: "for-you", label: "For you" },
  { id: "popular", label: "Popular" },
  { id: "latest", label: "Latest" },
  { id: "rating", label: "Top rated" },
  { id: "newest", label: "Newest" },
  { id: "az", label: "A–Z" },
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
/** After your taste changes (a like, favorite tags), For you loads fresh next time. */
export const forgetForYou = () => {
  forgetAlsoLiked();
  clearPagedCache();
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
              <span className="shelfExamples" title={r.examples?.join(" · ")}>{r.examples?.length ? `In ${r.support} of yours, like ${r.examples.slice(0, 2).map(shortTitle).join(" and ")}` : ""}</span>
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
            <h3 title={r.from}>Readers of <em>{tidyTitle(r.from)}</em> also liked</h3>
            <span className="shelfMore">from AniList</span>
          </header>
          <Results result={{ groups: r.groups, failed: [], searched: 0 }} lookups={false} compact onDismiss={onDismiss} />
        </section>
      ))}
    </>
  );
}

/** A series name for running text: tidied, and cut short when it's still long. */
const shortTitle = (t: string) => {
  const s = tidyTitle(t);
  return s.length > 32 ? `${s.slice(0, 30).trimEnd()}…` : s;
};

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
  const picked = params.getAll("source");
  const sourceList = useSourceChoices(adult ? "discover-18" : "discover", adult);
  const [empty, setEmpty] = useState<string | undefined>();
  // Refresh asks the server to rebuild the recommendations now; the page then loads the new answer.
  const [nonce, setNonce] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  async function refreshForYou() {
    setRefreshing(true);
    await Promise.allSettled([forYou(adult, true), deepForYou(adult, true), alsoLiked(adult, true)]);
    forgetForYou();
    setNonce((n) => n + 1);
    setRefreshing(false);
  }

  const { result, busy, error, more, loadMore } = usePaged(
    async (p): Promise<SearchResult> => {
      if (p === 1) setEmpty(undefined);
      if (genres.length > 0) {
        const b = await browse(genres, "", p, adult ? "adult" : "safe", seed, sort, picked);
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
        return { groups: f.groups, failed: [], searched: 0, shelves, computedAt: f.computedAt, stale: f.stale, note: f.because.length && f.groups.length ? `Because you like ${f.because.join(", ")}.` : undefined } as SearchResult & { shelves: Shelf[] };
      }
      const list = await discoverList(mode, adult, p, picked);
      return { ...list, note: unsortedNote(list.unsorted) };
    },
    `${page}|${scopeTag}|${mode}|${genres.join(",")}|${seed ?? ""}|${sort}|${mode === "for-you" && genres.length === 0 ? "" : picked.join(",")}|${nonce}`,
  );

  // Select mode: pick several cards, then mark them 18+ or not 18+ in one go.
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<Map<string, SeriesGroup>>(new Map());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [pickNote, setPickNote] = useState<string | null>(null);
  const [pickBusy, setPickBusy] = useState(false);
  const selection: Selection = {
    active: picking,
    selected: new Set(chosen.keys()),
    gone,
    toggle: (g) =>
      setChosen((m) => {
        const next = new Map(m);
        next.has(g.key) ? next.delete(g.key) : next.set(g.key, g);
        return next;
      }),
  };
  const allShown = (): SeriesGroup[] => {
    if (!result) return [];
    const shelves = shelvesOf(result);
    return (shelves ? shelves.flatMap((s) => s.groups) : result.groups).filter((g) => !gone.has(g.key));
  };
  const stopPicking = () => {
    setPicking(false);
    setChosen(new Map());
  };
  async function markPicked(mark: boolean) {
    const groups = [...chosen.values()];
    if (groups.length === 0) return;
    setPickBusy(true);
    setPickNote(null);
    try {
      await setAdultMarks(groups.map((g) => g.title), mark);
      // They now belong on the other Discover page.
      if (mark !== adult) setGone((s) => new Set([...s, ...groups.map((g) => g.key)]));
      resetHiddenCache();
      clearPagedCache();
      forgetAlsoLiked();
      setPickNote(`Marked ${groups.length} ${mark ? "18+" : "not 18+"}${mark !== adult ? `. ${groups.length === 1 ? "It's" : "They're"} on ${mark ? "Discover (18+)" : "Discover"} now.` : "."}`);
      stopPicking();
    } catch (e) {
      setPickNote(e instanceof Error && /locked/i.test(e.message) ? "Unlock 18+ mode to mark titles not 18+." : "Couldn't mark them. Try again.");
    } finally {
      setPickBusy(false);
    }
  }

  const dismiss = (g: SeriesGroup, on: boolean) => {
    forgetAlsoLiked();
    void setNotInterested(g.hits[0].mangaId, g.title, on, adult).catch(() => {});
  };

  return (
    <section>
      <FilterBar
        tabs={{ items: MODES, active: genres.length === 0 ? mode : null, onPick: (id) => navigate(pageHref(page, { mode: id, source: id === "for-you" ? undefined : picked })) }}
        genres={genres}
        scope={adult ? "adult" : "safe"}
        onGenres={(g) => navigate(pageHref(page, { mode: genres.length ? undefined : mode, genre: g, seed, sort: sort === "relevance" ? undefined : sort, source: picked }))}
        sort={genres.length > 0 ? sort : undefined}
        onSort={(next) => navigate(pageHref(page, { genre: genres, seed, sort: next === "relevance" ? undefined : next, source: picked }))}
        // For you picks from your taste across every source, so it isn't limited by source.
        extra={
          <button type="button" className={`filterBtn ${picking ? "on" : ""}`} aria-pressed={picking} onClick={() => (picking ? stopPicking() : (setPicking(true), setPickNote(null)))}>
            {picking ? "Cancel" : "Select"}
          </button>
        }
        sources={mode === "for-you" && genres.length === 0 ? undefined : { list: sourceList, selected: picked, onChange: (ids) => navigate(pageHref(page, { mode: genres.length ? undefined : mode, genre: genres, seed, sort: sort === "relevance" ? undefined : sort, source: ids })) }}
      />
      {pickNote && <p className="muted pickNote">{pickNote}</p>}
      {picking && (
        <div className="pickBar" role="toolbar" aria-label="Selected series">
          <span className="pickCount">{chosen.size} selected</span>
          <button type="button" className="linkish" onClick={() => setChosen(new Map(allShown().map((g) => [g.key, g])))}>All</button>
          {chosen.size > 0 && <button type="button" className="linkish" onClick={() => setChosen(new Map())}>None</button>}
          <span className="pickActions">
            <button type="button" className="button small secondary" disabled={pickBusy || chosen.size === 0} onClick={() => markPicked(false)}>Not 18+</button>
            <button type="button" className="button small" disabled={pickBusy || chosen.size === 0} onClick={() => markPicked(true)}>Mark 18+</button>
          </span>
        </div>
      )}
      <SelectionContext.Provider value={selection}>
      {error && <p className="bad">{error}</p>}
      {busy && <Loading label="Asking your sources. This can take several seconds." />}
      {result && shelvesOf(result) && (
        <div className="shelves">
          {(result as SearchResult & { computedAt?: number }).computedAt && (
            <p className="muted forYouMeta">
              Updated {ago(new Date((result as SearchResult & { computedAt: number }).computedAt).toISOString())}
              {(result as SearchResult & { stale?: boolean }).stale && " · taste changed since"}
              {" · "}
              <button type="button" className="linkish" disabled={refreshing} onClick={() => void refreshForYou()}>
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </p>
          )}
          <DeepRows adult={adult} scopeTag={`${scopeTag}|${nonce}`} page={page} onDismiss={dismiss} />
          {shelvesOf(result)!.map((s, i) => (
            <Fragment key={s.tags.join("+")}>
            {i === 1 && <AlsoLikedRows adult={adult} scopeTag={`${scopeTag}|${nonce}`} onDismiss={dismiss} />}
            <section className="shelf">
              <header className="shelfHead">
                {s.from ? <h3 title={s.from}>Because you read <em>{tidyTitle(s.from)}</em></h3> : <h3>From your favorite tags</h3>}
                <a className="shelfMore" href={pageHref(page, { genre: s.tags })}>
                  {s.tags.map(canonLabel).join(" + ")} <span aria-hidden="true">→</span>
                </a>
              </header>
              <Results result={{ groups: s.groups, failed: [], searched: 0 }} lookups={false} compact onDismiss={dismiss} />
            </section>
            {i === 0 && shelvesOf(result)!.length === 1 && <AlsoLikedRows adult={adult} scopeTag={`${scopeTag}|${nonce}`} onDismiss={dismiss} />}
            </Fragment>
          ))}
        </div>
      )}
      {result && !shelvesOf(result) && <Results result={result} empty={empty ?? (genres.length ? "No series have all of those genres. Try removing one." : undefined)} lookups={false} hasMore={more} onMore={loadMore} />}
      </SelectionContext.Provider>
    </section>
  );
}
