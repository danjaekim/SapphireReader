import { useEffect, useMemo, useState, type FormEvent } from "react";
import { seriesHref } from "./route";
import { createQueue, latest, search, thumbnailUrl, type LatestChapter, type SearchResult, type SourceHit } from "./api";

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

export function Search() {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [chapters, setChapters] = useState<Record<number, Chapter>>({});
  // One queue per search, so a new search doesn't wait behind the old one's chapter lookups.
  const queue = useMemo(() => createQueue(4), [result]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setChapters({});
    try {
      setResult(await search(q));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

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
          placeholder="Search all sources"
          aria-label="Search all sources"
        />
        <button type="submit" disabled={busy || query.trim().length < 2}>
          {busy ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="bad">{error}</p>}
      {busy && <p className="muted">Searching every source. This can take several seconds.</p>}

      {result && (
        <>
          <p className="muted">
            {result.groups.length} {result.groups.length === 1 ? "series" : "series"} from {result.searched} sources.
            {result.failed.length > 0 && (
              <> Didn't answer: {result.failed.map((f) => f.sourceName).join(", ")}.</>
            )}
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
