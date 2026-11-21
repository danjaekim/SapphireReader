import { useEffect, useMemo, useState } from "react";
import { downloads, removeDownload, removeSeriesDownloads, thumbnailUrl, type DownloadRow } from "./api";
import { readHref, seriesHref } from "./route";

function size(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

const label = (d: DownloadRow) => (d.chapterNumber >= 0 ? `Ch. ${Number.isInteger(d.chapterNumber) ? d.chapterNumber : d.chapterNumber.toFixed(1)}` : d.chapterName);

/** Chapters saved on the NAS, readable without asking the source site. */
export function Downloads() {
  const [items, setItems] = useState<DownloadRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    downloads().then(
      (r) => {
        if (cancelled) return;
        setItems(r.items);
        setTotal(r.totalBytes);
        if (r.items.some((d) => d.status === "queued" || d.status === "downloading")) timer = window.setTimeout(() => setTick((t) => t + 1), 2000);
      },
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Couldn't load downloads."),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [tick]);

  const series = useMemo(() => {
    const by = new Map<number, { title: string; sourceName: string | null; rows: DownloadRow[] }>();
    for (const d of items ?? []) {
      const s = by.get(d.mangaId) ?? { title: d.mangaTitle, sourceName: d.sourceName, rows: [] };
      s.rows.push(d);
      by.set(d.mangaId, s);
    }
    return [...by.entries()];
  }, [items]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
    setTick((t) => t + 1);
  }

  if (error && !items) return <p className="bad">{error}</p>;
  if (!items) return <p className="muted">Loading…</p>;
  if (items.length === 0) return <p className="muted">Nothing downloaded yet. Use the ⬇ button on a chapter, in the chapter list or while reading.</p>;

  return (
    <>
      <p className="muted">
        {items.filter((d) => d.status === "done").length} chapters saved, {size(total)} on the NAS.
      </p>
      {error && <p className="bad">{error}</p>}
      {series.map(([mangaId, s]) => {
        const done = s.rows.filter((d) => d.status === "done");
        return (
          <section key={mangaId} className="card dlSeries">
            <div className="dlHead">
              <img src={thumbnailUrl(mangaId)} alt="" width={56} height={80} loading="lazy" />
              <div className="info">
                <a href={seriesHref(mangaId)} className="libTitle">{s.title}</a>
                <p className="muted">
                  {s.sourceName ? `${s.sourceName} · ` : ""}
                  {done.length} saved · {size(done.reduce((n, d) => n + d.bytes, 0))}
                </p>
                <button type="button" className="linkish" onClick={() => act(() => removeSeriesDownloads(mangaId))}>Remove all</button>
              </div>
            </div>
            <ul className="extList">
              {s.rows.map((d) => (
                <li key={d.chapterId} className="extRow">
                  {d.status === "done" ? <a href={readHref(mangaId, d.chapterId)}>{label(d)}</a> : <span>{label(d)}</span>}
                  <span className="muted">
                    {d.status === "done" ? size(d.bytes) : d.status === "failed" ? `failed: ${d.error ?? "unknown error"}` : d.status === "queued" ? "waiting" : "downloading…"}
                  </span>
                  {d.status !== "downloading" && (
                    <button type="button" className="linkish" onClick={() => act(() => removeDownload(d.chapterId))} aria-label={`Remove ${label(d)}`}>
                      {d.status === "done" ? "Remove" : "Clear"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
