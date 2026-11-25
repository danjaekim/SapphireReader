import { useEffect, useState } from "react";
import { mangaBakaTags } from "./api";
import type { MbTagParam } from "./route";

/**
 * The MangaBaka tags a list is filtered by, each removable, plus a box to add another by name. Shown on
 * Search and Discover when the address has `mb=` tags (from tapping an outlined tag on a series page).
 */
export function MbTagBar({ tags, onChange }: { tags: MbTagParam[]; onChange: (next: MbTagParam[]) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ id: number; name: string; path: string; count: number | null }[]>([]);
  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) return setFound([]);
    let live = true;
    const t = window.setTimeout(() => {
      mangaBakaTags(text).then((r) => live && setFound(r.tags.filter((x) => !tags.some((y) => y.id === x.id))), () => live && setFound([]));
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, tags]);
  return (
    <div className="mbTagBar">
      <span className="muted small">MangaBaka tags:</span>
      <ul className="genres">
        {tags.map((t) => (
          <li key={t.id}>
            <button type="button" className="tag bakaTag core mbChip" onClick={() => onChange(tags.filter((x) => x.id !== t.id))} aria-label={`Remove ${t.name}`}>
              {t.name} <span aria-hidden="true">✕</span>
            </button>
          </li>
        ))}
      </ul>
      {tags.length < 6 && (
        <div className="mbAdd">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add a MangaBaka tag" aria-label="Add a MangaBaka tag" />
          {found.length > 0 && (
            <ul className="mbFound" role="listbox">
              {found.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange([...tags, { id: t.id, name: t.name }]);
                      setQ("");
                      setFound([]);
                    }}
                  >
                    {t.name} <span className="muted small">{t.path !== t.name ? t.path : ""}{t.count != null ? ` · ${t.count}` : ""}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
