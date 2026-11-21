import { useEffect, useMemo, useRef, useState } from "react";
import { seriesHref } from "./route";
import { createQueue, latest, thumbnailUrl, type LatestChapter, type SearchResult, type SeriesGroup } from "./api";

type Chapter = { state: "loading" } | { state: "error" } | { state: "done"; value: LatestChapter };
type Queue = ReturnType<typeof createQueue>;

function formatChapter(n: number | null): string {
  if (n === null) return "no numbered chapters";
  return `Ch. ${Number.isInteger(n) ? n : n.toFixed(1)}`;
}

/** True once the element has scrolled near the screen. */
function useNearScreen<T extends Element>(margin = "300px") {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [near, margin]);
  return [ref, near] as const;
}

function Card({ group, queue, lookups }: { group: SeriesGroup; queue: Queue; lookups: boolean }) {
  const [ref, near] = useNearScreen<HTMLLIElement>();
  const [chapters, setChapters] = useState<Record<number, Chapter>>({});

  // Only cards you can almost see look up their chapters; the sites would otherwise be asked for hundreds at once.
  useEffect(() => {
    if (!lookups || !near) return;
    let cancelled = false;
    for (const hit of group.hits) {
      setChapters((prev) => (prev[hit.mangaId] ? prev : { ...prev, [hit.mangaId]: { state: "loading" } }));
      queue(() => latest(hit.mangaId)).then(
        (value) => !cancelled && setChapters((prev) => ({ ...prev, [hit.mangaId]: { state: "done", value } })),
        () => !cancelled && setChapters((prev) => ({ ...prev, [hit.mangaId]: { state: "error" } })),
      );
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, lookups, group.hits.length]);

  let best = null as null | { mangaId: number; sourceName: string; n: number };
  for (const hit of group.hits) {
    const c = chapters[hit.mangaId];
    if (c?.state === "done" && c.value.latestNumber !== null && (!best || c.value.latestNumber > best.n)) {
      best = { mangaId: hit.mangaId, sourceName: hit.sourceName, n: c.value.latestNumber };
    }
  }
  const target = best?.mangaId ?? group.hits[0].mangaId;
  const loading = lookups && group.hits.some((h) => !chapters[h.mangaId] || chapters[h.mangaId].state === "loading");

  return (
    <li className="gridCard" ref={ref}>
      <a href={seriesHref(target)} className="gridCover">
        <img src={thumbnailUrl(target)} alt="" loading="lazy" />
        {group.hits.length > 1 && <span className="badge">{group.hits.length} sources</span>}
      </a>
      <a href={seriesHref(target)} className="gridTitle" title={group.title}>
        {group.title}
      </a>
      <span className="muted gridMeta">
        {best
          ? `${formatChapter(best.n)} · ${best.sourceName}`
          : lookups
            ? loading
              ? "checking sources…"
              : "unavailable"
            : group.hits.map((h) => h.sourceName).join(", ")}
      </span>
    </li>
  );
}

/**
 * A responsive grid of series. `onMore` is called as the end of the grid scrolls into view,
 * `lookups` fetches each source's latest chapter for visible cards.
 */
export function Results({
  result,
  note,
  empty,
  lookups = true,
  hasMore = false,
  onMore,
}: {
  result: SearchResult;
  note?: string;
  empty?: string;
  lookups?: boolean;
  hasMore?: boolean;
  onMore?: () => void;
}) {
  const queue = useMemo(() => createQueue(4), []);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = end.current;
    if (!el || !hasMore || !onMore) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onMore, result]);

  const shownNote = note ?? result.note;
  return (
    <>
      <p className="muted">
        {result.groups.length} series{result.searched > 0 ? ` from ${result.searched} sources` : ""}.
        {result.failed.length > 0 && <> Didn't answer: {result.failed.map((f) => f.sourceName).join(", ")}.</>}
        {shownNote && <> {shownNote}</>}
      </p>
      {result.groups.length === 0 && empty && <p className="muted">{empty}</p>}
      <ul className="grid">
        {result.groups.map((group) => (
          <Card key={group.key} group={group} queue={queue} lookups={lookups} />
        ))}
      </ul>
      <div ref={end} className="gridEnd muted">{hasMore ? "Loading more…" : result.groups.length > 0 ? "That's everything." : ""}</div>
    </>
  );
}
