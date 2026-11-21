import { useEffect, useState } from "react";
import { addToLibrary, removeFromLibrary, series, thumbnailUrl, type SeriesData } from "./api";
import { readHref } from "./route";

function chapterLabel(c: { name: string; chapterNumber: number }): string {
  return c.chapterNumber >= 0 ? `Ch. ${Number.isInteger(c.chapterNumber) ? c.chapterNumber : c.chapterNumber.toFixed(1)}` : c.name;
}

export function SeriesPage({ mangaId }: { mangaId: number }) {
  const [data, setData] = useState<SeriesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);

  useEffect(() => {
    setData(null);
    setError(null);
    series(mangaId).then(setData, (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load this series."));
  }, [mangaId]);

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
  const resume = data?.progress ? data.chapters.find((c) => c.id === data.progress!.chapterId) : undefined;

  return (
    <section>
      <a className="back" href="#/">← Back</a>
      {error && <p className="bad">{error}</p>}
      {!data && !error && <p className="muted">Loading from the source. This can take several seconds.</p>}
      {data && (
        <>
          <div className="seriesHead">
            <img src={thumbnailUrl(mangaId)} alt="" width={120} height={173} />
            <div className="info">
              <h2>{data.manga.title}</h2>
              <p className="muted">
                {[data.manga.sourceName, data.manga.status.toLowerCase(), data.manga.author].filter(Boolean).join(" · ")}
              </p>
              <p className="muted">
                {data.latest.latestNumber !== null
                  ? `${data.latest.chapterCount} chapters, latest ${chapterLabel({ name: "", chapterNumber: data.latest.latestNumber })}`
                  : `${data.latest.chapterCount} chapters`}
              </p>
              <div className="actions">
                {data.chapters.length > 0 && (
                  <a className="button" href={readHref(mangaId, (resume ?? data.chapters[0]).id)}>
                    {resume ? `Continue ${chapterLabel(resume)}` : "Start reading"}
                  </a>
                )}
                <button type="button" className="button secondary" onClick={toggleLibrary}>
                  {data.inLibrary ? "In library ✓" : "Add to library"}
                </button>
              </div>
            </div>
          </div>
          {data.manga.genre.length > 0 && (
            <ul className="genres">
              {data.manga.genre.map((g) => (
                <li key={g} className="tag">{g}</li>
              ))}
            </ul>
          )}
          {data.manga.description && <p className="desc">{data.manga.description}</p>}
          <div className="chapterHead">
            <h3>Chapters</h3>
            <button type="button" className="linkish" onClick={() => setNewestFirst((v) => !v)}>
              {newestFirst ? "Newest first" : "Oldest first"}
            </button>
          </div>
          <ul className="chapters">
            {(newestFirst ? [...data.chapters].reverse() : data.chapters).map((c) => (
              <li key={c.id} className={readIds.has(c.id) ? "read" : undefined}>
                <a href={readHref(mangaId, c.id)}>
                  <span>{chapterLabel(c)}</span>
                  {c.name && c.chapterNumber >= 0 && c.name !== chapterLabel(c) && <span className="muted"> {c.name}</span>}
                  <span className="muted date">{c.uploadDate ? new Date(c.uploadDate).toLocaleDateString() : ""}</span>
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
