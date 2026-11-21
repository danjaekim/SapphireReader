import { useEffect, useState } from "react";
import { library, refreshLibrary, thumbnailUrl, type LibraryItem } from "./api";
import { readHref, seriesHref } from "./route";

function num(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function Card({ item }: { item: LibraryItem }) {
  const p = item.progress;
  return (
    <li className="libCard">
      <a href={seriesHref(item.mangaId)}>
        <img src={thumbnailUrl(item.mangaId)} alt="" width={90} height={130} loading="lazy" />
      </a>
      <div className="info">
        <a href={seriesHref(item.mangaId)} className="libTitle">{item.title}</a>
        <p className="muted">
          {item.sourceName ?? ""}
          {p ? ` · stopped at ${p.chapterNumber >= 0 ? `Ch. ${num(p.chapterNumber)}` : p.chapterName}` : " · not started"}
        </p>
        {item.unread ? <p className="unread">{item.unread} unread</p> : item.unread === 0 ? <p className="muted">Caught up</p> : null}
        {p && (
          <a className="button small" href={readHref(item.mangaId, p.chapterId)}>
            Continue
          </a>
        )}
      </div>
    </li>
  );
}

export function Library() {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    library().then((r) => setItems(r.items), (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the library."));
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      setItems((await refreshLibrary()).items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }

  if (error) return <p className="bad">{error}</p>;
  if (!items) return <p className="muted">Loading…</p>;
  if (items.length === 0) return <p className="muted">Nothing here yet. Open a series from Search and tap Add to library.</p>;

  const reading = items.filter((i) => i.progress && (i.unread ?? 1) > 0);
  const rest = items.filter((i) => !reading.includes(i));
  return (
    <>
      <button type="button" className="linkish" onClick={refresh} disabled={refreshing}>
        {refreshing ? "Checking sources…" : "Check for new chapters"}
      </button>
      {reading.length > 0 && <h3>Continue reading</h3>}
      <ul className="libList">{reading.map((i) => <Card key={i.mangaId} item={i} />)}</ul>
      {rest.length > 0 && <h3>{reading.length ? "Everything else" : "Library"}</h3>}
      <ul className="libList">{rest.map((i) => <Card key={i.mangaId} item={i} />)}</ul>
    </>
  );
}
