import { Loading } from "./Loading";
import { useEffect, useState } from "react";
import { history, removeHistory, thumbnailUrl, type HistoryItem } from "./api";
import { readHref, seriesHref } from "./route";
import { chapterText } from "./util";

function when(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days <= 0) return `Today, ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString();
}

/** Everything you've read, most recent first; tap to pick up where you left off. */
export function History() {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    history().then((r) => setItems(r.items), (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load history."));
  }, []);

  async function remove(id: number) {
    setItems((list) => list?.filter((i) => i.mangaId !== id) ?? null);
    await removeHistory(id).catch(() => {});
  }

  if (error) return <p className="bad">{error}</p>;
  if (!items) return <Loading label="Loading your history…" />;
  if (items.length === 0) return <p className="muted">Nothing read yet. Series you open in the reader show up here.</p>;
  const needle = filter.trim().toLowerCase();
  const shown = items.filter((i) => !needle || i.title.toLowerCase().includes(needle));
  return (
    <>
      <div className="toolbar">
        <input type="search" className="jump" placeholder="Filter history" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter history by title" />
      </div>
      <ul className="feed">
        {shown.map((h) => (
          <li key={h.mangaId} className="feedRow historyRow">
            <a href={seriesHref(h.mangaId)} aria-hidden="true" tabIndex={-1}>
              <img src={thumbnailUrl(h.mangaId)} alt="" loading="lazy" />
            </a>
            <a className="info" href={readHref(h.mangaId, h.progress.chapterId)}>
              <strong className="clamp1">{h.title}</strong>
              <span className="muted small">
                {h.progress.chapterNumber >= 0 ? chapterText(h.progress.chapterNumber) : h.progress.chapterName}
                {h.progress.pageIndex > 0 ? `, page ${h.progress.pageIndex + 1}` : ""} · {when(h.progress.updatedAt)}
                {h.sourceName ? ` · ${h.sourceName}` : ""}
              </span>
            </a>
            <button type="button" className="iconBtn" onClick={() => remove(h.mangaId)} aria-label={`Remove ${h.title} from history`} title="Remove from history">✕</button>
          </li>
        ))}
      </ul>
    </>
  );
}
