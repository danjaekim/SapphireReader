import { useEffect, useRef, useState, type FormEvent } from "react";
import { browse, search, type SearchResult } from "./api";
import { GenrePicker } from "./GenrePicker";
import { Results } from "./Results";

/** Search box plus stackable genre filters. */
export function Search({ initialGenres = [] }: { initialGenres?: string[] }) {
  const [genres, setGenres] = useState<string[]>(initialGenres);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
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

  // Arriving from a genre link on a series page runs straight away.
  useEffect(() => {
    if (initialGenres.length > 0) void run(initialGenres);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <GenrePicker selected={genres} onChange={setGenres} />
      {error && <p className="bad">{error}</p>}
      {busy && <p className="muted">Searching every source. This can take several seconds.</p>}
      {result && (
        <Results
          result={result}
          note={skipped.length > 0 ? `Left out because they can't filter by every genre picked: ${skipped.join(", ")}.` : undefined}
        />
      )}
    </section>
  );
}
