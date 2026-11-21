import { useEffect, useState } from "react";
import { genreList } from "./api";

export function GenrePicker({ selected, onChange }: { selected: string[]; onChange: (g: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<{ name: string; sources: number }[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (open && !all) genreList().then((r) => setAll(r.genres), () => setAll([]));
  }, [open, all]);

  const chosen = new Set(selected.map((g) => g.toLowerCase()));
  const choices = (all ?? []).filter((g) => !chosen.has(g.name.toLowerCase()) && g.name.toLowerCase().includes(filter.trim().toLowerCase()));
  return (
    <div className="genrePicker">
      <div className="chips">
        {selected.map((g) => (
          <button type="button" key={g} className="chip on" onClick={() => onChange(selected.filter((x) => x !== g))} aria-label={`Remove ${g}`}>
            {g} ×
          </button>
        ))}
        <button type="button" className="chip" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Hide genres" : selected.length ? "+ Add genre" : "Filter by genre"}
        </button>
      </div>
      {open && (
        <div className="genreList">
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a genre" aria-label="Find a genre" />
          {!all && <p className="muted">Loading genres from your sources…</p>}
          {all && choices.length === 0 && <p className="muted">No matching genres.</p>}
          <div className="chips">
            {choices.slice(0, 80).map((g) => (
              <button type="button" key={g.name} className="chip" onClick={() => onChange([...selected, g.name])}>
                {g.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
