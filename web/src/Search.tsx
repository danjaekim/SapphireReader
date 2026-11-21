import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { seriesHref } from "./route";
import { browse, createQueue, genreList, latest, search, thumbnailUrl, type LatestChapter, type SearchResult, type SourceHit } from "./api";

type Chapter = { state: "loading" } | { state: "error" } | { state: "done"; value: LatestChapter };

function formatChapter(n: number | null): string {
  if (n === null) return "no numbered chapters";
  return `Ch. ${Number.isInteger(n) ? n : n.toFixed(1)}`;
}

function bestHit(hits: SourceHit[], chapters: Record<number, Chapter>): SourceHit | null {
  let best: SourceHit | null = null;
  let bestNumber = -1;
  for (const hit of hits) {
    const c = chapters[hit.mangaId];
    if (c?.state === "done" && c.value.latestNumber !== null && c.value.latestNumber > bestNumber) {
      best = hit;
      bestNumber = c.value.latestNumber;
    }
  }
  return best;
}

function GenrePicker({ selected, onChange }: { selected: string[]; onChange: (g: string[]) => void }) {
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

/** Search box plus stackable genre filters. In discover mode, picking genres browses right away. */
export function Search({ initialGenres = [], discover = false }: { initialGenres?: string[]; discover?: boolean }) {
  const [genres, setGenres] = useState<string[]>(initialGenres);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [chapters, setChapters] = useState<Record<number, Chapter>>({});
  // One queue per search, so a new search doesn't wait behind the old one's chapter lookups.
  const queue = useMemo(() => createQueue(4), [result]);

  const canRun = genres.length > 0 || query.trim().length >= 2;
  // Only the newest request may fill in results.
  const runId = useRef(0);

  async function run(g: string[] = genres) {
    const q = query.trim();
    if (g.length === 0 && q.length < 2) return;
    const id = ++runId.current;
    setBusy(true);
    setError(null);
    setResult(null);
    setSkipped([]);
    setChapters({});
    try {
      if (g.length > 0) {
        const r = await browse(g, q);
        if (id !== runId.current) return;
        setSkipped(r.skipped);
        setResult(r);
      } else {
        const r = await search(q);
        if (id === runId.current) setResult(r);
      }
    } catch (err) {
      if (id === runId.current) setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      if (id === runId.current) setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run();
  }

  function changeGenres(next: string[]) {
    setGenres(next);
    // Discover reacts to every change; Search waits for the button unless a genre link brought you here.
    if (discover) void run(next);
  }

  // Arriving from a genre link on a series page runs straight away.
  useEffect(() => {
    if (initialGenres.length > 0) void run(initialGenres);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Chapter lists come from the source sites and are slow, so they fill in after results appear.
  useEffect(() => {
    if (!result) return;
    let cancelled = false;
    for (const group of result.groups) {
      for (const hit of group.hits) {
        setChapters((prev) => ({ ...prev, [hit.mangaId]: { state: "loading" } }));
        queue(() => latest(hit.mangaId)).then(
          (value) => !cancelled && setChapters((prev) => ({ ...prev, [hit.mangaId]: { state: "done", value } })),
          () => !cancelled && setChapters((prev) => ({ ...prev, [hit.mangaId]: { state: "error" } })),
        );
      }
    }
    return () => {
      cancelled = true;
    };
  }, [result, queue]);

  return (
    <section>
      <form className="searchbar" onSubmit={onSubmit} role="search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={genres.length ? "Optional: add words to narrow it down" : "Search all sources"}
          aria-label="Search all sources"
        />
        <button type="submit" disabled={busy || !canRun}>
          {busy ? "Searching…" : genres.length ? "Apply" : "Search"}
        </button>
      </form>
      <GenrePicker selected={genres} onChange={changeGenres} />

      {error && <p className="bad">{error}</p>}
      {busy && <p className="muted">Searching every source. This can take several seconds.</p>}

      {result && (
        <>
          <p className="muted">
            {result.groups.length} {result.groups.length === 1 ? "series" : "series"} from {result.searched} sources.
            {result.failed.length > 0 && (
              <> Didn't answer: {result.failed.map((f) => f.sourceName).join(", ")}.</>
            )}
            {skipped.length > 0 && <> Left out because they can't filter by every genre picked: {skipped.join(", ")}.</>}
          </p>
          <ul className="results">
            {result.groups.map((group) => {
              const best = bestHit(group.hits, chapters);
              const cover = (best ?? group.hits[0]).mangaId;
              return (
                <li key={group.key} className="result">
                  <img src={thumbnailUrl(cover)} alt="" loading="lazy" width={72} height={104} />
                  <div className="info">
                    <h3>
                      <a href={seriesHref(cover)}>{group.title}</a>
                    </h3>
                    <ul className="sources">
                      {group.hits.map((hit) => {
                        const c = chapters[hit.mangaId];
                        const isBest = best?.mangaId === hit.mangaId && group.hits.length > 1;
                        return (
                          <li key={hit.mangaId} className={isBest ? "best" : undefined}>
                            <a href={seriesHref(hit.mangaId)}>{hit.sourceName}</a>
                            <span className="muted">
                              {c?.state === "done"
                                ? formatChapter(c.value.latestNumber)
                                : c?.state === "error"
                                  ? "unavailable"
                                  : "loading…"}
                            </span>
                            {isBest && <span className="tag">most recent</span>}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
