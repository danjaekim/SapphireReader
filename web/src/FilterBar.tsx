import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { genreList, type GenreScope } from "./api";
import { canonKey, canonLabel } from "./genres";
import { Loading } from "./Loading";
import { SORT_LABELS, type SortKey } from "./SortSelect";

/**
 * The search and filter controls shared by Search and Discover. It sticks to the top while you scroll
 * (on phones it tucks away as you scroll down and comes back as soon as you scroll up), shows every
 * filter in effect as a chip you can remove, and opens a sheet to pick genres.
 */
export function FilterBar({
  search,
  tabs,
  genres,
  onGenres,
  scope,
  sort,
  onSort,
  sortOptions,
}: {
  search?: { value: string; busy: boolean; canSubmitEmpty: boolean; placeholder: string; onSubmit: (text: string) => void };
  tabs?: { items: { id: string; label: string }[]; active: string | null; onPick: (id: string) => void };
  genres: string[];
  onGenres: (g: string[]) => void;
  scope?: GenreScope;
  sort?: SortKey;
  onSort?: (s: SortKey) => void;
  sortOptions?: SortKey[];
}) {
  const [sheet, setSheet] = useState(false);
  const tucked = useTuckOnScroll(sheet);
  const [text, setText] = useState(search?.value ?? "");
  useEffect(() => setText(search?.value ?? ""), [search?.value]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const next = text.trim();
    if (next.length >= 2 || search?.canSubmitEmpty) {
      search?.onSubmit(next);
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }

  const count = genres.length;
  return (
    <>
      <div className={`filterBar ${tucked ? "tucked" : ""}`}>
        {search && (
          <form className="filterSearch" onSubmit={submit} role="search">
            <div className="filterField">
              <span className="filterSearchIcon" aria-hidden="true">⌕</span>
              <input
                type="search"
                enterKeyHint="search"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={search.placeholder}
                aria-label="Search all sources"
              />
              {text && (
                <button type="button" className="filterClear" aria-label="Clear search" onClick={() => setText("")}>×</button>
              )}
            </div>
            <button type="submit" className="filterGo" disabled={search.busy || (text.trim().length < 2 && !search.canSubmitEmpty)}>
              {search.busy ? "Searching…" : "Search"}
            </button>
          </form>
        )}
        {tabs && (
          <div className="tabRow" role="tablist" aria-label="Lists">
            {tabs.items.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tabs.active === t.id} className={`chip ${tabs.active === t.id ? "on" : ""}`} onClick={() => tabs.onPick(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="filterControls">
          <button type="button" className={`filterBtn ${count ? "on" : ""}`} onClick={() => setSheet(true)} aria-haspopup="dialog">
            <span aria-hidden="true">☰</span> {count ? `Genres · ${count}` : "Genres"}
          </button>
          {sort && onSort && (
            <label className="filterSort">
              <span className="muted">Sort</span>
              <select value={sort} onChange={(e) => onSort(e.target.value as SortKey)} aria-label="Sort">
                {(sortOptions ?? (Object.keys(SORT_LABELS) as SortKey[])).map((k) => (
                  <option key={k} value={k}>{SORT_LABELS[k]}</option>
                ))}
              </select>
            </label>
          )}
        </div>
        {count > 0 && (
          <div className="appliedRow" aria-label="Filters in use">
            {genres.map((g) => (
              <span key={g} className="appliedChip">
                <span>{canonLabel(g)}</span>
                <button type="button" aria-label={`Remove ${canonLabel(g)}`} onClick={() => onGenres(genres.filter((x) => x !== g))}>×</button>
              </span>
            ))}
            <button type="button" className="linkish clearAll" onClick={() => onGenres([])}>Clear all</button>
          </div>
        )}
      </div>
      {sheet && <GenreSheet selected={genres} scope={scope} onApply={(g) => { setSheet(false); if (g.join("|") !== genres.join("|")) onGenres(g); }} onClose={() => setSheet(false)} />}
    </>
  );
}

/** True while the person is scrolling down the page (past the first screenful), so the bar can get out of the way. */
function useTuckOnScroll(paused: boolean): boolean {
  const [tucked, setTucked] = useState(false);
  const last = useRef(0);
  useEffect(() => {
    last.current = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const d = y - last.current;
      if (Math.abs(d) < 8) return;
      setTucked(d > 0 && y > 160);
      last.current = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return tucked && !paused;
}

/** Pick genres in one go; nothing reloads until "Show results". */
function GenreSheet({ selected, scope, onApply, onClose }: { selected: string[]; scope?: GenreScope; onApply: (g: string[]) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(selected);
  const [all, setAll] = useState<{ name: string; sources: number }[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    genreList(scope).then((r) => setAll(r.genres), () => setAll([]));
  }, [scope]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const chosen = new Set(draft.map(canonKey));
  const f = filter.trim().toLowerCase();
  const choices = (all ?? []).filter((g) => !chosen.has(canonKey(g.name)) && g.name.toLowerCase().includes(f));
  const toggle = (name: string) =>
    setDraft((d) => (d.some((x) => canonKey(x) === canonKey(name)) ? d.filter((x) => canonKey(x) !== canonKey(name)) : [...d, name]));

  return (
    <div className="sheetBackdrop" onClick={onClose}>
      <div className="sheet tall filterSheet" role="dialog" aria-modal="true" aria-label="Genres" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" aria-hidden="true" />
        <header className="filterSheetHead">
          <h3>Genres</h3>
          <button type="button" className="iconBtn" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <input className="filterSheetFind" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a genre" aria-label="Find a genre" />
        <div className="filterSheetBody">
          {draft.length > 0 && (
            <Group title={draft.length > 1 ? "Selected: series must have all of these" : "Selected"}>
              {draft.map((g) => (
                <button key={g} type="button" className="tagOpt on" aria-pressed="true" onClick={() => toggle(g)}>
                  <span aria-hidden="true">✓</span> {canonLabel(g)}
                </button>
              ))}
            </Group>
          )}
          {!all && <Loading label="Loading genres from your sources…" size="sm" />}
          {all && all.length === 0 && <p className="muted">None of your sources reported genre filters yet. Try again in a moment.</p>}
          {all && all.length > 0 && choices.length === 0 && <p className="muted">No matching genres.</p>}
          {choices.length > 0 && (
            <Group title={f ? "Matches" : "All genres"}>
              {choices.map((g) => (
                <button key={g.name} type="button" className="tagOpt" aria-pressed="false" onClick={() => toggle(g.name)} title={`${g.sources} source${g.sources === 1 ? "" : "s"}`}>
                  {g.name}
                </button>
              ))}
            </Group>
          )}
        </div>
        <footer className="filterSheetFoot">
          <button type="button" className="button secondary" onClick={() => setDraft([])} disabled={draft.length === 0}>Reset</button>
          <button type="button" className="button" onClick={() => onApply(draft)}>Show results</button>
        </footer>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tagGroup">
      <h4>{title}</h4>
      <div className="tagOpts">{children}</div>
    </section>
  );
}
