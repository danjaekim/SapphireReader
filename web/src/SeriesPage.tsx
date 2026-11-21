import { useEffect, useState } from "react";
import { addToLibrary, alternatives, removeFromLibrary, series, similar, thumbnailUrl, type Alternative, type SeriesData, type SeriesGroup } from "./api";
import { genreHref, readHref } from "./route";
import { TrackerLinkCard } from "./Trackers";
import { useSeriesDownloads } from "./useDownloads";

function chapterLabel(c: { name: string; chapterNumber: number }): string {
  return c.chapterNumber >= 0 ? `Ch. ${Number.isInteger(c.chapterNumber) ? c.chapterNumber : c.chapterNumber.toFixed(1)}` : c.name;
}

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

export function SeriesPage({ mangaId }: { mangaId: number }) {
  const [data, setData] = useState<SeriesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);

  const { states, download } = useSeriesDownloads(mangaId);
  const [similarGroups, setSimilarGroups] = useState<SeriesGroup[] | null>(null);
  const [loadingSimilar, setLoadingSimilar] = useState(false);
  const [others, setOthers] = useState<Alternative[] | null>(null);

  useEffect(() => {
    setSimilarGroups(null);
  }, [mangaId]);

  async function showSimilar() {
    setLoadingSimilar(true);
    setSimilarGroups((await similar(mangaId).catch(() => ({ groups: [] }))).groups);
    setLoadingSimilar(false);
  }

  useEffect(() => {
    setOthers(null);
    alternatives(mangaId).then((r) => setOthers(r.alternatives), () => setOthers([]));
  }, [mangaId]);

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
  const unread = data ? data.chapters.filter((c) => !readIds.has(c.id) && states[c.id]?.status !== "done") : [];
  const notSaved = data ? data.chapters.filter((c) => !states[c.id] || states[c.id].status === "failed") : [];
  const working = Object.values(states).filter((d) => d.status === "queued" || d.status === "downloading").length;
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
                <li key={g}><a className="tag" href={genreHref(g)}>{g}</a></li>
              ))}
            </ul>
          )}
          {data.manga.description && <p className="desc">{data.manga.description}</p>}
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
          <div className="card">
            <h3>Similar series</h3>
            {similarGroups === null ? (
              <button type="button" className="button small secondary" onClick={showSimilar} disabled={loadingSimilar}>
                {loadingSimilar ? "Looking…" : "Find similar"}
              </button>
            ) : similarGroups.length === 0 ? (
              <p className="muted">Nothing similar turned up.</p>
            ) : (
              <ul className="similar">
                {similarGroups.map((g) => (
                  <li key={g.key}>
                    <a href={`#/series/${g.hits[0].mangaId}`}>
                      <img src={thumbnailUrl(g.hits[0].mangaId)} alt="" loading="lazy" width={80} height={116} />
                      <span>{g.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="chapterHead">
            <h3>Chapters</h3>
            <button type="button" className="linkish" onClick={() => setNewestFirst((v) => !v)}>
              {newestFirst ? "Newest first" : "Oldest first"}
            </button>
          </div>
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
          </div>
          <ul className="chapters">
            {(newestFirst ? [...data.chapters].reverse() : data.chapters).map((c) => (
              <li key={c.id} className={readIds.has(c.id) ? "read" : undefined}>
                <a href={readHref(mangaId, c.id)}>
                  <span>{chapterLabel(c)}</span>
                  {c.name && c.chapterNumber >= 0 && c.name !== chapterLabel(c) && <span className="muted"> {c.name}</span>}
                  <span className="muted date">{c.uploadDate ? new Date(c.uploadDate).toLocaleDateString() : ""}</span>
                </a>
                <DownloadButton state={states[c.id]} onDownload={() => download(data.manga, [c])} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
