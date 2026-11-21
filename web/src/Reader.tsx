import { Loading } from "./Loading";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { chapterPages, saveProgress, series, type SeriesData } from "./api";
import { DownloadButton } from "./SeriesPage";
import { readHref, seriesHref } from "./route";
import { useSeriesDownloads } from "./useDownloads";

export function Reader({ mangaId, chapterId, nav: sideNav }: { mangaId: number; chapterId: number; nav: ReactNode }) {
  // Chrome (top bar and menu) stays hidden while reading; tapping the page shows or hides it.
  const [chrome, setChrome] = useState(false);
  const [data, setData] = useState<SeriesData | null>(null);
  const [pages, setPages] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState(0);
  // Pages that failed to load, and how many times each was retried (the retry count busts the cache).
  const [failed, setFailed] = useState<Record<number, number>>({});
  const [loadedPages, setLoadedPages] = useState<Record<number, boolean>>({});

  // The series (chapter list) is cached by the server, so moving between chapters is quick.
  useEffect(() => {
    series(mangaId).then(setData, () => {});
  }, [mangaId]);

  useEffect(() => {
    setPages(null);
    setError(null);
    setFailed({});
    setLoadedPages({});
    setCurrent(0);
    window.scrollTo(0, 0);
    chapterPages(chapterId).then(
      (r) => setPages(r.pages),
      (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load this chapter."),
    );
  }, [chapterId]);

  const { states, download } = useSeriesDownloads(mangaId);
  const stripRef = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const target = useRef<{ index: number; offset: number } | null>(null);
  const latestSave = useRef<() => void>(() => {});

  // Resume position only applies when reopening the chapter you left off in.
  useEffect(() => {
    restored.current = false;
    const p = data?.progress;
    target.current = p && p.chapterId === chapterId && (p.pageIndex > 0 || p.pageOffset > 0) ? { index: p.pageIndex, offset: p.pageOffset } : null;
    if (!target.current) restored.current = true;
  }, [chapterId, data?.progress?.chapterId]);

  const index = data ? data.chapters.findIndex((c) => c.id === chapterId) : -1;
  const chapter = index >= 0 ? data!.chapters[index] : null;
  const prev = index > 0 ? data!.chapters[index - 1] : null;
  const next = index >= 0 && index < data!.chapters.length - 1 ? data!.chapters[index + 1] : null;

  const bottomNav = (
    <div className="readerEnd">
      {next ? (
        <a className="button nextChapter" href={readHref(mangaId, next.id)}>
          Next: {next.chapterNumber >= 0 ? `Chapter ${next.chapterNumber}` : next.name} →
        </a>
      ) : (
        <p className="muted">You're caught up. Sapphire will alert you when a new chapter comes out{data?.inLibrary ? "" : " if you add this series to your library"}.</p>
      )}
      <div className="readerNav">
        {prev ? <a href={readHref(mangaId, prev.id)}>← Previous</a> : <span className="muted">← Previous</span>}
        <a href={seriesHref(mangaId)}>All chapters</a>
      </div>
    </div>
  );

  function restoreFor(i: number, img: HTMLImageElement) {
    const t = target.current;
    if (!t || t.index !== i || restored.current) return;
    restored.current = true;
    window.scrollTo(0, window.scrollY + img.getBoundingClientRect().top + img.height * t.offset);
  }

  // Remember where you are: which page is at the top of the screen and how far into it.
  useEffect(() => {
    if (!pages || !chapter) return;
    const save = (keepalive: boolean) => {
      if (!restored.current) return;
      const imgs = Array.from(stripRef.current?.querySelectorAll("img") ?? []);
      if (imgs.length === 0) return;
      let pageIndex = 0;
      let pageOffset = 0;
      imgs.forEach((img, i) => {
        const r = img.getBoundingClientRect();
        if (r.top <= 1 && r.bottom > 1 && r.height > 0) {
          pageIndex = i;
          pageOffset = Math.min(1, Math.max(0, -r.top / r.height));
        }
      });
      const last = imgs[imgs.length - 1].getBoundingClientRect();
      const finished = last.height > 0 && last.bottom <= window.innerHeight + 80;
      setCurrent(pageIndex);
      saveProgress(
        mangaId,
        { chapterId, chapterNumber: chapter.chapterNumber, chapterName: chapter.name, pageIndex, pageOffset, finished },
        keepalive,
      ).catch(() => {});
    };
    latestSave.current = () => save(true);
    let timer: number | undefined;
    const onScroll = () => {
      if (timer === undefined) timer = window.setTimeout(() => { timer = undefined; save(false); }, 2000);
    };
    const onHide = () => { if (document.visibilityState === "hidden") save(true); };
    window.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", latestSave.current);
    return () => {
      window.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", latestSave.current);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [pages, chapter?.id, mangaId, chapterId]);

  function onTap(e: MouseEvent) {
    // Links and buttons do their own thing; only a tap on the page itself toggles the menu.
    if ((e.target as HTMLElement).closest("a, button, input, aside")) return;
    setChrome((v) => !v);
  }

  useEffect(() => setChrome(false), [chapterId]);

  // Keyboard: ← / → for previous / next chapter, Esc back to the series. Scrolling keys work as usual.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || (e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "ArrowRight" && next) window.location.hash = readHref(mangaId, next.id);
      else if (e.key === "ArrowLeft" && prev) window.location.hash = readHref(mangaId, prev.id);
      else if (e.key === "Escape") window.location.hash = seriesHref(mangaId);
      else if (e.key === "m") setChrome((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mangaId, next?.id, prev?.id]);

  // Tab title shows where you are (left plain for 18+ series, so they stay out of browser history).
  useEffect(() => {
    if (!data || !chapter || data.adult) return;
    document.title = `${chapter.chapterNumber >= 0 ? `Ch. ${chapter.chapterNumber}` : chapter.name} · ${data.manga.title}`;
    return () => {
      document.title = "Sapphire";
    };
  }, [data?.manga.title, chapter?.id]);

  // Near the end of a chapter, start fetching the next one's first pages so it opens instantly.
  const warmed = useRef<number | null>(null);
  useEffect(() => {
    if (!pages || !next || warmed.current === next.id || current < pages.length - 4) return;
    warmed.current = next.id;
    chapterPages(next.id).then(
      (r) => r.pages.slice(0, 3).forEach((src) => {
        const img = new Image();
        img.src = src;
      }),
      () => {},
    );
  }, [current, pages, next?.id]);

  // Warm the next chapter's page list so "Next" starts fast.
  useEffect(() => {
    if (pages && next) chapterPages(next.id).catch(() => {});
  }, [pages, next?.id]);


  return (
    <section className="reader" onClick={onTap}>
      {chrome && sideNav}
      <header className={`readerTop ${chrome ? "show" : ""}`}>
        <a href={seriesHref(mangaId)}>← {data?.manga.title ?? "Back"}</a>
        <span className="readerTitle">
          <strong>{chapter ? (chapter.chapterNumber >= 0 ? `Chapter ${chapter.chapterNumber}` : chapter.name) : ""}</strong>
          {pages && <span className="muted pageCount">{Math.min(current + 1, pages.length)} / {pages.length}</span>}
          {data && chapter && (
            <>
              <DownloadButton state={states[chapter.id]} onDownload={() => download(data.manga, [chapter])} />
              {next && (
                <button
                  type="button"
                  className="dlBtn wide"
                  title="Download the next five chapters to the NAS"
                  onClick={() => download(data.manga, data.chapters.slice(index + 1, index + 6).filter((c) => !states[c.id] || states[c.id].status === "failed"))}
                >
                  ⬇ next 5
                </button>
              )}
            </>
          )}
        </span>
      </header>
      {error && (
        <p className="bad">
          {error} <a href={readHref(mangaId, chapterId)} onClick={() => window.location.reload()}>Try again</a>
        </p>
      )}
      {!pages && !error && <Loading label="Loading pages from the source…" size="lg" />}
      {pages && (
        <div className="strip" ref={stripRef}>
          {pages.map((src, i) =>
            failed[i] !== undefined && failed[i] < 0 ? (
              <div key={src} className="pageError">
                <p>Page {i + 1} didn't load.</p>
                <button type="button" className="button small" onClick={() => setFailed((f) => ({ ...f, [i]: -f[i] }))}>
                  Try again
                </button>
              </div>
            ) : (
              <img
                key={`${src}#${failed[i] ?? 0}`}
                src={failed[i] ? `${src}${src.includes("?") ? "&" : "?"}retry=${failed[i]}` : src}
                alt={`Page ${i + 1}`}
                className={loadedPages[i] ? undefined : "pending"}
                loading={i < 3 || i <= (target.current?.index ?? 0) ? "eager" : "lazy"}
                decoding="async"
                onLoad={(e) => {
                  setLoadedPages((l) => ({ ...l, [i]: true }));
                  restoreFor(i, e.currentTarget);
                }}
                // A negative count means "showing the retry button"; retrying flips it to the next attempt.
                onError={() => setFailed((f) => ({ ...f, [i]: -((Math.abs(f[i] ?? 0)) + 1) }))}
              />
            ),
          )}
        </div>
      )}
      {pages && bottomNav}
    </section>
  );
}
