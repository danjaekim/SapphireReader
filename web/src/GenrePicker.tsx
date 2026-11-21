import { Loading } from "./Loading";
import { useEffect, useState } from "react";
import { genreList, type GenreScope } from "./api";
import { canonKey, canonLabel } from "./genres";

/**
 * Stackable genre filters. Only genres your sources in this context actually offer are listed
 * (ordinary pages never show 18+ genres, and Discover (18+) shows only theirs).
 */
export function GenrePicker({ selected, onChange, scope }: { selected: string[]; onChange: (g: string[]) => void; scope?: GenreScope }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<{ name: string; sources: number }[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    setAll(null);
  }, [scope]);

  useEffect(() => {
    if (open && !all) genreList(scope).then((r) => setAll(r.genres), () => setAll([]));
  }, [open, all, scope]);

  const chosen = new Set(selected.map(canonKey));
  const choices = (all ?? []).filter((g) => !chosen.has(canonKey(g.name)) && g.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="genrePicker">
      <div className="chips">
        {selected.map((g) => (
          <button type="button" key={g} className="chip on" onClick={() => onChange(selected.filter((x) => x !== g))} aria-label={`Remove ${g}`}>
            {canonLabel(g)} ×
          </button>
        ))}
        <button type="button" className="chip" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide genres" : selected.length ? "+ Add genre" : "Filter by genre"}
        </button>
        {selected.length > 1 && <span className="muted chipNote">Series must have all of these genres.</span>}
      </div>
      {open && (
        <div className="genreList">
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a genre" aria-label="Find a genre" />
          {!all && <Loading label="Loading genres from your sources…" size="sm" block={false} />}
          {all && all.length === 0 && <p className="muted">None of your sources reported genre filters yet. Try again in a moment.</p>}
          {all && all.length > 0 && choices.length === 0 && <p className="muted">No matching genres.</p>}
          <div className="chips">
            {choices.slice(0, 120).map((g) => (
              <button type="button" key={g.name} className="chip" onClick={() => onChange([...selected, g.name])} title={`${g.sources} source${g.sources === 1 ? "" : "s"}`}>
                {g.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
