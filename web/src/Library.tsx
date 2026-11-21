import { Loading } from "./Loading";
import { useEffect, useState } from "react";
import { categories as loadCategories, createCategory, deleteCategory, library, refreshLibrary, renameCategory, thumbnailUrl, type Category, type LibraryItem } from "./api";
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

type LibSort = "recent" | "unread" | "title";
const LIB_SORTS: { id: LibSort; label: string }[] = [
  { id: "recent", label: "Recently read" },
  { id: "unread", label: "Most unread" },
  { id: "title", label: "Title A–Z" },
];

function savedSort(): LibSort {
  try {
    const v = localStorage.getItem("sapphire.librarySort");
    return LIB_SORTS.some((s) => s.id === v) ? (v as LibSort) : "recent";
  } catch {
    return "recent";
  }
}

export function Library() {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [sort, setSort] = useState<LibSort>(savedSort);
  const [filter, setFilter] = useState("");
  const [cats, setCats] = useState<Category[]>([]);
  const [shelf, setShelf] = useState<number | "all">("all");
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    loadCategories().then((r) => setCats(r.categories), () => {});
  }, []);
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
  if (!items) return <Loading label="Loading your library…" />;
  if (items.length === 0) return <p className="muted">Nothing here yet. Open a series from Search and tap Add to library.</p>;

  // The server already lists most recently read first.
  const needle = filter.trim().toLowerCase();
  const shown = items.filter((i) => (!needle || i.title.toLowerCase().includes(needle)) && (shelf === "all" || i.categories.includes(shelf)));
  if (sort === "unread") shown.sort((a, b) => (b.unread ?? 0) - (a.unread ?? 0));
  if (sort === "title") shown.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  const reading = shown.filter((i) => i.progress && (i.unread ?? 1) > 0);
  const rest = shown.filter((i) => !reading.includes(i));
  return (
    <>
      <div className="chips shelves" role="tablist" aria-label="Shelves">
        <button type="button" role="tab" aria-selected={shelf === "all"} className={`chip ${shelf === "all" ? "on" : ""}`} onClick={() => setShelf("all")}>
          All <span className="chipCount">{items.length}</span>
        </button>
        {cats.map((c) => (
          <button key={c.id} type="button" role="tab" aria-selected={shelf === c.id} className={`chip ${shelf === c.id ? "on" : ""}`} onClick={() => setShelf(c.id)}>
            {c.name} <span className="chipCount">{items.filter((i) => i.categories.includes(c.id)).length}</span>
          </button>
        ))}
        <button type="button" className="chip ghost" onClick={() => setEditing(true)}>{cats.length ? "Edit shelves" : "+ Add shelves"}</button>
      </div>
      {editing && (
        <ShelfEditor
          cats={cats}
          onChange={(next) => {
            setCats(next);
            if (shelf !== "all" && !next.some((c) => c.id === shelf)) setShelf("all");
          }}
          onClose={() => setEditing(false)}
        />
      )}
      <div className="toolbar">
        <input
          type="search"
          className="jump"
          placeholder="Filter library"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter your library by title"
        />
        <button type="button" className="linkish" onClick={refresh} disabled={refreshing}>
          {refreshing ? "Checking sources…" : "Check for new chapters"}
        </button>
        <label className="sort-select">
          <span>Sort</span>
          <select
            value={sort}
            onChange={(e) => {
              const v = e.target.value as LibSort;
              setSort(v);
              try {
                localStorage.setItem("sapphire.librarySort", v);
              } catch {
                // Not remembered; fine.
              }
            }}
          >
            {LIB_SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>
      {shown.length === 0 && (
        <p className="muted">
          {needle ? `Nothing here matches "${filter}".` : "No series on this shelf yet. Open a series and pick its shelves under Add to library."}
        </p>
      )}
      {reading.length > 0 && <h3>Continue reading</h3>}
      <ul className="grid">{reading.map((i) => <Card key={i.mangaId} item={i} />)}</ul>
      {rest.length > 0 && <h3>{reading.length ? "Everything else" : "Library"}</h3>}
      <ul className="grid">{rest.map((i) => <Card key={i.mangaId} item={i} />)}</ul>
    </>
  );
}

/** Add, rename and remove shelves (e.g. Reading, Plan to read, Dropped). */
function ShelfEditor({ cats, onChange, onClose }: { cats: Category[]; onChange: (c: Category[]) => void; onClose: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const run = async (p: Promise<{ categories: Category[] }>) => {
    setError(null);
    try {
      onChange((await p).categories);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
  };
  return (
    <div className="sheetBackdrop" onClick={onClose}>
      <div className="sheet shelfSheet" role="dialog" aria-modal="true" aria-label="Shelves" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" aria-hidden="true" />
        <h3>Shelves</h3>
        <p className="muted small">Sort your library onto shelves like Reading, Plan to read or Dropped. A series can be on more than one.</p>
        <ul className="shelfList">
          {cats.map((c) => (
            <li key={c.id}>
              <input
                defaultValue={c.name}
                aria-label={`Rename ${c.name}`}
                maxLength={40}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== c.name && run(renameCategory(c.id, e.target.value))}
              />
              <button type="button" className="iconBtn" aria-label={`Delete ${c.name}`} onClick={() => run(deleteCategory(c.id))}>🗑</button>
            </li>
          ))}
        </ul>
        <form
          className="searchbar"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void run(createCategory(name)).then(() => setName(""));
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New shelf name" maxLength={40} aria-label="New shelf name" />
          <button type="submit" disabled={!name.trim()}>Add</button>
        </form>
        {cats.length === 0 && (
          <div className="chips">
            {["Reading", "Plan to read", "On hold", "Dropped"].map((n) => (
              <button key={n} type="button" className="chip" onClick={() => run(createCategory(n))}>+ {n}</button>
            ))}
          </div>
        )}
        {error && <p className="bad">{error}</p>}
        <button type="button" className="button" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
