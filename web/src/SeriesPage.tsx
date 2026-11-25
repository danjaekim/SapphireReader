import { Loading } from "./Loading";
import { toast, toastError } from "./toast";
import { offlineSupported, saveManyOffline, useOfflineChapters } from "./offline";
import { tidyTitle } from "./titles";
import { CompareSheet, type CompareSide } from "./Merges";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { dismissMerge, type SameSeries, addToLibrary, mangaBaka, setMangaBaka, autoMangaBaka, searchMangaBaka, type BakaInfo, type BakaHit, alternatives, favoriteTags, setFavoriteTags, setLiked, setAdultMark, mergeTitle, unmergeTitle, setDisplay, setVersion, setPreferredVersion, VERSION_PRESETS, mergePreviews, rawThumbnailUrl, type DisplayChoice, coversChanged, type MergedName, search as searchSources, chapterPages, categories as loadCategories, markChapters, setSeriesCategories, type Category, removeFromLibrary, series, seriesSaved, setPrimaryTags, similar, type SimilarResult, thumbnailUrl, type Alternative, type ChapterInfo, type SeriesData, type SeriesGroup } from "./api";
import { genreHref, goBack, mbTagHref, readHref, searchHref } from "./route";
import { TrackerLinkCard } from "./Trackers";
import { useSeriesDownloads } from "./useDownloads";
import { resetHiddenCache, useRating } from "./shared";
import { clearPagedCache } from "./usePaged";
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

/** The last live answer per series this tab has seen, so going back to a series shows it at once. */
const seenSeries = new Map<number, SeriesData>();

/** Placeholder shapes in the page's layout while the first answer is on its way. */
function SeriesSkeleton() {
  return (
    <div className="seriesLayout skeletonPage" aria-busy="true" aria-label="Loading series">
      <div className="seriesLeft">
        <div className="skel skelCover" />
        <div className="skel skelLine" style={{ width: "100%", height: 56 }} />
      </div>
      <div className="seriesRight">
        <div className="skel skelLine" style={{ width: "70%", height: 28 }} />
        <div className="skel skelLine" style={{ width: "40%" }} />
        <div className="skelChips">
          {[60, 80, 54, 72, 66].map((w, i) => <span key={i} className="skel" style={{ width: w }} />)}
        </div>
        <div className="skel skelLine" style={{ width: "95%" }} />
        <div className="skel skelLine" style={{ width: "90%" }} />
        <div className="skel skelLine" style={{ width: "60%" }} />
        <ChapterSkeleton rows={6} />
      </div>
    </div>
  );
}

function ChapterSkeleton({ rows }: { rows: number }) {
  return (
    <ul className="chapters skelChapters" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i}>
          <span className="skel skelLine" style={{ width: `${30 + ((i * 17) % 25)}%` }} />
          <span className="skel skelLine" style={{ width: 70 }} />
        </li>
      ))}
    </ul>
  );
}

export function SeriesPage({ mangaId }: { mangaId: number }) {
  const [data, setData] = useState<SeriesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [newestFirst, setNewestFirst] = useState(true);
  const [fullDesc, setFullDesc] = useState(false);
  // "Show more" only when the description is really cut off at this width.
  const descRef = useRef<HTMLParagraphElement | null>(null);
  const [descCut, setDescCut] = useState(false);
  useEffect(() => {
    const el = descRef.current;
    if (!el || fullDesc) return;
    const measure = () => setDescCut(el.scrollHeight > el.clientHeight + 2);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
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
  // Primary tags: picked here (◇ Primary), shown first with an accent ring, matched first by Similar.
  const [primarying, setPrimarying] = useState(false);
  const primaryTags = data?.primaryTags ?? [];
  const primaryKeys = new Set(primaryTags.map((t) => t.toLowerCase()));
  const isPrimary = (t: string) => primaryKeys.has(t.toLowerCase());
  function togglePrimary(tag: string) {
    if (!data) return;
    const before = primaryTags;
    const next = isPrimary(tag) ? before.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...before, tag];
    if (next.length > 8) {
      toastError("Pick at most 8 primary tags.");
      return;
    }
    setData({ ...data, primaryTags: next });
    setPrimaryTags(mangaId, next).then(
      (r) => {
        setData((d) => (d ? { ...d, primaryTags: r.tags } : d));
        setSubsetTry(null);
        setSimilarRun((n) => n + 1);
      },
      () => {
        setData((d) => (d ? { ...d, primaryTags: before } : d));
        toastError("Couldn't save that. Try again.");
      },
    );
  }
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
  // Listings Similar found that look like this same series: offered as a merge instead of a recommendation.
  const [sameSeries, setSameSeries] = useState<SameSeries[]>([]);
  const [comparing, setComparing] = useState<[CompareSide, CompareSide] | null>(null);
  // Chapters saved on this phone for offline reading, and a running "save to phone".
  const deviceSaved = useOfflineChapters();
  const [phoneSaving, setPhoneSaving] = useState<{ done: number; total: number } | null>(null);
  async function saveToPhone(ids: number[]) {
    if (ids.length === 0 || phoneSaving) return;
    setPhoneSaving({ done: 0, total: ids.length });
    try {
      await saveManyOffline(mangaId, ids, (done) => setPhoneSaving({ done, total: ids.length }));
      toast(`Saved ${ids.length} chapter${ids.length === 1 ? "" : "s"} on this device for offline reading.`);
    } catch {
      toastError("Saving to this device stopped. The chapters saved so far are kept; try again for the rest.");
    } finally {
      setPhoneSaving(null);
    }
  }
  const [others, setOthers] = useState<Alternative[] | null>(null);

  // Similar series load on their own once the series itself is up, so the page isn't held back.
  const loaded = data !== null;
  // Primary-tag details and parody/group/character rows from the last Similar answer; `subsetTry` is a
  // smaller set of primary tags you're trying out (not saved); `similarRun` asks again after a change.
  const [primaryInfo, setPrimaryInfo] = useState<SimilarResult["primary"]>(undefined);
  const [facetRows, setFacetRows] = useState<NonNullable<SimilarResult["facetRows"]>>([]);
  const [subsetTry, setSubsetTry] = useState<string[] | null>(null);
  const [similarRun, setSimilarRun] = useState(0);
  useEffect(() => setSubsetTry(null), [mangaId]);
  useEffect(() => {
    setSimilarGroups(null);
    setSameSeries([]);
    if (!loaded) return;
    let cancelled = false;
    similar(mangaId, subsetTry ?? undefined).then(
      (r) => {
        if (cancelled) return;
        setSimilarGroups(r.groups);
        setBasedOn(r.basedOn ?? []);
        setSameSeries(r.sameSeries ?? []);
        setPrimaryInfo(r.primary);
        setFacetRows(r.facetRows ?? []);
      },
      () => !cancelled && setSimilarGroups([]),
    );
    return () => {
      cancelled = true;
    };
  }, [mangaId, loaded, subsetTry, similarRun]);

  // Bumped after a merge, so "Also on" looks again under every merged name.
  const [altRun, setAltRun] = useState(0);
  useEffect(() => {
    setOthers(null);
    alternatives(mangaId).then((r) => setOthers(r.alternatives), () => setOthers([]));
  }, [mangaId, altRun]);

  // Progressive load: the last answer this tab saw (instant when coming back from the reader), then the copy
  // the engine saved (fast), then the live answer from the source site, which replaces whatever is showing.
  const [refreshing, setRefreshing] = useState(false);
  const [staleNote, setStaleNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let gotLive = false;
    const seen = seenSeries.get(mangaId) ?? null;
    let showing = seen !== null;
    setData(seen);
    setError(null);
    setErrorDetail(null);
    setStaleNote(null);
    setRefreshing(true);
    if (!seen) {
      seriesSaved(mangaId).then(
        (d) => {
          if (!live || gotLive) return;
          setData(d);
          showing = true;
        },
        () => undefined,
      );
    }
    series(mangaId).then(
      (d) => {
        gotLive = true;
        if (!live) return;
        setData(d);
        setRefreshing(false);
        // 18+ series aren't kept, so nothing of theirs lingers after locking.
        if (!d.adult) seenSeries.set(mangaId, d);
      },
      (e: unknown) => {
        gotLive = true;
        if (!live) return;
        setRefreshing(false);
        const detail = (e as { detail?: string } | null)?.detail ?? null;
        if (showing) {
          setStaleNote(`Couldn't reach the source just now, so this is the list saved last time.${detail ? ` The source said: ${detail}` : ""}`);
          return;
        }
        setError(e instanceof Error ? e.message : "Couldn't load this series.");
        setErrorDetail(detail);
      },
    );
    return () => {
      live = false;
    };
  }, [mangaId, attempt]);

  // Tab title (left plain for 18+ series, so they stay out of browser history).
  useEffect(() => {
    if (!data || data.adult) return;
    document.title = `${tidyTitle(data.manga.title)} · Sapphire`;
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
      // One chapter's tick says it all; several at once get a word.
      if (chapterIds.length > 1) toast(`Marked ${chapterIds.length} chapters ${read ? "read" : "unread"}.`);
    } catch {
      setData(before);
      toastError(`Couldn't mark ${chapterIds.length === 1 ? "that chapter" : "those chapters"}. Try again.`);
    }
  }

  /** Your own call on 18+: true, false (not 18+), or null (go by the source again). */
  async function changeAdultMark(mark: boolean | null) {
    if (!data) return;
    try {
      await setAdultMark(mangaId, mark);
      setData((d) => (d ? { ...d, markedAdult: mark === true, markedSafe: mark === false, adult: mark ?? d.adultSource === true } : d));
      // Lists and cards decide what to hide from what the server knows, so ask again.
      resetHiddenCache();
      clearPagedCache();
      forgetForYou();
      toast(
        mark === true
          ? "Marked 18+. It's hidden while 18+ mode is locked."
          : mark === false
            ? "Marked not 18+. It shows with your regular series."
            : "Back to following its source on 18+.",
      );
    } catch {
      toastError(mark === true ? "Couldn't mark it. Try again." : "Unlock 18+ mode to change this.");
    }
  }

  const [merging, setMerging] = useState(false);
  // MangaBaka's detailed tags, loaded after the page so it never waits on them.
  const [baka, setBaka] = useState<BakaInfo | null>(null);
  const [bakaPicking, setBakaPicking] = useState(false);
  // One sheet for the less-used controls (18+, version, merges, MangaBaka match), so the page stays readable.
  const [managing, setManaging] = useState(false);
  useEffect(() => {
    if (!managing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setManaging(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [managing]);
  // "Keep it here" on the MangaBaka 18+ question; remembered on this device when 18+ mode is locked (marking needs it unlocked).
  const [bakaAdultKept, setBakaAdultKept] = useState(false);
  useEffect(() => {
    try {
      setBakaAdultKept(localStorage.getItem(`bakaAdultKept.${mangaId}`) === "1");
    } catch {
      setBakaAdultKept(false);
    }
  }, [mangaId]);
  const keepNotAdult = async () => {
    try {
      await setAdultMark(mangaId, false);
      setData((d) => (d ? { ...d, markedSafe: true, markedAdult: false, adult: false } : d));
      toast("Kept with your regular series.");
    } catch {
      try {
        localStorage.setItem(`bakaAdultKept.${mangaId}`, "1");
      } catch {
        // Private mode: it just asks again next time.
      }
      setBakaAdultKept(true);
      toast("Okay, I won't ask again on this device.");
    }
  };
  const [editing, setEditing] = useState(false);
  async function changeMerge(run: () => Promise<{ mergedWith: MergedName[]; title?: string; description?: string | null; about?: SeriesData["about"] }>, done?: string) {
    try {
      const r = await run();
      // The series is shown as its primary listing: take its name (and reload covers, which may have swapped).
      const main = r.title ?? r.mergedWith.find((m) => m.primary)?.title ?? data?.sourceTitle ?? data?.manga.title;
      coversChanged();
      setData((d) =>
        d
          ? {
              ...d,
              mergedWith: r.mergedWith,
              manga: { ...d.manga, title: main ?? d.manga.title, ...(r.description !== undefined ? { description: r.description ?? "" } : {}) },
              ...(r.about ? { about: r.about } : {}),
            }
          : d,
      );
      clearPagedCache();
      setAltRun((n) => n + 1);
      if (done) toast(done);
    } catch {
      toastError("Couldn't change that. Try again.");
    }
  }

  /** After a version label or preference changes: take the new labels, and look at other sources again. */
  async function versionsChanged() {
    const d = await series(mangaId).catch(() => null);
    if (d) setData((x) => (x ? { ...x, mergedWith: d.mergedWith, version: d.version, preferredVersion: d.preferredVersion } : x));
    setAltRun((n) => n + 1);
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
  // A tidied title keeps the full one (with its circle, artist and tags) at the front of the other names.
  const fullTitles = data && tidyTitle(data.manga.title) !== data.manga.title ? [data.manga.title, ...about.altTitles] : about.altTitles;
  const unread = data ? data.chapters.filter((c) => !readIds.has(c.id) && states[c.id]?.status !== "done") : [];
  const notSaved = data ? data.chapters.filter((c) => !states[c.id] || states[c.id].status === "failed") : [];
  const onDevice = new Set((deviceSaved ?? []).map((c) => c.chapterId));
  // The next unread chapters from your place on, not yet on this device.
  const nextForPhone = data
    ? data.chapters.filter((c) => !readIds.has(c.id) && !onDevice.has(c.id) && (!data.progress || c.chapterNumber >= data.progress.chapterNumber)).slice(0, 5)
    : [];
  const phoneLabel = phoneSaving ? `Saving ${phoneSaving.done} of ${phoneSaving.total}…` : null;
  const working = Object.values(states).filter((d) => d.status === "queued" || d.status === "downloading").length;
  const resume = data?.progress ? data.chapters.find((c) => c.id === data.progress!.chapterId) : undefined;
  // Finished the chapter you were on: point at the next one, or say you're caught up.
  const resumeDone = !!resume && readIds.has(resume.id);
  const next = resume && resumeDone ? data!.chapters[data!.chapters.indexOf(resume) + 1] : undefined;
  const caughtUp = resumeDone && !next;

  const hasBakaData = !!data;
  useEffect(() => {
    setBaka(null);
    if (!hasBakaData) return;
    let live = true;
    mangaBaka(mangaId).then((b) => live && setBaka(b)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [mangaId, hasBakaData]);
  const changeBaka = async (run: () => Promise<BakaInfo>, done: string) => {
    try {
      setBaka(await run());
      toast(done);
    } catch (err) {
      toastError(err instanceof Error ? err.message : "Couldn't change that.");
    }
  };

  // Phones: once the title and Read button scroll out of view, a bar pinned to the top keeps them in reach.
  const actionsRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const hasData = !!data;
  useEffect(() => {
    const el = actionsRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setPinned(!e.isIntersecting && e.boundingClientRect.top < 0), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [hasData]);

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
  // The description can name details the source's own fields leave out (tags, author, artist, status, year).
  const info = about.info ?? {};
  const allGenres = data ? [...data.manga.genre, ...(about.tags ?? []).filter((t) => !data.manga.genre.some((g) => canonKey(g) === canonKey(t)))] : [];
  // Primary tags come first.
  const genres = [...allGenres.filter((g) => isPrimary(g)), ...allGenres.filter((g) => !isPrimary(g))];
  // MangaBaka tags the source's own list doesn't have: core and defining ones up front, the rest on request.
  const bakaExtra = baka?.match ? baka.match.tags.filter((t) => !genres.some((g) => canonKey(g) === canonKey(t.name))) : [];
  const bakaMain = [...bakaExtra.filter((t) => isPrimary(t.name)), ...bakaExtra.filter((t) => !isPrimary(t.name) && (t.weight === "core" || t.weight === "defining"))];
  // One tag row: the source's tags, then MangaBaka's central ones (outlined), capped until "+N more"
  // opens everything, MangaBaka's minor tags included.
  const tagsShown = allTags
    ? { source: genres, baka: [...bakaExtra.filter((t) => isPrimary(t.name)), ...bakaExtra.filter((t) => !isPrimary(t.name))] }
    : { source: genres.slice(0, TAG_CAP), baka: bakaMain.slice(0, Math.max(0, TAG_CAP - Math.min(genres.length, TAG_CAP)) + 4) };
  const tagsHidden = allTags ? 0 : genres.length + bakaExtra.length - tagsShown.source.length - tagsShown.baka.length;
  const status = data && statusLabel(data.manga.status) !== "Unknown" ? statusLabel(data.manga.status) : info.status ?? "Unknown";
  const author = data?.manga.author || info.author;
  const artist = data?.manga.artist || info.artist;
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
      {data &&
        createPortal(
        <div className={`pinBar ${pinned ? "show" : ""}`} aria-hidden={!pinned}>
          <button type="button" className="pinBack" aria-label="Back" tabIndex={pinned ? 0 : -1} onClick={() => goBack()}>←</button>
          <img src={thumbnailUrl(mangaId)} alt="" width={32} height={48} />
          <span className="pinTitle">{tidyTitle(data.manga.title)}</span>
          {data.chapters.length > 0 &&
            (caughtUp ? (
              <span className="button small caughtUp">Caught up ✓</span>
            ) : (
              <a className="button small" tabIndex={pinned ? 0 : -1} href={readHref(mangaId, (next ?? resume ?? data.chapters[0]).id)}>
                {resume ? "Continue" : "Start reading"}
              </a>
            ))}
        </div>
      , document.body)}
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
      {!data && !error && <SeriesSkeleton />}
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
                  <div><dt>Status</dt><dd>{status}</dd></div>
                  {info.year && <div><dt>Year</dt><dd>{info.year}</dd></div>}
                  {data.manga.sourceName && <div><dt>Source</dt><dd>{data.manga.sourceName}</dd></div>}
                  {author && <div><dt>Author</dt><dd><People names={author} /></dd></div>}
                  {artist && artist !== author && <div><dt>Artist</dt><dd><People names={artist} /></dd></div>}
                  {!single && data.latest.latestNumber !== null && (
                    <div><dt>Latest</dt><dd>{chapterLabel({ name: "", chapterNumber: data.latest.latestNumber })}</dd></div>
                  )}
                </dl>
                {managing && (
                  <div className="sheetBackdrop" onClick={() => setManaging(false)}>
                    <div className="sheet tall filterSheet manageSheet" role="dialog" aria-modal="true" aria-label="Manage series" onClick={(e) => e.stopPropagation()}>
                      <div className="sheetHandle" aria-hidden="true" />
                      <header className="filterSheetHead">
                        <h3>Manage series</h3>
                        <button type="button" className="iconBtn" aria-label="Close" onClick={() => setManaging(false)}>×</button>
                      </header>
                      <div className="filterSheetBody manageBody">
                        <section>
                          <h4>18+</h4>
                          <p className="muted small">
                            {data.markedAdult ? "You marked this 18+." : data.markedSafe ? "You marked this not 18+." : data.adultSource ? "18+ because its source is." : "Not 18+."}
                          </p>
                          {data.adultSource === true ? (
                            <button type="button" className="button small secondary" onClick={() => changeAdultMark(data.markedSafe ? null : false)}>
                              {data.markedSafe ? "Undo: follow the source again" : "Mark as not 18+"}
                            </button>
                          ) : (
                            <button type="button" className="button small secondary" onClick={() => changeAdultMark(data.markedAdult ? null : true)}>
                              {data.markedAdult ? "Undo: not 18+" : "Mark as 18+"}
                            </button>
                          )}
                        </section>
                        <section>
                          <h4>Version</h4>
                          <VersionChip mangaId={mangaId} version={data.version ?? null} preferred={data.preferredVersion ?? null} onChanged={versionsChanged} />
                        </section>
                        <section>
                          <h4>Other names and listings</h4>
                          {(data.mergedWith ?? []).length > 0 ? (
                            <div className="mergeRow">
                              <span className="muted small">Also listed as</span>
                              {(data.mergedWith ?? [])
                                .filter((m) => !m.primary)
                                .map((m) => (
                                  <span key={m.key} className="mergedName">
                                    <span>
                                      {tidyTitle(m.title)}
                                      {m.own && <span className="muted"> (this source)</span>}
                                    </span>
                                    {!m.canon && (
                                      <button type="button" aria-label={`Unmerge ${m.title}`} title="Unmerge" onClick={() => changeMerge(() => unmergeTitle(mangaId, m.key), `Unmerged ${tidyTitle(m.title)}.`)}>×</button>
                                    )}
                                  </span>
                                ))}
                            </div>
                          ) : (
                            <p className="muted small">Listed under another name somewhere? Merge them so they count as one series.</p>
                          )}
                          <div className="manageActions">
                            {(data.mergedWith ?? []).length > 0 && (
                              <button type="button" className="button small secondary" onClick={() => { setManaging(false); setEditing(true); }}>Name, cover &amp; description</button>
                            )}
                            <button type="button" className="button small secondary" onClick={() => { setManaging(false); setMerging(true); }}>
                              {(data.mergedWith ?? []).length > 0 ? "Merge another" : "Merge"}
                            </button>
                          </div>
                        </section>
                        <section>
                          <h4>MangaBaka</h4>
                          <p className="muted small">
                            {baka?.match ? (
                              <>
                                Matched to <a href={baka.match.url} target="_blank" rel="noreferrer">{baka.match.title}</a>
                                {baka.match.manual ? " (picked by you)" : ""}
                                {baka.match.contentRating ? `, rated ${baka.match.contentRating}` : ""}.
                              </>
                            ) : baka?.status === "none-manual" ? (
                              "Marked as not on MangaBaka."
                            ) : baka?.status === "unavailable" ? (
                              "MangaBaka isn't answering right now."
                            ) : baka ? (
                              "Not found on MangaBaka."
                            ) : (
                              "Looking it up…"
                            )}
                          </p>
                          <button type="button" className="button small secondary" onClick={() => { setManaging(false); setBakaPicking(true); }}>
                            {baka?.match ? "Change match" : "Find it"}
                          </button>
                        </section>
                      </div>
                    </div>
                  </div>
                )}
                {bakaPicking && (
                  <BakaSheet
                    title={tidyTitle(data.manga.title)}
                    current={baka}
                    onClose={() => setBakaPicking(false)}
                    onPick={(id) => {
                      setBakaPicking(false);
                      void changeBaka(() => setMangaBaka(mangaId, id), id === null ? "Marked as not on MangaBaka." : "MangaBaka entry set.");
                    }}
                    onAuto={() => {
                      setBakaPicking(false);
                      void changeBaka(() => autoMangaBaka(mangaId), "Back to finding it automatically.");
                    }}
                  />
                )}
                {editing && (data.mergedWith ?? []).length > 0 && (
                  <DisplaySheet mangaId={mangaId} listings={data.mergedWith ?? []} preferred={data.preferredVersion ?? null} onChange={(c) => changeMerge(() => setDisplay(mangaId, c))} onVersions={versionsChanged} onClose={() => setEditing(false)} />
                )}
                {merging && (
                  <MergeSheet
                    title={data.manga.title}
                    selfIds={[mangaId, ...(data.mergedWith ?? []).map((m) => m.mangaId).filter((x): x is number => typeof x === "number"), ...(others ?? []).map((a) => a.mangaId)]}
                    selfTitles={[data.manga.title, data.sourceTitle ?? data.manga.title, ...(data.mergedWith ?? []).map((m) => m.title)]}
                    onClose={() => setMerging(false)}
                    onPick={(t, otherId) => {
                      setMerging(false);
                      void changeMerge(() => mergeTitle(mangaId, t, otherId), `Merged with ${tidyTitle(t)}.`);
                    }}
                  />
                )}
                {comparing && (
                  <CompareSheet
                    a={comparing[0]}
                    b={comparing[1]}
                    onClose={() => setComparing(null)}
                    onMerged={() => {
                      const otherId = comparing[1].mangaId;
                      setComparing(null);
                      setSameSeries((l) => l.filter((y) => y.mangaId !== otherId));
                      void changeMerge(async () => {
                        const d = await series(mangaId);
                        return { mergedWith: d.mergedWith ?? [], title: d.manga.title, description: d.manga.description ?? null, about: d.about };
                      }).then(versionsChanged);
                    }}
                  />
                )}
                {others && others.length > 0 && (
                  <div className="card">
                    <h3>Also on</h3>
                    <ul className="sources alsoOn">
                      {others.map((o) => {
                        const ahead = o.latestNumber !== null && data.latest.latestNumber !== null && o.latestNumber > data.latest.latestNumber;
                        const by = ahead ? Math.floor(o.latestNumber! - data.latest.latestNumber!) : 0;
                        return (
                          <li key={o.mangaId} className={ahead ? "best" : undefined}>
                            <span className="alsoOnName">
                              <a href={`#/series/${o.mangaId}`}>{o.sourceName}</a>
                              {o.version && (
                                <span className={`tag verTag ${data.preferredVersion && o.version.toLowerCase() === data.preferredVersion.toLowerCase() ? "pref" : ""}`}>{o.version}</span>
                              )}
                            </span>
                            <span className={`alsoOnCh ${ahead ? "ahead" : "muted"}`} title={ahead ? `${by > 0 ? `${by} chapter${by === 1 ? "" : "s"}` : "Further"} ahead of this listing` : undefined}>
                              {o.latestNumber !== null ? chapterLabel({ name: "", chapterNumber: o.latestNumber }) : "no numbers"}
                              {ahead && <span className="aheadBadge">{by > 0 ? `+${by}` : "ahead"}</span>}
                            </span>
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
                <h2>{tidyTitle(data.manga.title)}</h2>
                {(fullTitles.length > 0) && <AltTitles titles={fullTitles} open={fullAlt} onToggle={() => setFullAlt((v) => !v)} />}
                {(rank || ratings.length > 0 || data.version) && (
                  <ul className="ratingRow">
                    {data.version && (
                      <li className={`tag verTag ${data.preferredVersion && data.version.toLowerCase() === data.preferredVersion.toLowerCase() ? "pref" : ""}`} title="This listing's version">{data.version}</li>
                    )}
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
                    <p className={`desc ${fullDesc ? "" : "clamped"}`} ref={descRef}>{about.body}</p>
                    {(descCut || fullDesc) && (
                      <button type="button" className="linkish" onClick={() => setFullDesc((v) => !v)}>
                        {fullDesc ? "Show less" : "Show more"}
                      </button>
                    )}
                  </div>
                )}
                {(genres.length > 0 || bakaExtra.length > 0) && (
                  <div className="introTags">
                    <ul className={`genres ${starring || primarying ? "starring" : ""}`} aria-label="Tags">
                      {(starring || primarying ? genres : tagsShown.source).map((g) => {
                        const fav = favKeys.has(canonKey(g));
                        const prim = isPrimary(g);
                        const marks = `${fav ? "fav" : ""} ${prim ? "primary" : ""}`;
                        return (
                          <li key={g}>
                            {starring ? (
                              <button type="button" className={`tag starTag ${marks}`} aria-pressed={fav} onClick={() => toggleFav(g)}>
                                <span aria-hidden="true">{fav ? "★" : "☆"}</span> {g}
                              </button>
                            ) : primarying ? (
                              <button type="button" className={`tag starTag primaryPick ${marks}`} aria-pressed={prim} onClick={() => togglePrimary(g)}>
                                <span aria-hidden="true">{prim ? "◆" : "◇"}</span> {g}
                              </button>
                            ) : (
                              <a className={`tag ${marks}`} href={genreHref(g, data.manga.id, data.adult)} title={[prim && "Primary tag: Similar matches on it first", fav && "One of your favorite tags"].filter(Boolean).join(". ") || undefined}>
                                {fav && <span aria-hidden="true">★ </span>}
                                {g}
                              </a>
                            )}
                          </li>
                        );
                      })}
                      {!starring &&
                        (primarying ? bakaExtra : tagsShown.baka).map((t) => {
                          const prim = isPrimary(t.name);
                          return (
                            <li key={t.path}>
                              {primarying ? (
                                <button type="button" className={`tag starTag primaryPick bakaTag ${t.weight} ${prim ? "primary" : ""}`} aria-pressed={prim} onClick={() => togglePrimary(t.name)}>
                                  <span aria-hidden="true">{prim ? "◆" : "◇"}</span> {t.name}
                                </button>
                              ) : (
                                t.id ? (
                                  <a className={`tag bakaTag ${t.weight} ${prim ? "primary" : ""}`} href={mbTagHref({ id: t.id, name: t.name }, data.adult || baka?.match?.contentRating === "erotica" || baka?.match?.contentRating === "pornographic")} title={`${t.path} (${WEIGHT_LABEL[t.weight]}, from MangaBaka)${prim ? ". Primary tag" : ""}. Tap for series with this tag.`}>{t.name}</a>
                                ) : (
                                  <span className={`tag bakaTag ${t.weight} ${prim ? "primary" : ""}`} title={`${t.path} (${WEIGHT_LABEL[t.weight]}, from MangaBaka)${prim ? ". Primary tag" : ""}`}>{t.name}</span>
                                )
                              )}
                            </li>
                          );
                        })}
                      {!starring && !primarying && tagsHidden > 0 && (
                        <li>
                          <button type="button" className="tag moreTag" onClick={() => setAllTags(true)}>+{tagsHidden} more</button>
                        </li>
                      )}
                      {!starring && !primarying && allTags && (
                        <li>
                          <button type="button" className="tag moreTag" onClick={() => setAllTags(false)}>Fewer</button>
                        </li>
                      )}
                      {favs && genres.length > 0 && !primarying && (
                        <li>
                          <button type="button" className="tag moreTag" onClick={() => setStarring((v) => !v)} title="Favorite tags count strongly toward For you">
                            {starring ? "Done" : <><span aria-hidden="true">☆</span> Favorites</>}
                          </button>
                        </li>
                      )}
                      {!starring && (
                        <li>
                          <button type="button" className="tag moreTag" onClick={() => setPrimarying((v) => !v)} title="Pick the few tags this series is really about; Similar matches on them first">
                            {primarying ? "Done" : <><span aria-hidden="true">◇</span> Primary</>}
                          </button>
                        </li>
                      )}
                    </ul>
                    {primarying && <p className="tagsNote muted small">Tap the tags this series is really about (up to 8), including parody, group or character names below. Similar matches on them first.</p>}
                    {bakaExtra.length > 0 && baka?.match && !starring && !primarying && (
                      <p className="tagsNote muted small">
                        Outlined tags are from <a href={baka.match.url} target="_blank" rel="noreferrer">MangaBaka</a>
                        {baka.match.contentRating && baka.match.contentRating !== "safe" ? ` (rated ${baka.match.contentRating})` : ""}.
                      </p>
                    )}
                  </div>
                )}
                {(about.facets ?? []).map((f) => (
                  <div key={f.label} className="facet">
                    <span className="facetLabel muted small">{f.label}</span>
                    <ul className="genres">
                      {[...f.values.filter((v) => isPrimary(v)), ...f.values.filter((v) => !isPrimary(v))].map((v) => (
                        <li key={v}>
                          {primarying && f.label !== "Languages" && f.label !== "Categories" ? (
                            <button type="button" className={`tag starTag primaryPick facetTag ${isPrimary(v) ? "primary" : ""}`} aria-pressed={isPrimary(v)} onClick={() => togglePrimary(v)}>
                              <span aria-hidden="true">{isPrimary(v) ? "◆" : "◇"}</span> {v}
                            </button>
                          ) : (
                            <a className={`tag facetTag ${isPrimary(v) ? "primary" : ""}`} href={searchHref(v)} title={`Search for ${v}${isPrimary(v) ? ". Primary tag" : ""}`}>{v}</a>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
                {baka?.match && (baka.match.contentRating === "erotica" || baka.match.contentRating === "pornographic") && !data.adult && !data.markedSafe && !bakaAdultKept && (
                  <div className="bakaAdult small" role="note">
                    <span>MangaBaka rates this {baka.match.contentRating}. Move it to 18+?</span>
                    <span className="bakaAdultActions">
                      <button type="button" className="button small" onClick={() => changeAdultMark(true)}>Mark as 18+</button>
                      <button type="button" className="button small secondary" onClick={() => void keepNotAdult()} title="Keeps it out of 18+ and stops this question">Keep it here</button>
                    </span>
                  </div>
                )}
              </div>

              <div className="seriesActions" ref={actionsRef}>
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
                    aria-label="Like"
                    title={data.liked ? "Liked: For you suggests more like this (tap to undo)" : "Like it: For you suggests more like this"}
                  >
                    <span aria-hidden="true">{data.liked ? "♥" : "♡"}</span>
                    <span className="likeLabel"> {data.liked ? "Liked" : "Like"}</span>
                  </button>
                  <button type="button" className="button secondary manageBtn" onClick={() => setManaging(true)} aria-haspopup="dialog" aria-label="Manage series" title="18+, version, merged listings, MangaBaka match">
                    <span aria-hidden="true">⋯</span>
                    <span className="manageLabel"> Manage</span>
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

              {data.chapters.length === 1 && !data.saved ? (
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
                    {refreshing && (
                      <span className="checkingSource muted small" role="status">
                        <span className="miniSpin" aria-hidden="true" /> Checking {data.manga.sourceName ?? "the source"} for new chapters…
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
                    <button
                      type="button"
                      className="sortPill"
                      onClick={() => setNewestFirst((v) => !v)}
                      aria-label={`Sorted ${newestFirst ? "newest" : "oldest"} first. Tap to reverse.`}
                    >
                      {/* Arrow points down for newest first (latest at the top, going back), up for oldest first. */}
                      <svg className="sortIcon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        {newestFirst ? <path d="M8 3v10M4 9l4 4 4-4" /> : <path d="M8 13V3M4 7l4-4 4 4" />}
                      </svg>
                      {/* Both labels share the cell, so the button is as wide as the longer one whichever shows. */}
                      <span className="sortLabel">
                        <span className={newestFirst ? "" : "off"}>Newest first</span>
                        <span className={newestFirst ? "off" : ""}>Oldest first</span>
                      </span>
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
                      {offlineSupported() && (
                        <button
                          type="button"
                          className="button small secondary"
                          disabled={!!phoneSaving || picked.every((c) => onDevice.has(c.id))}
                          onClick={() => { void saveToPhone(picked.filter((c) => !onDevice.has(c.id)).map((c) => c.id)); clearPicks(); }}
                        >
                          {phoneLabel ?? "Save to phone"}
                        </button>
                      )}
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
                    {offlineSupported() && (
                      <button type="button" className="button small secondary" disabled={!!phoneSaving || nextForPhone.length === 0} onClick={() => void saveToPhone(nextForPhone.map((c) => c.id))}>
                        {phoneLabel ?? `📱 Save next ${nextForPhone.length || 5} to phone`}
                      </button>
                    )}
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
                {staleNote && <p className="muted small staleNote">{staleNote} <button type="button" className="linkish" onClick={() => setAttempt((n) => n + 1)}>Try again</button></p>}
                {data.chapters.length === 0 && refreshing && <ChapterSkeleton rows={8} />}
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
                          {onDevice.has(c.id) && <span className="chOffline" title="Saved on this device" aria-label="Saved on this device"> 📱</span>}
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

          {sameSeries.length > 0 && data && (
            <div className="card sameSeriesCard">
              <h3>Same series, another listing?</h3>
              <p className="muted small">These look like {tidyTitle(data.manga.title)} under a slightly different name. Merge them to keep one series with all its sources.</p>
              <ul className="mergeList">
                {sameSeries.map((x) => (
                  <li key={x.mangaId}>
                    <img src={thumbnailUrl(x.mangaId)} alt="" loading="lazy" width={40} height={58} />
                    <span className="mergeInfo">
                      <a href={`#/series/${x.mangaId}`}><strong>{tidyTitle(x.title)}</strong></a>
                      <span className="muted small">
                        {x.sourceName}
                        {x.label && <span className="tag verTag">{x.label}</span>}
                      </span>
                    </span>
                    <span className="manageActions">
                      <button
                        type="button"
                        className="button small"
                        onClick={() =>
                          setComparing([
                            { mangaId, title: data.sourceTitle ?? data.manga.title, sourceName: data.manga.sourceName ?? null, label: data.version ?? x.selfLabel },
                            { mangaId: x.mangaId, title: x.title, sourceName: x.sourceName, label: x.label },
                          ])
                        }
                      >
                        Compare &amp; merge
                      </button>
                      <button
                        type="button"
                        className="button small secondary"
                        onClick={() => {
                          setSameSeries((l) => l.filter((y) => y.mangaId !== x.mangaId));
                          dismissMerge({ a: data.sourceTitle ?? data.manga.title, b: x.title }).catch(() => undefined);
                        }}
                      >
                        Not the same
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {similarGroups === null && (
            <div className="card similarCard" aria-busy="true">
              <h3>Similar series</h3>
              <p className="muted small">Finding similar series…</p>
              <div className="skelGrid">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i}>
                    <div className="skel skelCard" />
                    <div className="skel skelLine" style={{ width: "80%" }} />
                  </div>
                ))}
              </div>
            </div>
          )}
          {similarGroups && (similarGroups.length > 0 || primaryInfo) && (
            <div className="card similarCard">
              <h3>Similar series</h3>
              {primaryInfo ? (
                <div className="primaryNote muted small">
                  {primaryInfo.matchedAll ? (
                    <p>Matched on {subsetTry ? "" : "your primary tags: "}{basedOn.join(", ")}.</p>
                  ) : (
                    <p>
                      Nothing on your sources has all of {primaryInfo.tags.join(", ")}.
                      {primaryInfo.subsets.length > 0 ? ` Showing series with ${primaryInfo.subsets[0].tags.join(", ")}.` : " Showing the usual matches instead."}
                    </p>
                  )}
                  {(primaryInfo.subsets.length > 1 || subsetTry) && (
                    <div className="chips subsetChips" aria-label="Try fewer primary tags">
                      {subsetTry && (
                        <button type="button" className="chip small" onClick={() => setSubsetTry(null)}>All primary tags</button>
                      )}
                      {primaryInfo.subsets.slice(subsetTry ? 0 : 1).map((x) => (
                        <button key={x.tags.join("|")} type="button" className="chip small" onClick={() => setSubsetTry(x.tags)} title={`${x.groups.length} found`}>
                          {x.tags.join(" + ")}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                basedOn.length > 0 && <p className="muted small">Matched mostly on {basedOn.join(", ")}.</p>
              )}
              {similarGroups.length > 0 ? <SimilarGrid groups={similarGroups} /> : <p className="muted small">Nothing found.</p>}
            </div>
          )}
          {facetRows.map((r) => (
            <div key={`${r.label}|${r.value}`} className="card similarCard facetRow">
              <h3>
                {r.label}: <em>{r.value}</em>
              </h3>
              <SimilarGrid groups={r.groups} />
            </div>
          ))}
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
                      <img src={thumbnailUrl(g.cover ?? g.hits[0].mangaId)} alt="" loading="lazy" width={120} height={174} />
                      <span className="simTitle">{tidyTitle(g.title)}</span>
                    </a>
                  </li>
                ))}
              </ul>
  );
}

/** Find the other listing of this series (by any words in its name) and merge it in. */
/** One merged copy's version label in the Edit sheet, saved when you leave the field; ★ makes it the version to stay on. */
function VersionRow({ listing, where, preferred, parentId, onChanged }: { listing: MergedName; where: string; preferred: string | null; parentId: number; onChanged: () => Promise<void> }) {
  const [text, setText] = useState(listing.version ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(listing.version ?? ""), [listing.version]);
  const isPref = !!listing.version && !!preferred && listing.version.toLowerCase() === preferred.toLowerCase();
  const id = listing.mangaId;
  const save = async () => {
    if (id == null || text.trim() === (listing.version ?? "")) return;
    setBusy(true);
    await setVersion(id, text.trim() || null).catch(() => null);
    await onChanged();
    setBusy(false);
  };
  const star = async () => {
    if (!listing.version) return;
    setBusy(true);
    await setPreferredVersion(parentId, isPref ? null : listing.version).catch(() => null);
    await onChanged();
    setBusy(false);
  };
  return (
    <li className="versionRow">
      <span className="mergeInfo">
        <strong title={listing.title}>{tidyTitle(listing.title)}</strong>
        {where && <span className="muted small">{where}</span>}
      </span>
      {id == null ? (
        <span className="muted small">Merge it again to label it</span>
      ) : (
        <>
          <input
            type="text"
            list="versionPresets"
            value={text}
            placeholder="Version"
            aria-label={`Version of ${listing.title}`}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => void save()}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          />
          <button type="button" className={`starBtn ${isPref ? "on" : ""}`} disabled={busy || !listing.version} aria-pressed={isPref} title={isPref ? "Preferred version (tap to undo)" : "Prefer this version"} aria-label={isPref ? "Preferred version" : "Prefer this version"} onClick={() => void star()}>
            {isPref ? "★" : "☆"}
          </button>
        </>
      )}
    </li>
  );
}

/** The version of the copy you're looking at, with a quick way to label it and make it the one to stay on. */
function VersionChip({ mangaId, version, preferred, onChanged }: { mangaId: number; version: string | null; preferred: string | null; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(version ?? "");
  const isPref = !!version && !!preferred && version.toLowerCase() === preferred.toLowerCase();
  const [prefer, setPrefer] = useState(isPref);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(version ?? "");
    setPrefer(isPref);
  }, [version, isPref, open]);
  const save = async (label: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      await setVersion(mangaId, label);
      if (label && prefer !== isPref) await setPreferredVersion(mangaId, prefer ? label : null);
      else if (!label && isPref) await setPreferredVersion(mangaId, null);
      await onChanged();
      setOpen(false);
    } catch {
      setErr("Couldn't save that. Try again.");
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <p className="versionLine">
        <span className="muted">Version</span>{" "}
        {version ? <span className={`tag verTag ${isPref ? "pref" : ""}`} title={isPref ? "The version you stay on" : undefined}>{version}</span> : <span className="muted">not labeled</span>}{" "}
        <button type="button" className="linkish" onClick={() => setOpen(true)}>{version ? "Edit" : "Add label"}</button>
      </p>
    );
  }
  return (
    <div className="versionEdit" role="group" aria-label="Version of this copy">
      <div className="chips">
        {VERSION_PRESETS.map((v) => (
          <button key={v} type="button" className={`chip ${text.toLowerCase() === v.toLowerCase() ? "on" : ""}`} onClick={() => setText(v)}>{v}</button>
        ))}
      </div>
      <input type="text" value={text} maxLength={30} placeholder="Or type a label" aria-label="Version label" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save(text.trim() || null)} />
      <label className="versionPref">
        <input type="checkbox" checked={prefer} disabled={!text.trim()} onChange={(e) => setPrefer(e.target.checked)} /> Stay on this version when others are ahead
      </label>
      <div className="versionActions">
        <button type="button" className="button small" disabled={busy || !text.trim()} onClick={() => void save(text.trim())}>Save</button>
        {version && <button type="button" className="button small secondary" disabled={busy} onClick={() => void save(null)}>Remove label</button>}
        <button type="button" className="linkish" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {err && <p className="bad small">{err}</p>}
    </div>
  );
}

/**
 * Pick, separately, which of a merged series' listings supplies its name, its cover and its description.
 * Each choice applies as soon as it's tapped.
 */
function DisplaySheet({ mangaId, listings, preferred, onChange, onVersions, onClose }: { mangaId: number; listings: MergedName[]; preferred: string | null; onChange: (c: DisplayChoice) => Promise<void>; onVersions: () => Promise<void>; onClose: () => void }) {
  const [previews, setPreviews] = useState<Record<string, { sourceName: string | null; description: string; available: boolean }> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    mergePreviews(mangaId).then(
      (r) => live && setPreviews(Object.fromEntries(r.items.map((i) => [i.key, i]))),
      () => live && setPreviews({}),
    );
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      live = false;
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [mangaId, onClose]);
  const choose = async (c: DisplayChoice) => {
    setBusy(true);
    await onChange(c);
    setBusy(false);
  };
  const where = (m: MergedName) => previews?.[m.key]?.sourceName ?? (m.own ? "this source" : "");
  const descChosen = listings.some((m) => m.shows?.description);
  return (
    <div className="sheetBackdrop" onClick={onClose}>
      <div className="sheet tall filterSheet mergeSheet" role="dialog" aria-modal="true" aria-label="Name, cover and description" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" aria-hidden="true" />
        <header className="filterSheetHead">
          <h3>Name, cover &amp; description</h3>
          <button type="button" className="iconBtn" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <p className="muted small">Each one can come from a different listing. Chapters and reading progress aren't affected.</p>
        <div className="filterSheetBody displayBody">
          <h4>Versions</h4>
          <p className="muted small versionHelp">Label each copy (Uncensored, Censored…) and star the one to stay on. Sapphire only offers another version when it has chapters yours doesn't.</p>
          <ul className="mergeList versionList">
            {listings.map((m) => (
              <VersionRow key={`v-${m.key}`} listing={m} where={where(m)} preferred={preferred} parentId={mangaId} onChanged={onVersions} />
            ))}
          </ul>
          <datalist id="versionPresets">{VERSION_PRESETS.map((v) => <option key={v} value={v} />)}</datalist>
          <h4>Name</h4>
          <ul className="mergeList pickList" role="radiogroup" aria-label="Name">
            {listings.map((m) => (
              <li key={`n-${m.key}`}>
                <button type="button" role="radio" aria-checked={!!m.shows?.title} disabled={busy} className={`pickRow ${m.shows?.title ? "on" : ""}`} onClick={() => void choose({ title: m.key })}>
                  <span className="pickDot" aria-hidden="true" />
                  <span className="mergeInfo"><strong title={m.title}>{tidyTitle(m.title)}</strong>{where(m) && <span className="muted small">{where(m)}</span>}</span>
                </button>
              </li>
            ))}
          </ul>
          <h4>Cover</h4>
          <ul className="mergeList pickList" role="radiogroup" aria-label="Cover">
            {listings.map((m) => (
              <li key={`c-${m.key}`}>
                <button type="button" role="radio" aria-checked={!!m.shows?.cover} disabled={busy || m.mangaId == null} className={`pickRow ${m.shows?.cover ? "on" : ""}`} onClick={() => void choose({ cover: m.key })}>
                  <span className="pickDot" aria-hidden="true" />
                  {m.mangaId != null ? <img src={rawThumbnailUrl(m.mangaId)} alt="" loading="lazy" width={40} height={58} /> : <span className="pickNoCover muted small">No cover</span>}
                  <span className="mergeInfo"><strong>{tidyTitle(m.title)}</strong>{where(m) && <span className="muted small">{where(m)}</span>}</span>
                </button>
              </li>
            ))}
          </ul>
          <h4>Description</h4>
          <ul className="mergeList pickList" role="radiogroup" aria-label="Description">
            <li>
              <button type="button" role="radio" aria-checked={!descChosen} disabled={busy} className={`pickRow ${!descChosen ? "on" : ""}`} onClick={() => void choose({ description: null })}>
                <span className="pickDot" aria-hidden="true" />
                <span className="mergeInfo"><strong>Each source's own</strong><span className="muted small">Shows the description of the source you opened</span></span>
              </button>
            </li>
            {listings.map((m) => {
              const p = previews?.[m.key];
              const usable = m.mangaId != null && p?.available !== false;
              return (
                <li key={`d-${m.key}`}>
                  <button type="button" role="radio" aria-checked={descChosen && !!m.shows?.description} disabled={busy || !usable} className={`pickRow ${descChosen && m.shows?.description ? "on" : ""}`} onClick={() => void choose({ description: m.key })}>
                    <span className="pickDot" aria-hidden="true" />
                    <span className="mergeInfo">
                      <strong>{where(m) || tidyTitle(m.title)}</strong>
                      <span className="muted small pickSnippet">{previews === null ? "Loading…" : p?.description || (usable ? "No description." : "Couldn't load this one.")}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

/** A title as the server compares them: no case, accents or punctuation. */
const looseKey = (t: string) => t.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

const WEIGHT_LABEL: Record<string, string> = { core: "core to the story", defining: "defining", recurrent: "recurring", incidental: "incidental", unweighted: "unrated" };

/** Pick which MangaBaka entry a series is, say it isn't there, or go back to automatic. */
function BakaSheet({ title, current, onPick, onAuto, onClose }: { title: string; current: BakaInfo | null; onPick: (id: number | null) => void; onAuto: () => void; onClose: () => void }) {
  const [q, setQ] = useState(title);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<BakaHit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  const run = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setFound((await searchMangaBaka(q.trim())).hits);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  };
  const manual = current?.match?.manual || current?.status === "none-manual";
  return (
    <div className="sheetBackdrop" onClick={onClose}>
      <div className="sheet tall filterSheet mergeSheet" role="dialog" aria-modal="true" aria-label="MangaBaka entry" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" aria-hidden="true" />
        <header className="filterSheetHead">
          <h3>MangaBaka entry</h3>
          <button type="button" className="iconBtn" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <p className="muted small">
          {current?.match ? <>Now: <a href={current.match.url} target="_blank" rel="noreferrer">{current.match.title}</a>{current.match.manual ? " (picked by you)" : " (found automatically)"}. </> : null}
          Search by name, or paste its MangaBaka address or number.
        </p>
        <form className="mergeFind" onSubmit={run}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, address or number" aria-label="MangaBaka name, address or number" autoFocus />
          <button type="submit" className="button small" disabled={busy || !q.trim()}>{busy ? "Searching…" : "Search"}</button>
        </form>
        <div className="filterSheetBody">
          {error && <p className="bad small">{error}</p>}
          {found && found.length === 0 && <p className="muted">Nothing found.</p>}
          {found && found.length > 0 && (
            <ul className="mergeList">
              {found.map((h) => (
                <li key={h.id}>
                  <span className="mergeInfo">
                    <strong>{h.title}</strong>
                    <span className="muted small">{[h.type, h.year, ...h.titles.filter((t) => t !== h.title).slice(0, 2)].filter(Boolean).join(" · ")}</span>
                    <a className="small" href={h.url} target="_blank" rel="noreferrer">Open on MangaBaka</a>
                  </span>
                  <button type="button" className="button small secondary" onClick={() => onPick(h.id)} disabled={current?.match?.id === h.id}>{current?.match?.id === h.id ? "Current" : "Use"}</button>
                </li>
              ))}
            </ul>
          )}
          <div className="sheetActions">
            {current?.status !== "none-manual" && <button type="button" className="button small secondary" onClick={() => onPick(null)}>It isn't on MangaBaka</button>}
            {manual && <button type="button" className="button small secondary" onClick={onAuto}>Find it automatically</button>}
          </div>
        </div>
      </div>
    </div>
  );
}

function MergeSheet({ title, selfIds, selfTitles, onPick, onClose }: { title: string; selfIds: number[]; selfTitles: string[]; onPick: (title: string, mangaId: number) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<SeriesGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  const run = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2 && !/^\d+$/.test(q.trim())) return;
    setBusy(true);
    setError(null);
    try {
      // A series number (or a pasted /series/1234 address) finds that exact listing.
      const idMatch = q.trim().match(/^(?:.*\/series\/)?(\d+)\/?$/);
      if (idMatch) {
        const id = Number(idMatch[1]);
        if (selfIds.includes(id)) {
          setFound([]);
          setError("That's this series, or one already merged with it.");
          return;
        }
        const d = await series(id).catch(() => null);
        if (!d) {
          setFound([]);
          setError(`No series found with number ${id}.`);
          return;
        }
        const raw = d.sourceTitle ?? d.manga.title;
        setFound([{ key: `id-${id}`, title: raw, hits: [{ mangaId: id, sourceId: String(d.manga.sourceId ?? ""), sourceName: d.manga.sourceName ?? "Source", title: raw, thumbnailUrl: null }] }]);
        return;
      }
      const r = await searchSources(q.trim());
      // Leave out this series itself and everything already merged with it (including its other sources).
      const ids = new Set(selfIds);
      const names = new Set(selfTitles.map(looseKey));
      setFound(r.groups.filter((g) => !g.hits.some((h) => ids.has(h.mangaId)) && !names.has(looseKey(g.title)) && !g.hits.some((h) => names.has(looseKey(h.title)))));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sheetBackdrop" onClick={onClose}>
      <div className="sheet tall filterSheet mergeSheet" role="dialog" aria-modal="true" aria-label="Merge with another listing" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" aria-hidden="true" />
        <header className="filterSheetHead">
          <h3>Merge with another listing</h3>
          <button type="button" className="iconBtn" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <p className="muted small">
          Find how another source names <strong>{tidyTitle(title)}</strong>, by name or by the number in its address (/series/1234). Once merged, both show up as one series with all their sources, and your reading carries across.
        </p>
        <form className="mergeFind" onSubmit={run}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="The other name, or its series number" aria-label="The other name or series number" autoFocus />
          <button type="submit" className="button small" disabled={busy || (q.trim().length < 2 && !/^\d+$/.test(q.trim()))}>{busy ? "Searching…" : "Search"}</button>
        </form>
        <div className="filterSheetBody">
          {error && <p className="bad small">{error}</p>}
          {found && found.length === 0 && <p className="muted">Nothing found under that name.</p>}
          {found && found.length > 0 && (
            <ul className="mergeList">
              {found.map((g) => (
                <li key={g.key}>
                  <img src={thumbnailUrl(g.cover ?? g.hits[0].mangaId)} alt="" loading="lazy" width={40} height={58} />
                  <span className="mergeInfo">
                    <strong>{tidyTitle(g.title)}</strong>
                    <span className="muted small">{[...new Set(g.hits.map((h) => h.sourceName))].join(", ")}</span>
                  </span>
                  <button type="button" className="button small secondary" onClick={() => onPick(g.hits[0].title, g.hits[0].mangaId)}>Merge</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
