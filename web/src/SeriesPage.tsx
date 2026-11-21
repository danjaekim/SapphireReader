import { useEffect, useState } from "react";
import { series, thumbnailUrl, type SeriesData } from "./api";
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

  return (
    <section>
      <a className="back" href="#/">← Back to search</a>
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
              {data.chapters.length > 0 && (
                <a className="button" href={readHref(mangaId, data.chapters[0].id)}>
                  Start reading
                </a>
              )}
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
              <li key={c.id}>
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
