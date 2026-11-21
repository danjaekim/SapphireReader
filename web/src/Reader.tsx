import { useEffect, useRef, useState } from "react";
import { chapterPages, saveProgress, series, type SeriesData } from "./api";
import { readHref, seriesHref } from "./route";

export function Reader({ mangaId, chapterId }: { mangaId: number; chapterId: number }) {
  const [data, setData] = useState<SeriesData | null>(null);
  const [pages, setPages] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The series (chapter list) is cached by the server, so moving between chapters is quick.
  useEffect(() => {
    series(mangaId).then(setData, () => {});
  }, [mangaId]);

  useEffect(() => {
    setPages(null);
    setError(null);
    window.scrollTo(0, 0);
    chapterPages(chapterId).then(
      (r) => setPages(r.pages),
      (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load this chapter."),
    );
  }, [chapterId]);

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

  const nav = (
    <div className="readerNav">
      {prev ? <a href={readHref(mangaId, prev.id)}>← Previous</a> : <span className="muted">← Previous</span>}
      <a href={seriesHref(mangaId)}>Chapters</a>
      {next ? <a href={readHref(mangaId, next.id)}>Next →</a> : <span className="muted">Next →</span>}
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

  // Warm the next chapter's page list so "Next" starts fast.
  useEffect(() => {
    if (pages && next) chapterPages(next.id).catch(() => {});
  }, [pages, next?.id]);

  return (
    <section className="reader">
      <header className="readerTop">
        <a href={seriesHref(mangaId)}>← {data?.manga.title ?? "Back"}</a>
        <strong>{chapter ? (chapter.chapterNumber >= 0 ? `Chapter ${chapter.chapterNumber}` : chapter.name) : ""}</strong>
      </header>
      {error && (
        <p className="bad">
          {error} <a href={readHref(mangaId, chapterId)} onClick={() => window.location.reload()}>Try again</a>
        </p>
      )}
      {!pages && !error && <p className="muted">Loading pages from the source…</p>}
      {pages && (
        <div className="strip" ref={stripRef}>
          {pages.map((src, i) => (
            <img
              key={src}
              src={src}
              alt={`Page ${i + 1}`}
              loading={i < 3 || i <= (target.current?.index ?? 0) ? "eager" : "lazy"}
              onLoad={(e) => restoreFor(i, e.currentTarget)}
            />
          ))}
        </div>
      )}
      {pages && nav}
    </section>
  );
}
