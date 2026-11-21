import { Loading } from "./Loading";
import { useEffect, useRef, useState, type MouseEvent, type TouchEvent } from "react";
import { chapterPages, saveProgress, series, setReaderPrefs, type PrefsScope, type ReaderPrefs, type SeriesData } from "./api";
import { DownloadButton } from "./SeriesPage";
import { backTo, readHref, replaceHash, seriesHref } from "./route";
import { useSeriesDownloads } from "./useDownloads";
import { OfflineButton } from "./offline";

const chapterText = (c: { chapterNumber: number; name: string }) =>
  c.chapterNumber >= 0 ? `Chapter ${Number.isInteger(c.chapterNumber) ? c.chapterNumber : c.chapterNumber.toFixed(1)}` : c.name;

/**
 * The reader. Webtoons scroll; manga can be read a page at a time (left-to-right or right-to-left),
 * chosen per series. The bars stay hidden while reading; tap the middle of the page to show them.
 */
export function Reader({ mangaId, chapterId, startPage, onMenu }: { mangaId: number; chapterId: number; startPage?: number; onMenu: () => void }) {
  const [chrome, setChrome] = useState(false);
  const [data, setData] = useState<SeriesData | null>(null);
  const [pages, setPages] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  // Pages that failed to load: negative = showing "Try again"; positive = retry attempt number (busts the cache).
  const [failed, setFailed] = useState<Record<number, number>>({});
  const [loadedPages, setLoadedPages] = useState<Record<number, boolean>>({});
  const [prefs, setPrefs] = useState<ReaderPrefs>({ mode: "scroll", direction: "ltr" });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Paged mode: one step past the last page shows the end-of-chapter screen.
  const [atEnd, setAtEnd] = useState(false);

  useEffect(() => {
    series(mangaId).then((d) => {
      setData(d);
      if (d.reader) setPrefs({ mode: d.reader.mode, direction: d.reader.direction });
    }, () => {});
  }, [mangaId]);

  useEffect(() => {
    setPages(null);
    setError(null);
    setFailed({});
    setLoadedPages({});
    setCurrent(0);
    setAtEnd(false);
    setChrome(false);
    window.scrollTo(0, 0);
    chapterPages(chapterId).then(
      (r) => setPages(r.pages),
      (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load this chapter."),
    );
  }, [chapterId]);

  const paged = prefs.mode === "paged";
  const rtl = paged && prefs.direction === "rtl";
  const { states, download } = useSeriesDownloads(mangaId);
  const stripRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const target = useRef<{ index: number; offset: number } | null>(null);

  // Resume position only applies when reopening the chapter you left off in.
  useEffect(() => {
    restored.current = false;
    const p = data?.progress;
    // A page picked from the series page wins over where you left off.
    target.current = startPage
      ? { index: startPage, offset: 0 }
      : p && p.chapterId === chapterId && (p.pageIndex > 0 || p.pageOffset > 0) ? { index: p.pageIndex, offset: p.pageOffset } : null;
    if (!target.current) restored.current = true;
  }, [chapterId, startPage, data?.progress?.chapterId]);

  // Paged mode jumps straight to the saved page.
  useEffect(() => {
    if (!paged || !pages || restored.current || !target.current) return;
    setCurrent(Math.min(target.current.index, pages.length - 1));
    restored.current = true;
  }, [paged, pages]);

  const index = data ? data.chapters.findIndex((c) => c.id === chapterId) : -1;
  const chapter = index >= 0 ? data!.chapters[index] : null;
  const prev = index > 0 ? data!.chapters[index - 1] : null;
  const next = index >= 0 && index < data!.chapters.length - 1 ? data!.chapters[index + 1] : null;
  // Moving between chapters swaps the page, so Back from any chapter returns to the series, not the last chapter.
  const go = (c: { id: number } | null) => c && replaceHash(readHref(mangaId, c.id));

  function restoreFor(i: number, img: HTMLImageElement) {
    if (paged) return;
    const t = target.current;
    if (!t || t.index !== i || restored.current) return;
    restored.current = true;
    window.scrollTo(0, window.scrollY + img.getBoundingClientRect().top + img.height * t.offset);
  }

  // Scroll mode: work out which page is at the top of the screen and how far into it.
  function scrollPosition() {
    const imgs = Array.from(stripRef.current?.querySelectorAll<HTMLElement>("img, .pageError") ?? []);
    let pageIndex = 0;
    let pageOffset = 0;
    imgs.forEach((img, i) => {
      const r = img.getBoundingClientRect();
      if (r.top <= 1 && r.bottom > 1 && r.height > 0) {
        pageIndex = i;
        pageOffset = Math.min(1, Math.max(0, -r.top / r.height));
      }
    });
    const last = imgs.at(-1)?.getBoundingClientRect();
    return { pageIndex, pageOffset, finished: !!last && last.height > 0 && last.bottom <= window.innerHeight + 80 };
  }

  const save = useRef<(keepalive: boolean) => void>(() => {});
  save.current = (keepalive) => {
    if (!pages || !chapter || !restored.current) return;
    const pos = paged ? { pageIndex: current, pageOffset: 0, finished: atEnd || current >= pages.length - 1 } : scrollPosition();
    saveProgress(mangaId, { chapterId, chapterNumber: chapter.chapterNumber, chapterName: chapter.name, ...pos }, keepalive).catch(() => {});
  };

  // Scroll mode: update the page counter as you go and save a couple of seconds after scrolling stops.
  useEffect(() => {
    if (!pages || paged) return;
    let timer: number | undefined;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setCurrent(scrollPosition().pageIndex));
      if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; save.current(false); }, 2000);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pages, paged]);

  // Paged mode: save on every page turn.
  useEffect(() => {
    if (paged && pages) save.current(false);
  }, [current, atEnd, paged, pages]);

  // Always save when the app is hidden or closed.
  useEffect(() => {
    const onHide = () => document.visibilityState === "hidden" && save.current(true);
    const onLeave = () => save.current(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onLeave);
    };
  }, []);

  // Paged mode page turns. "Forward" means toward the end of the chapter.
  function forward() {
    if (!pages) return;
    if (atEnd) return go(next);
    if (current < pages.length - 1) setCurrent(current + 1);
    else setAtEnd(true);
  }
  function back() {
    if (atEnd) return setAtEnd(false);
    if (current > 0) setCurrent(current - 1);
    else go(prev);
  }

  function jumpTo(i: number) {
    setAtEnd(false);
    if (paged) return setCurrent(i);
    const el = stripRef.current?.children[i] as HTMLElement | undefined;
    if (el) window.scrollTo(0, window.scrollY + el.getBoundingClientRect().top);
  }

  function onTap(e: MouseEvent) {
    // Links, buttons and the bars do their own thing.
    if ((e.target as HTMLElement).closest("a, button, input, select, aside, .readerBar, .sheet")) return;
    if (paged && !atEnd) {
      // Paged: outer thirds turn pages (mirrored for right-to-left), the middle shows the bars.
      const x = e.clientX / window.innerWidth;
      if (x < 1 / 3) return rtl ? forward() : back();
      if (x > 2 / 3) return rtl ? back() : forward();
    }
    setChrome((v) => !v);
  }

  // Paged: swipe to turn pages.
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: TouchEvent) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY });
  const onTouchEnd = (e: TouchEvent) => {
    if (!paged || !touch.current) return;
    const dx = e.changedTouches[0].clientX - touch.current.x;
    const dy = e.changedTouches[0].clientY - touch.current.y;
    touch.current = null;
    if (Math.abs(dx) < 50 || Math.abs(dy) > Math.abs(dx)) return;
    // Swiping left moves forward in left-to-right books, backward in right-to-left ones.
    if (dx < 0) return rtl ? back() : forward();
    return rtl ? forward() : back();
  };

  // Keyboard: arrows turn pages in paged mode (chapters in scroll mode), Esc back to the series, M for the bars.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || (e.target as HTMLElement).closest("input, textarea, select") || document.querySelector(".sheet")) return;
      const right = e.key === "ArrowRight";
      const left = e.key === "ArrowLeft";
      if (paged && (right || left || e.key === " ")) {
        e.preventDefault();
        if (e.key === " ") return forward();
        return (right !== rtl) ? forward() : back();
      }
      if (right) go(next);
      else if (left) go(prev);
      else if (e.key === "Escape") backTo(seriesHref(mangaId));
      else if (e.key === "m") setChrome((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Tab title shows where you are (left plain for 18+ series, so they stay out of browser history).
  useEffect(() => {
    if (!data || !chapter || data.adult) return;
    document.title = `${chapterText(chapter)} · ${data.manga.title}`;
    return () => {
      document.title = "Sapphire";
    };
  }, [data?.manga.title, chapter?.id]);

  // Warm the next chapter's page list, and near the end of this one, its first pages.
  useEffect(() => {
    if (pages && next) chapterPages(next.id).catch(() => {});
  }, [pages, next?.id]);
  const warmed = useRef<number | null>(null);
  useEffect(() => {
    if (!pages || !next || warmed.current === next.id || current < pages.length - 4) return;
    warmed.current = next.id;
    chapterPages(next.id).then((r) => r.pages.slice(0, 3).forEach((src) => (new Image().src = src)), () => {});
  }, [current, pages, next?.id]);
  // Paged: keep the next two pages ready.
  useEffect(() => {
    if (paged && pages) pages.slice(current + 1, current + 3).forEach((src) => (new Image().src = src));
  }, [paged, pages, current]);

  async function changePrefs(p: ReaderPrefs, scope: PrefsScope = "series") {
    setPrefs(p);
    setAtEnd(false);
    if (p.mode === "paged") setCurrent((c) => c);
    await setReaderPrefs(mangaId, p, scope).catch(() => {});
  }

  const pageSrc = (src: string, i: number) => (failed[i] > 0 ? `${src}${src.includes("?") ? "&" : "?"}retry=${failed[i]}` : src);
  const pageImage = (src: string, i: number, eager: boolean) =>
    failed[i] !== undefined && failed[i] < 0 ? (
      <div key={src} className="pageError">
        <p>Page {i + 1} didn't load.</p>
        <button type="button" className="button small" onClick={() => setFailed((f) => ({ ...f, [i]: -f[i] }))}>Try again</button>
      </div>
    ) : (
      <img
        key={`${src}#${failed[i] ?? 0}`}
        src={pageSrc(src, i)}
        alt={`Page ${i + 1}`}
        className={loadedPages[i] ? undefined : "pending"}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        onLoad={(e) => {
          setLoadedPages((l) => ({ ...l, [i]: true }));
          restoreFor(i, e.currentTarget);
        }}
        onError={() => setFailed((f) => ({ ...f, [i]: -(Math.abs(f[i] ?? 0) + 1) }))}
      />
    );

  const endScreen = (
    <div className="readerEnd">
      <p className="muted">{chapter ? `End of ${chapterText(chapter)}` : ""}</p>
      {next ? (
        <a className="button nextChapter" href={readHref(mangaId, next.id)} onClick={(e) => { e.preventDefault(); replaceHash(readHref(mangaId, next.id)); }}>Next: {chapterText(next)} →</a>
      ) : (
        <p className="muted">You're caught up. Sapphire will alert you when a new chapter comes out{data?.inLibrary ? "" : " if you add this series to your library"}.</p>
      )}
      <a className="linkish" href={seriesHref(mangaId)} onClick={(e) => { e.preventDefault(); backTo(seriesHref(mangaId)); }}>All chapters</a>
    </div>
  );

  const total = pages?.length ?? 0;
  const pageLabel = pages ? (atEnd ? "End" : `Page ${Math.min(current + 1, total)} of ${total}`) : "";

  return (
    <section className={`reader ${paged ? "paged" : ""}`} onClick={onTap} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <header className={`readerBar readerTop ${chrome ? "show" : ""}`}>
        <a className="iconBtn" href={seriesHref(mangaId)} aria-label="Back to the series" onClick={(e) => { e.preventDefault(); backTo(seriesHref(mangaId)); }}>←</a>
        <div className="readerHeading">
          <strong className="readerSeries">{data?.manga.title ?? ""}</strong>
          <span className="readerSub">
            {chapter ? chapterText(chapter) : ""}
            {chapter && chapter.chapterNumber >= 0 && chapter.name && !/^ch(apter)?\.?\s*[\d.]+$/i.test(chapter.name.trim()) ? ` · ${chapter.name}` : ""}
            {pages ? ` · ${pageLabel}` : ""}
          </span>
        </div>
        <div className="readerActions">
          {data && chapter && <DownloadButton state={states[chapter.id]} onDownload={() => download(data.manga, [chapter])} />}
          {chapter && pages && <OfflineButton mangaId={mangaId} chapterId={chapter.id} pages={pages} compact />}
          <button type="button" className="iconBtn" aria-label="Reading settings" onClick={() => setSettingsOpen(true)}>⚙</button>
          <button type="button" className="iconBtn" aria-label="Open menu" onClick={onMenu}>
            <span className="burger" aria-hidden="true"><i /><i /><i /></span>
          </button>
        </div>
      </header>

      {error && (
        <p className="bad">
          {error} <a href={readHref(mangaId, chapterId)} onClick={() => window.location.reload()}>Try again</a>
        </p>
      )}
      {!pages && !error && <Loading label="Loading pages from the source…" size="lg" />}

      {pages && !paged && (
        <>
          <div className="strip" ref={stripRef}>
            {pages.map((src, i) => pageImage(src, i, i < 3 || i <= (target.current?.index ?? 0)))}
          </div>
          {endScreen}
        </>
      )}
      {pages && paged && (
        <div className={`pageView ${rtl ? "rtl" : ""}`} aria-live="polite">
          {atEnd ? endScreen : pageImage(pages[current], current, true)}
        </div>
      )}

      <footer className={`readerBar readerBottom ${chrome ? "show" : ""}`}>
        {pages && total > 1 && (
          <label className="pageSlider">
            <span>{atEnd ? total : Math.min(current + 1, total)}</span>
            <input
              type="range"
              min={1}
              max={total}
              value={Math.min(current + 1, total)}
              dir={rtl ? "rtl" : "ltr"}
              onChange={(e) => jumpTo(Number(e.target.value) - 1)}
              aria-label="Go to page"
            />
            <span>{total}</span>
          </label>
        )}
        {(data?.chapters.length ?? 2) > 1 && (
        <div className="readerBarRow">
          <button type="button" className="iconBtn" disabled={!prev} onClick={() => go(prev)} aria-label="Previous chapter">⏮</button>
          {data && (
            <select className="chapterPick" value={chapterId} onChange={(e) => go({ id: Number(e.target.value) })} aria-label="Go to chapter">
              {[...data.chapters].reverse().map((c) => (
                <option key={c.id} value={c.id}>
                  {chapterText(c)}{data.readChapterIds.includes(c.id) ? " ✓" : ""}
                </option>
              ))}
            </select>
          )}
          <button type="button" className="iconBtn" disabled={!next} onClick={() => go(next)} aria-label="Next chapter">⏭</button>
        </div>
        )}
      </footer>

      {settingsOpen && (
        <div className="sheetBackdrop" onClick={() => setSettingsOpen(false)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Reading settings" onClick={(e) => e.stopPropagation()}>
            <div className="sheetHandle" aria-hidden="true" />
            <h3>Reading mode</h3>
            <div className="segmented" role="radiogroup" aria-label="Reading mode">
              {([
                ["scroll", "ltr", "Scroll", "Webtoons and manhwa"],
                ["paged", "ltr", "Pages →", "Left to right"],
                ["paged", "rtl", "← Pages", "Right to left (manga)"],
              ] as const).map(([mode, direction, label, hint]) => {
                const on = prefs.mode === mode && (mode === "scroll" || prefs.direction === direction);
                return (
                  <button key={label} type="button" role="radio" aria-checked={on} className={on ? "on" : ""} onClick={() => changePrefs({ mode, direction })}>
                    <strong>{label}</strong>
                    <span>{hint}</span>
                  </button>
                );
              })}
            </div>
            <p className="muted small">
              {paged ? "Tap the left or right side, swipe, or use the arrow keys to turn pages. Tap the middle for the bars." : "Scroll to read. Tap anywhere for the bars."}
              {" "}This is saved for this series.
            </p>
            <div className="sheetActions">
              {data?.manga.sourceName && (
                <button type="button" className="button secondary" onClick={() => { void changePrefs(prefs, "source"); setSettingsOpen(false); }}>
                  Use for all {data.manga.sourceName}
                </button>
              )}
              <button type="button" className="button secondary" onClick={() => { void changePrefs(prefs, "all"); setSettingsOpen(false); }}>
                Use for all series
              </button>
              <button type="button" className="button" onClick={() => setSettingsOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
