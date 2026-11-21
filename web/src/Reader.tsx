import { useEffect, useState } from "react";
import { chapterPages, series, type SeriesData } from "./api";
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
        <div className="strip">
          {pages.map((src, i) => (
            <img key={src} src={src} alt={`Page ${i + 1}`} loading={i < 3 ? "eager" : "lazy"} />
          ))}
        </div>
      )}
      {pages && nav}
    </section>
  );
}
