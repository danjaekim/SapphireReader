import { useEffect, useState } from "react";
import { library, refreshLibrary, thumbnailUrl, type LibraryItem } from "./api";
import { readHref, seriesHref } from "./route";
import { chapterText } from "./util";

function Card({ item }: { item: LibraryItem }) {
  const p = item.progress;
  const pct = p && item.latestNumber ? Math.min(100, Math.round((Math.max(p.chapterNumber, 0) / item.latestNumber) * 100)) : 0;
  return (
    <li className="gridCard">
      <a href={p ? readHref(item.mangaId, p.chapterId) : seriesHref(item.mangaId)} className="gridCover">
        <img src={thumbnailUrl(item.mangaId)} alt="" loading="lazy" />
        {item.unread ? <span className="badge new">{item.unread} unread</span> : null}
      </a>
      <a href={seriesHref(item.mangaId)} className="gridTitle" title={item.title}>{item.title}</a>
      {p && <div className="bar"><i style={{ width: `${pct}%` }} /></div>}
      <span className="muted gridMeta">
        {p ? `${p.chapterNumber >= 0 ? chapterText(p.chapterNumber) : p.chapterName}${item.latestNumber ? ` of ${Math.floor(item.latestNumber)}` : ""}` : "not started"}
        {item.sourceName ? ` · ${item.sourceName}` : ""}
      </span>
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
      <ul className="grid">{reading.map((i) => <Card key={i.mangaId} item={i} />)}</ul>
      {rest.length > 0 && <h3>{reading.length ? "Everything else" : "Library"}</h3>}
      <ul className="grid">{rest.map((i) => <Card key={i.mangaId} item={i} />)}</ul>
    </>
  );
}
