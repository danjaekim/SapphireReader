import { useEffect, useState } from "react";
import { refreshLibrary, thumbnailUrl, updatesFeed, type UpdateRow } from "./api";
import { seriesHref } from "./route";
import { ago, chapterText } from "./util";

/** New chapters found in your library, newest first. */
export function Updates() {
  const [items, setItems] = useState<UpdateRow[] | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const load = () =>
    updatesFeed().then(
      (r) => {
        setItems(r.items);
        setChecked(r.lastCheckedAt);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load updates."),
    );
  useEffect(() => void load(), []);

  async function check() {
    setChecking(true);
    await refreshLibrary().catch(() => {});
    await load();
    setChecking(false);
  }

  return (
    <section>
      <p className="muted">
        New chapters for series in your library. Last checked {ago(checked)}.{" "}
        <button type="button" className="linkish" onClick={check} disabled={checking}>
          {checking ? "Checking sources…" : "Check now"}
        </button>
      </p>
      {error && <p className="bad">{error}</p>}
      {items && items.length === 0 && <p className="muted">Nothing new yet. Sapphire checks your library every few hours.</p>}
      <ul className="feed">
        {(items ?? []).map((u, i) => (
          <li key={`${u.mangaId}-${i}`} className="feedRow">
            <img src={thumbnailUrl(u.mangaId)} alt="" width={44} height={60} loading="lazy" />
            <div className="info">
              <a href={seriesHref(u.mangaId)} className="libTitle">{u.title}</a>
              <span> · {chapterText(u.latestNumber)}{u.newCount > 1 ? ` (+${u.newCount})` : ""}</span>
              <div className="muted small">
                {u.sourceName ?? "source"} · {ago(u.detectedAt)}
                {u.caughtUp && <span className="tag"> you were caught up</span>}
              </div>
            </div>
            <a className="button small" href={seriesHref(u.mangaId)}>Open</a>
          </li>
        ))}
      </ul>
    </section>
  );
}
