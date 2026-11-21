import { useEffect, useMemo, useState } from "react";
import { seriesHref } from "./route";
import { createQueue, latest, thumbnailUrl, type LatestChapter, type SearchResult, type SourceHit } from "./api";

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

/** A list of series, each with the sources that carry it and their latest chapters (filled in lazily). */
/** `lookups` fetches each source's latest chapter, which hits the sites, so long browse lists turn it off. */
export function Results({ result, note, empty, lookups = true }: { result: SearchResult; note?: string; empty?: string; lookups?: boolean }) {
  const [chapters, setChapters] = useState<Record<number, Chapter>>({});
  // One queue per result set, so a new one doesn't wait behind the old one's chapter lookups.
  const queue = useMemo(() => createQueue(4), [result]);

  useEffect(() => {
    setChapters({});
    let cancelled = false;
    if (!lookups) return;
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
  }, [result, queue, lookups]);

  return (
    <>
      <p className="muted">
        {result.groups.length} series from {result.searched} sources.
        {result.failed.length > 0 && <> Didn't answer: {result.failed.map((f) => f.sourceName).join(", ")}.</>}
        {note && <> {note}</>}
      </p>
      {result.groups.length === 0 && empty && <p className="muted">{empty}</p>}
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
  );
}
