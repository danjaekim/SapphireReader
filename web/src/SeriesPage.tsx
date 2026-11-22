import { Loading } from "./Loading";
import { useEffect, useRef, useState } from "react";
import { addToLibrary, alternatives, favoriteTags, setFavoriteTags, setLiked, chapterPages, categories as loadCategories, markChapters, setSeriesCategories, type Category, removeFromLibrary, series, similar, thumbnailUrl, type Alternative, type ChapterInfo, type SeriesData, type SeriesGroup } from "./api";
import { genreHref, goBack, readHref, searchHref } from "./route";
import { TrackerLinkCard } from "./Trackers";
import { useSeriesDownloads } from "./useDownloads";
import { useRating } from "./shared";
import { canonKey } from "./genres";
import { forgetForYou } from "./Discover";
import { chapterDate, statusLabel } from "./util";

function chapterLabel(c: { name: string; chapterNumber: number }): string {
  return c.chapterNumber >= 0 ? `Ch. ${Number.isInteger(c.chapterNumber) ? c.chapterNumber : c.chapterNumber.toFixed(1)}` : c.name;
}

/** Authors and artists come as one string ("A, B/ C"); each name links to a search for it. */
function People({ names }: { names: string }) {
  const parts = names.split(/\s*[,/;&]\s*/).map((n) => n.trim()).filter(Boolean);
  return (
    <>
      {parts.map((n, i) => (
        <span key={`${n}${i}`}>
          {i > 0 && ", "}
          <a className="personLink" href={searchHref(n)} title={`Search for ${n}`}>{n}</a>
        </span>
      ))}
    </>
  );
}

/** Long tag lists (some sites give 40+) show this many until you ask for the rest. */
const TAG_CAP = 12;

/**
 * A series with a single chapter (one-shots, galleries) doesn't need a chapter list: show its
 * pages instead, with read and download controls. Tapping a page opens the reader there.
 */
function OneChapter({ mangaId, chapter, read, state, onMark, onDownload, onPages, leftRef }: {
  mangaId: number;
  chapter: ChapterInfo;
  read: boolean;
  state?: { status: string; error: string | null };
  onMark: (read: boolean) => void;
  onDownload: () => void;
  onPages: (count: number | null) => void;
  leftRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [pages, setPages] = useState<string[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setFailed(false);
    onPages(null);
    chapterPages(chapter.id).then(
      (r) => { if (!cancelled) { setPages(r.pages); onPages(r.pages.length); } },
      () => { if (!cancelled) { setFailed(true); onPages(-1); } },
    );
    return () => void (cancelled = true);
  }, [chapter.id]);
  // Show as many whole rows as fill the space: down to the bottom of the left column on wide
  // screens, about a screen's worth on phones. At least two rows.
  const gridRef = useRef<HTMLUListElement>(null);
  const [fit, setFit] = useState(PREVIEW_PAGES);
  const hasPages = pages !== null;
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const wide = window.matchMedia("(min-width: 901px)");
    const measure = () => {
      const tracks = getComputedStyle(grid).gridTemplateColumns.split(" ").filter((t) => t && t !== "0px");
      const cols = Math.max(1, tracks.length);
      const gap = parseFloat(getComputedStyle(grid).rowGap) || 10;
      const rowH = (parseFloat(tracks[0]) || 110) * 1.5 + gap;
      const left = leftRef.current;
      const avail = wide.matches && left
        ? left.getBoundingClientRect().bottom - grid.getBoundingClientRect().top
        : window.innerHeight * 0.75;
      const rows = Math.max(2, Math.floor((avail + gap) / rowH));
      setFit(rows * cols);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    if (leftRef.current) ro.observe(leftRef.current);
    wide.addEventListener("change", measure);
    return () => {
      ro.disconnect();
      wide.removeEventListener("change", measure);
    };
  }, [hasPages, leftRef]);
  const shown = pages ? (all ? pages : pages.slice(0, fit)) : [];
  return (
    <div className="card oneChapter">
      <div className="chapterHead">
        <h3>
          Pages {pages && <span className="muted small">{pages.length}</span>}
        </h3>
        <div className="chapterTools">
          <button type="button" className="linkish" onClick={() => onMark(!read)}>{read ? "Mark unread" : "Mark read"}</button>
          <DownloadButton state={state} onDownload={onDownload} />
        </div>
      </div>
      {failed && <p className="muted small">Couldn't load a preview of the pages. You can still open it to read.</p>}
      {!pages && !failed && <Loading label="Loading pages…" size="sm" />}
      {pages && (
        <ul className="pageThumbs" ref={gridRef}>
          {shown.map((src, i) => (
            <li key={src}>
              <a href={readHref(mangaId, chapter.id, i)} aria-label={`Open page ${i + 1}`}>
                <img src={src} alt="" loading="lazy" decoding="async" />
                <span>{i + 1}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {pages && pages.length > fit && (
        <button type="button" className="linkish" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${pages.length} pages`}
        </button>
      )}
    </div>
  );
}
const PREVIEW_PAGES = 12;

export function DownloadButton({ state, onDownload }: { state?: { status: string; error: string | null }; onDownload: () => void }) {
  if (state?.status === "done") return <span className="dlState done" title="Saved on the NAS. Remove it from the Downloads page.">✓</span>;
  if (state?.status === "queued" || state?.status === "downloading") {
    return <span className="dlState" title={state.status === "queued" ? "Waiting to download" : "Downloading"}>…</span>;
  }
  return (
    <button type="button" className="dlBtn" onClick={onDownload} title={state?.status === "failed" ? `Failed: ${state.error ?? "try again"}. Tap to retry.` : "Download this chapter to the NAS"} aria-label="Download chapter">
      {state?.status === "failed" ? "⚠" : "⬇"}
    </button>
  );
}

/**
 * Other names on one line, with "+N more" at the end of that line. Measures how many fit, so a wide
 * screen shows more of them.
 */
function AltTitles({ titles, open, onToggle }: { titles: string[]; open: boolean; onToggle: () => void }) {
  const box = useRef<HTMLParagraphElement>(null);
  const [fit, setFit] = useState(titles.length);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const probe = el.querySelector<HTMLElement>(".altProbe");
      if (!probe) return;
      const room = el.clientWidth - 90; // space kept for "+N more"
      const items = [...probe.children] as HTMLElement[];
      let n = 0;
      for (const it of items) {
        if (it.offsetLeft + it.offsetWidth > room && n > 0) break;
        n++;
      }
      // Everything fits without the "+N more" link: use the whole line.
      const last = items[items.length - 1];
      setFit(last && last.offsetLeft + last.offsetWidth <= el.clientWidth ? items.length : Math.max(1, n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [titles]);
  const shown = open ? titles : titles.slice(0, fit);
  return (
    <p className={`altTitles ${open ? "open" : ""}`} ref={box}>
      <span className="altProbe" aria-hidden="true">
        {titles.map((t, i) => <span key={i}>{i > 0 ? " · " : ""}{t}</span>)}
      </span>
      {shown.join(" · ")}
      {titles.length > fit && (
        <button type="button" className="linkish" onClick={onToggle}>
          {open ? "Show less" : `+${titles.length - fit} more`}
        </button>
      )}
    </p>
  );
}

export function SeriesPage({ mangaId }: { mangaId: number }) {
  const [data, setData] = useState<SeriesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [newestFirst, setNewestFirst] = useState(true);
  const [fullDesc, setFullDesc] = useState(false);
  const [allTags, setAllTags] = useState(false);
  // Favorite tags (the regular or 18+ list, whichever this series belongs to); star mode lets you pick them here.
  const [favs, setFavs] = useState<string[] | null>(null);
  const [starring, setStarring] = useState(false);
  const favAdult = data?.adult === true;
  useEffect(() => {
    if (!data) return;
    let live = true;
    favoriteTags(favAdult).then((r) => live && setFavs(r.tags), () => live && setFavs(null));
    return () => {
      live = false;
    };
  }, [data !== null, favAdult]);
  const favKeys = new Set((favs ?? []).map(canonKey));
  function toggleFav(tag: string) {
    if (!favs) return;
    const before = favs;
    const next = favKeys.has(canonKey(tag)) ? favs.filter((f) => canonKey(f) !== canonKey(tag)) : [...favs, tag];
    setFavs(next);
    setFavoriteTags(next, favAdult).then(
      (r) => {
        setFavs(r.tags);
        forgetForYou();
      },
      () => setFavs(before),
    );
  }
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [jump, setJump] = useState("");
  // Wait for the series (and its other names) before asking, so the lookup can use them.
  const rating = useRating(data?.manga.title ?? null, data !== null, data ? (data.about?.altTitles ?? []) : undefined);
  const score = rating?.score ?? null;
  const banner = rating?.banner ?? null;
  const [fullAlt, setFullAlt] = useState(false);
  // On wide screens the chapter list is as tall as the left column (at least ~one screen's worth of rows), then scrolls.
  const leftRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [listMax, setListMax] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setAnchor(null);
  }, [mangaId]);
  const loadedOnce = data !== null;
  useEffect(() => {
    const left = leftRef.current;
    const list = listRef.current;
    if (!left || !list) return;
    const wide = window.matchMedia("(min-width: 901px)");
    const measure = () => {
      if (!wide.matches) return setListMax(null);
      const top = list.getBoundingClientRect().top - left.getBoundingClientRect().top;
      setListMax(Math.max(Math.round(left.offsetHeight - top), Math.round(window.innerHeight * 0.6), 420));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(left);
    wide.addEventListener("change", measure);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      wide.removeEventListener("change", measure);
      window.removeEventListener("resize", measure);
    };
  }, [loadedOnce, mangaId, fullDesc, fullAlt]);
  // Esc clears the selection.
  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (setSelected(new Set()), setAnchor(null));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size]);
  // After marking one chapter read, offer to mark the unread ones before it too (handy when you read them elsewhere).
  const [shelves, setShelves] = useState<Category[]>([]);
  useEffect(() => {
    loadCategories().then((r) => setShelves(r.categories), () => {});
  }, []);
  const [offer, setOffer] = useState<{ label: string; ids: number[] } | null>(null);

  const { states, download } = useSeriesDownloads(mangaId);
  const [similarGroups, setSimilarGroups] = useState<SeriesGroup[] | null>(null);
  const [basedOn, setBasedOn] = useState<string[]>([]);
  const [others, setOthers] = useState<Alternative[] | null>(null);

  // Similar series load on their own once the series itself is up, so the page isn't held back.
  const loaded = data !== null;
  useEffect(() => {
    setSimilarGroups(null);
    if (!loaded) return;
    let cancelled = false;
    similar(mangaId).then(
      (r) => {
        if (cancelled) return;
        setSimilarGroups(r.groups);
        setBasedOn(r.basedOn ?? []);
      },
      () => !cancelled && setSimilarGroups([]),
    );
    return () => {
      cancelled = true;
    };
  }, [mangaId, loaded]);

  useEffect(() => {
    setOthers(null);
    alternatives(mangaId).then((r) => setOthers(r.alternatives), () => setOthers([]));
  }, [mangaId]);

  useEffect(() => {
    setData(null);
    setError(null);
    setErrorDetail(null);
    series(mangaId).then(setData, (e: unknown) => {
      setError(e instanceof Error ? e.message : "Couldn't load this series.");
      setErrorDetail((e as { detail?: string } | null)?.detail ?? null);
    });
  }, [mangaId, attempt]);

  // Tab title (left plain for 18+ series, so they stay out of browser history).
  useEffect(() => {
    if (!data || data.adult) return;
    document.title = `${data.manga.title} · Sapphire`;
    return () => {
      document.title = "Sapphire";
    };
  }, [data?.manga.title]);

  async function mark(chapterIds: number[], read: boolean) {
    if (!data) return;
    const before = data;
    const ids = new Set(data.readChapterIds);
    for (const id of chapterIds) (read ? ids.add(id) : ids.delete(id));
    setData({ ...data, readChapterIds: [...ids] });
    try {
      const r = await markChapters(mangaId, chapterIds, read);
      setData((d) => (d ? { ...d, readChapterIds: r.readChapterIds, progress: r.progress } : d));
    } catch {
      setData(before);
    }
  }

  async function toggleLike() {
    if (!data) return;
    const next = !data.liked;
    setData({ ...data, liked: next });
    try {
      await setLiked(mangaId, next);
      forgetForYou();
    } catch {
      setData((d) => (d ? { ...d, liked: !next } : d));
    }
  }

  async function toggleLibrary() {
    if (!data) return;
    const next = !data.inLibrary;
    setData({ ...data, inLibrary: next });
    try {
      if (next) await addToLibrary(mangaId, data.manga.sourceId, data.manga.sourceName, data.manga.title);
      else await removeFromLibrary(mangaId);
    } catch {
      setData((d) => (d ? { ...d, inLibrary: !next } : d));
    }
  }

  const readIds = new Set(data?.readChapterIds ?? []);
  const rawAbout = data?.about ?? { body: data?.manga.description ?? "", altTitles: [], stats: [] };
  // Some sites write their descriptions in Markdown; show **bold** and __bold__ as plain text.
  const about = { ...rawAbout, body: rawAbout.body.replace(/(\*\*|__)(.+?)\1/g, "$2") };
  const unread = data ? data.chapters.filter((c) => !readIds.has(c.id) && states[c.id]?.status !== "done") : [];
  const notSaved = data ? data.chapters.filter((c) => !states[c.id] || states[c.id].status === "failed") : [];
  const working = Object.values(states).filter((d) => d.status === "queued" || d.status === "downloading").length;
  const resume = data?.progress ? data.chapters.find((c) => c.id === data.progress!.chapterId) : undefined;
  // Finished the chapter you were on: point at the next one, or say you're caught up.
  const resumeDone = !!resume && readIds.has(resume.id);
  const next = resume && resumeDone ? data!.chapters[data!.chapters.indexOf(resume) + 1] : undefined;
  const caughtUp = resumeDone && !next;

  // The chapters as listed (order and "Find chapter" filter applied).
  const listed = data
    ? (newestFirst ? [...data.chapters].reverse() : data.chapters).filter(
        (c) => !jump.trim() || chapterLabel(c).toLowerCase().includes(jump.trim().toLowerCase()) || c.name.toLowerCase().includes(jump.trim().toLowerCase()),
      )
    : [];
  const picked = data ? data.chapters.filter((c) => selected.has(c.id)) : [];
  const allPicked = listed.length > 0 && listed.every((c) => selected.has(c.id));

  /** Click toggles one chapter; shift-click selects everything between the last one you clicked and this one. */
  function pick(c: ChapterInfo, range: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      const from = anchor === null ? -1 : listed.findIndex((x) => x.id === anchor);
      const to = listed.findIndex((x) => x.id === c.id);
      if (range && from >= 0 && to >= 0) {
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) next.add(listed[i].id);
      } else if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
    setAnchor(c.id);
  }
  const clearPicks = () => {
    setSelected(new Set());
    setAnchor(null);
  };
  const isRating = (label: string) => /rating|score/i.test(label);
  const rank = about.stats.find((st) => /^rank$/i.test(st.label));
  // Ratings from every place that has one, shown together under the title.
  const ratings: { label: string; value: string; title: string }[] = [
    ...(score != null ? [{ label: "AniList", value: (score / 10).toFixed(1), title: "AniList average score, out of 10" }] : []),
    ...about.stats.filter((st) => isRating(st.label)).map((st) => ({ label: data?.manga.sourceName ?? "Site", value: st.value, title: `${st.label} on ${data?.manga.sourceName ?? "the source"}` })),
    ...(rating?.mu != null ? [{ label: "MangaUpdates", value: rating.mu.toFixed(1), title: "MangaUpdates rating, out of 10" }] : []),
  ];
  const single = data?.chapters.length === 1;
  // Plain numbers for the box on the left: chapters plus whatever else the site counts (bookmarks, views…).
  const counts = [
    single
      ? { label: "Pages", value: pageCount === null ? "…" : pageCount < 0 ? "—" : String(pageCount) }
      : { label: "Chapters", value: String(data ? (data.latest.latestNumber !== null ? Math.floor(data.latest.latestNumber) : data.latest.chapterCount) : 0) },
    ...about.stats.filter((st) => !isRating(st.label) && !/^rank$/i.test(st.label) && !(single && /^pages$/i.test(st.label))),
  ].slice(0, 3);

  return (
    <section className="seriesPage">
      {data && (
        <div
          className={`seriesBackdrop ${banner ? "banner" : ""}`}
          aria-hidden="true"
          style={{ backgroundImage: `url(${banner ? JSON.stringify(banner) : thumbnailUrl(mangaId)})` }}
        />
      )}
      <a className="back" href="#/" onClick={(e) => { e.preventDefault(); goBack(); }}>← Back</a>
      {error && (
        <div className="loadError">
          <p className="bad"><strong>{error}</strong></p>
          {errorDetail && <p className="muted small">The source said: {errorDetail}</p>}
          <p className="muted small">
            This is usually the site being slow, blocking the NAS for a moment, or the series having been removed there. A search can still list a series the site no longer serves.
          </p>
          <div className="actions">
            <button type="button" className="button small" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
            <button type="button" className="button small secondary" onClick={() => goBack()}>Go back</button>
          </div>
        </div>
      )}
      {!data && !error && (
        <div className="pageCenter">
          <Loading label="Loading from the source. This can take several seconds." size="lg" />
        </div>
      )}
      {data && (
        <>
          <div className="seriesLayout">
            <div className="seriesLeft" ref={leftRef}>
              <img className="seriesCover" src={thumbnailUrl(mangaId)} alt="" width={300} height={450} />
              <aside className="seriesSide">
                <ul className="statGrid" style={{ gridTemplateColumns: `repeat(${counts.length}, 1fr)` }}>
                  {counts.map((st) => (
                    <li key={st.label}>
                      <strong>{st.value}</strong>
                      <span>{st.label}</span>
                    </li>
                  ))}
                </ul>
                <dl className="infoList">
                  <div><dt>Status</dt><dd>{statusLabel(data.manga.status)}</dd></div>
                  {data.manga.sourceName && <div><dt>Source</dt><dd>{data.manga.sourceName}</dd></div>}
                  {data.manga.author && <div><dt>Author</dt><dd><People names={data.manga.author} /></dd></div>}
                  {data.manga.artist && data.manga.artist !== data.manga.author && <div><dt>Artist</dt><dd><People names={data.manga.artist} /></dd></div>}
                  {!single && data.latest.latestNumber !== null && (
                    <div><dt>Latest</dt><dd>{chapterLabel({ name: "", chapterNumber: data.latest.latestNumber })}</dd></div>
                  )}
                </dl>
                {data.manga.genre.length > 0 && (
                  <ul className={`genres ${starring ? "starring" : ""}`}>
                    {(allTags || starring ? data.manga.genre : data.manga.genre.slice(0, TAG_CAP)).map((g) => {
                      const fav = favKeys.has(canonKey(g));
                      return (
                        <li key={g}>
                          {starring ? (
                            <button type="button" className={`tag starTag ${fav ? "fav" : ""}`} aria-pressed={fav} onClick={() => toggleFav(g)}>
                              <span aria-hidden="true">{fav ? "★" : "☆"}</span> {g}
                            </button>
                          ) : (
                            <a className={`tag ${fav ? "fav" : ""}`} href={genreHref(g, data.manga.id, data.adult)} title={fav ? "One of your favorite tags" : undefined}>
                              {fav && <span aria-hidden="true">★ </span>}
                              {g}
                            </a>
                          )}
                        </li>
                      );
                    })}
                    {!starring && data.manga.genre.length > TAG_CAP && (
                      <li>
                        <button type="button" className="tag moreTag" onClick={() => setAllTags((v) => !v)}>
                          {allTags ? "Fewer" : `+${data.manga.genre.length - TAG_CAP} more`}
                        </button>
                      </li>
                    )}
                    {favs && (
                      <li>
                        <button type="button" className="tag moreTag" onClick={() => setStarring((v) => !v)} title="Favorite tags count strongly toward For you">
                          {starring ? "Done" : <><span aria-hidden="true">☆</span> Favorite tags</>}
                        </button>
                      </li>
                    )}
                  </ul>
                )}
                {(about.facets ?? []).map((f) => (
                  <div key={f.label} className="facet">
                    <span className="facetLabel muted small">{f.label}</span>
                    <ul className="genres">
                      {f.values.map((v) => (
                        <li key={v}><a className="tag facetTag" href={searchHref(v)} title={`Search for ${v}`}>{v}</a></li>
                      ))}
                    </ul>
                  </div>
                ))}
                {others && others.length > 0 && (
                  <div className="card">
                    <h3>Also on</h3>
                    <ul className="sources">
                      {others.map((o) => {
                        const ahead = o.latestNumber !== null && data.latest.latestNumber !== null && o.latestNumber > data.latest.latestNumber;
                        return (
                          <li key={o.mangaId} className={ahead ? "best" : undefined}>
                            <a href={`#/series/${o.mangaId}`}>{o.sourceName}</a>
                            <span className="muted">{o.latestNumber !== null ? chapterLabel({ name: "", chapterNumber: o.latestNumber }) : "no numbered chapters"}</span>
                            {ahead && <span className="tag">further ahead</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
                <TrackerLinkCard mangaId={mangaId} title={data.manga.title} />
              </aside>
            </div>

            <div className="seriesRight">
              <div className="card seriesIntro">
                <h2>{data.manga.title}</h2>
                {about.altTitles.length > 0 && <AltTitles titles={about.altTitles} open={fullAlt} onToggle={() => setFullAlt((v) => !v)} />}
                {(rank || ratings.length > 0) && (
                  <ul className="ratingRow">
                    {rank && <li className="rankBadge" title={`From ${data.manga.sourceName ?? "the source"}`}>Rank {rank.value}</li>}
                    {ratings.map((r) => (
                      <li key={r.label} className="ratingChip" title={r.title}>
                        <strong>★ {r.value}</strong> <span>{r.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {about.body && (
                  <div className="descWrap">
                    <p className={`desc ${fullDesc ? "" : "clamped"}`}>{about.body}</p>
                    {about.body.length > 280 && (
                      <button type="button" className="linkish" onClick={() => setFullDesc((v) => !v)}>
                        {fullDesc ? "Show less" : "Show more"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              <div className="seriesActions">
                <div className="actions">
                  {data.chapters.length > 0 &&
                    (caughtUp ? (
                      <span className="button caughtUp" title={`You've read up to ${chapterLabel(resume!)}, the newest chapter.`}>Caught up ✓</span>
                    ) : (
                      <a className="button" href={readHref(mangaId, (next ?? resume ?? data.chapters[0]).id)}>
                        {next ? `Next: ${chapterLabel(next)}` : resume ? `Continue ${chapterLabel(resume)}` : "Start reading"}
                      </a>
                    ))}
                  <button type="button" className="button secondary" onClick={toggleLibrary}>
                    {data.inLibrary ? "In library ✓" : "Add to library"}
                  </button>
                  <button
                    type="button"
                    className={`button secondary likeBtn ${data.liked ? "on" : ""}`}
                    onClick={toggleLike}
                    aria-pressed={data.liked === true}
                    title={data.liked ? "Liked: For you suggests more like this (tap to undo)" : "Like it: For you suggests more like this"}
                  >
                    <span aria-hidden="true">{data.liked ? "♥" : "♡"}</span> {data.liked ? "Liked" : "Like"}
                  </button>
                </div>
                {data.inLibrary && shelves.length > 0 && (
                  <div className="chips shelfPick" aria-label="Shelves">
                    {shelves.map((c) => {
                      const on = (data.categories ?? []).includes(c.id);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          className={`chip small ${on ? "on" : ""}`}
                          aria-pressed={on}
                          onClick={() => {
                            const ids = on ? (data.categories ?? []).filter((x) => x !== c.id) : [...(data.categories ?? []), c.id];
                            setData({ ...data, categories: ids });
                            setSeriesCategories(mangaId, ids).catch(() => setData(data));
                          }}
                        >
                          {on ? "✓ " : ""}{c.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {data.chapters.length === 1 ? (
                <OneChapter
                  mangaId={mangaId}
                  chapter={data.chapters[0]}
                  read={readIds.has(data.chapters[0].id)}
                  state={states[data.chapters[0].id]}
                  onMark={(r) => void mark([data.chapters[0].id], r)}
                  onDownload={() => download(data.manga, [data.chapters[0]])}
                  onPages={setPageCount}
                  leftRef={leftRef}
                />
              ) : (
              <div className="seriesChapters">
                <div className="chapterHead">
                  <h3>
                    Chapters{" "}
                    {data.chapters.length > 0 && (
                      <span className="muted small">
                        {data.chapters.filter((c) => !readIds.has(c.id)).length} unread of {data.chapters.length}
                      </span>
                    )}
                  </h3>
                  <div className="chapterTools">
                    {data.chapters.length > 30 && (
                      <input
                        type="search"
                        inputMode="decimal"
                        className="jump"
                        placeholder="Find chapter"
                        value={jump}
                        onChange={(e) => setJump(e.target.value)}
                        aria-label="Find a chapter by number or name"
                      />
                    )}
                    <button type="button" className="linkish" onClick={() => setNewestFirst((v) => !v)}>
                      {newestFirst ? "Newest first" : "Oldest first"}
                    </button>
                  </div>
                </div>
                {selected.size > 0 ? (
                  <div className="selBar" role="toolbar" aria-label="Selected chapters">
                    <strong>{selected.size} selected</strong>
                    {!allPicked && (
                      <button type="button" className="linkish" onClick={() => setSelected(new Set([...selected, ...listed.map((c) => c.id)]))}>
                        Select all {listed.length}
                      </button>
                    )}
                    <span className="selActions">
                      <button type="button" className="button small" onClick={() => { void mark([...selected], true); clearPicks(); }}>Mark read</button>
                      <button type="button" className="button small secondary" onClick={() => { void mark([...selected], false); clearPicks(); }}>Mark unread</button>
                      <button
                        type="button"
                        className="button small secondary"
                        disabled={picked.every((c) => states[c.id] && states[c.id].status !== "failed")}
                        onClick={() => { download(data.manga, picked.filter((c) => !states[c.id] || states[c.id].status === "failed")); clearPicks(); }}
                      >
                        Download
                      </button>
                      <button type="button" className="iconBtn selClose" aria-label="Clear selection" title="Clear selection (Esc)" onClick={clearPicks}>✕</button>
                    </span>
                  </div>
                ) : (
                  <div className="actions dlActions">
                    <button type="button" className="button small secondary" disabled={notSaved.length === 0} onClick={() => download(data.manga, notSaved)}>
                      Download all{notSaved.length ? ` (${notSaved.length})` : ""}
                    </button>
                    <button
                      type="button"
                      className="button small secondary"
                      disabled={unread.filter((c) => !states[c.id]).length === 0}
                      onClick={() => download(data.manga, unread.filter((c) => !states[c.id] || states[c.id].status === "failed"))}
                    >
                      Download unread
                    </button>
                    {working > 0 && <span className="muted">Downloading {working} chapter{working === 1 ? "" : "s"} to the NAS…</span>}
                    {data.chapters.length > 1 && <span className="muted small selHint">Tick chapters to act on several at once; shift-click selects a range.</span>}
                  </div>
                )}
                {offer && (
                  <div className="offer">
                    <span>Also mark the {offer.ids.length} unread chapter{offer.ids.length === 1 ? "" : "s"} before {offer.label} as read?</span>
                    <button type="button" className="button small" onClick={() => { void mark(offer.ids, true); setOffer(null); }}>Mark read</button>
                    <button type="button" className="linkish" onClick={() => setOffer(null)}>No thanks</button>
                  </div>
                )}
                <ul ref={listRef} className={`chapters ${selected.size > 0 ? "picking" : ""}`} style={listMax ? { maxHeight: listMax } : undefined}>
                  {listed.map((c) => {
                    const on = selected.has(c.id);
                    return (
                      <li key={c.id} className={`${readIds.has(c.id) ? "read" : ""} ${on ? "picked" : ""}`}>
                        <button
                          type="button"
                          className="pick"
                          role="checkbox"
                          aria-checked={on}
                          aria-label={`Select ${chapterLabel(c)}`}
                          onClick={(e) => pick(c, e.shiftKey)}
                        >
                          <span aria-hidden="true">{on ? "✓" : ""}</span>
                        </button>
                        <a
                          href={readHref(mangaId, c.id)}
                          onClick={(e) => {
                            // While picking (or with shift), a click selects instead of opening.
                            if (selected.size > 0 || e.shiftKey) {
                              e.preventDefault();
                              pick(c, e.shiftKey);
                            }
                          }}
                        >
                          <span>{chapterLabel(c)}</span>
                          {c.name && c.chapterNumber >= 0 && c.name !== chapterLabel(c) && <span className="muted chName"> {c.name}</span>}
                          <span className="muted date" title={c.uploadDate ? new Date(c.uploadDate).toLocaleDateString() : undefined}>{chapterDate(c.uploadDate)}</span>
                        </a>
                        <button
                          type="button"
                          className="dlBtn"
                          title={readIds.has(c.id) ? "Mark as unread" : "Mark as read"}
                          aria-label={readIds.has(c.id) ? "Mark as unread" : "Mark as read"}
                          onClick={() => {
                            const read = !readIds.has(c.id);
                            void mark([c.id], read);
                            const earlier = data.chapters.slice(0, data.chapters.indexOf(c)).filter((x) => !readIds.has(x.id)).map((x) => x.id);
                            setOffer(read && earlier.length > 0 ? { label: chapterLabel(c), ids: earlier } : null);
                          }}
                        >
                          {readIds.has(c.id) ? "◉" : "○"}
                        </button>
                        <DownloadButton state={states[c.id]} onDownload={() => download(data.manga, [c])} />
                      </li>
                    );
                  })}
                </ul>
              </div>
              )}
            </div>
          </div>

          {similarGroups === null && <Loading label="Finding similar series…" size="sm" />}
          {similarGroups && similarGroups.length > 0 && (
            <div className="card similarCard">
              <h3>Similar series</h3>
              {basedOn.length > 0 && <p className="muted small">Matched mostly on {basedOn.join(", ")}.</p>}
              <SimilarGrid groups={similarGroups} />
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * Similar series fill whole rows only: as many columns as fit, at most two rows, and never a
 * half-empty last row. If there aren't enough for one full row, it shows what there is.
 */
function SimilarGrid({ groups }: { groups: SeriesGroup[] }) {
  const ref = useRef<HTMLUListElement | null>(null);
  const [cols, setCols] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const tracks = getComputedStyle(el).gridTemplateColumns.split(" ").filter((t) => t && t !== "0px").length;
      setCols(tracks);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rows = cols > 0 ? Math.min(2, Math.floor(groups.length / cols)) : 0;
  const shown = cols === 0 ? groups.slice(0, 8) : rows === 0 ? groups : groups.slice(0, rows * cols);
  return (
              <ul className="similar" ref={ref}>
                {shown.map((g) => (
                  <li key={g.key}>
                    <a href={`#/series/${g.hits[0].mangaId}`} title={g.title}>
                      <img src={thumbnailUrl(g.hits[0].mangaId)} alt="" loading="lazy" width={120} height={174} />
                      <span className="simTitle">{g.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
  );
}
