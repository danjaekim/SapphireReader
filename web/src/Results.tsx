import { tidyTitle } from "./titles";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { seriesHref } from "./route";
import { bestRating, useHiddenAdult, useLibraryIds, useRating } from "./shared";
import { createQueue, latest, thumbnailUrl, type LatestChapter, type SearchResult, type SeriesGroup } from "./api";

/**
 * Picking several cards at once (Discover's Select mode). While active, tapping a card selects it
 * instead of opening it; cards whose keys are in `gone` have been moved off this page.
 */
export interface Selection {
  active: boolean;
  selected: Set<string>;
  toggle: (group: SeriesGroup) => void;
  gone: Set<string>;
}
export const SelectionContext = createContext<Selection | null>(null);

type Chapter = { state: "loading" } | { state: "error"; reason?: string } | { state: "done"; value: LatestChapter };
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

/** Placeholder cards in the grid's own layout (and a shelf's, inside one) while results are on their way. */
function SkeletonCard({ i }: { i: number }) {
  return (
    <li className="gridCard skelItem" aria-hidden="true">
      <div className="skel skelCard" />
      <div className="skel skelLine" style={{ width: `${62 + ((i * 13) % 30)}%` }} />
      <div className="skel skelLine skelSmall" style={{ width: `${35 + ((i * 7) % 20)}%` }} />
    </li>
  );
}

export function SkeletonCards({ count = 12, className = "" }: { count?: number; className?: string }) {
  return (
    <ul className={`grid skelCards ${className}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="gridCard">
          <div className="skel skelCard" />
          <div className="skel skelLine" style={{ width: `${62 + ((i * 13) % 30)}%` }} />
          <div className="skel skelLine skelSmall" style={{ width: `${35 + ((i * 7) % 20)}%` }} />
        </li>
      ))}
    </ul>
  );
}

/** A first load: what's happening in words (for screen readers too), over a grid of placeholder cards. */
export function SkeletonResults({ label, count = 12 }: { label: string; count?: number }) {
  return (
    <div aria-busy="true">
      <p className="muted resultMeta" role="status">{label}</p>
      <SkeletonCards count={count} />
    </div>
  );
}

/** Placeholder shelves (For you rows) while they're worked out. */
export function SkeletonShelves({ count = 2, label }: { count?: number; label?: string }) {
  return (
    <div className="shelves" aria-busy="true">
      {label && <p className="muted resultMeta" role="status">{label}</p>}
      {Array.from({ length: count }, (_, i) => (
        <section key={i} className="shelf">
          <header className="shelfHead">
            <span className="skel skelLine" style={{ width: `${40 + i * 12}%`, height: 18 }} />
          </header>
          <SkeletonCards count={6} />
        </section>
      ))}
    </div>
  );
}

/** A cover that fades in once loaded, over the card's placeholder (no pop-in of half-drawn images). */
function CoverImg({ src }: { src: string }) {
  const [shown, setShown] = useState(false);
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      className={shown ? "loaded" : "loading"}
      ref={(el) => {
        if (el?.complete && el.naturalWidth > 0 && !shown) setShown(true);
      }}
      onLoad={() => setShown(true)}
      onError={() => setShown(true)}
    />
  );
}

function Card({ group, queue, lookups, hideBad, onBad, onDismiss }: { group: SeriesGroup; queue: Queue; lookups: boolean; hideBad: boolean; onBad: (key: string, bad: boolean) => void; onDismiss?: (group: SeriesGroup, on: boolean) => void }) {
  const [dismissed, setDismissed] = useState(false);
  const [ref, near] = useNearScreen<HTMLLIElement>();
  const sel = useContext(SelectionContext);
  const sourceNames = [...new Set(group.hits.map((h) => h.sourceName))];
  const [chapters, setChapters] = useState<Record<number, Chapter>>({});
  const [tries, setTries] = useState(0);

  // Only cards you can almost see look up their chapters; the sites would otherwise be asked for hundreds at once.
  useEffect(() => {
    if (!lookups || !near) return;
    let cancelled = false;
    for (const hit of group.hits) {
      if (tries === 0 ? chapters[hit.mangaId] : chapters[hit.mangaId]?.state !== "error") continue;
      setChapters((prev) => ({ ...prev, [hit.mangaId]: { state: "loading" } }));
      queue(() => latest(hit.mangaId)).then(
        (value) => !cancelled && setChapters((prev) => ({ ...prev, [hit.mangaId]: { state: "done", value } })),
        (e: unknown) => {
          if (cancelled) return;
          setChapters((prev) => ({ ...prev, [hit.mangaId]: { state: "error", reason: (e as { detail?: string })?.detail } }));
          // Sites often fail once and answer the next time (especially when a search asks many at once):
          // try each failure again after a pause, twice, before giving up.
          if (tries < 2) window.setTimeout(() => !cancelled && setTries(tries + 1), tries === 0 ? 5000 : 15000);
        },
      );
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, lookups, group.hits.length, tries]);

  let best = null as null | { mangaId: number; sourceName: string; n: number };
  for (const hit of group.hits) {
    const c = chapters[hit.mangaId];
    if (c?.state === "done" && c.value.latestNumber !== null && (!best || c.value.latestNumber > best.n)) {
      best = { mangaId: hit.mangaId, sourceName: hit.sourceName, n: c.value.latestNumber };
    }
  }
  const target = best?.mangaId ?? group.hits[0].mangaId;
  const lib = useLibraryIds();
  const hit = group.hits.find((h) => h.mangaId === target) ?? group.hits[0];
  const saved = group.hits.some((h) => lib.has(h.mangaId));
  const fetched = useRating(group.title, group.score == null && near);
  const rating = group.score != null ? { value: group.score / 10, source: "AniList" } : bestRating(fetched);
  const allFailed = lookups && tries > 1 && group.hits.every((h) => chapters[h.mangaId]?.state === "error");
  useEffect(() => {
    onBad(group.key, allFailed);
    return () => onBad(group.key, false);
  }, [allFailed, group.key]);
  const failReason = group.hits.map((h) => (chapters[h.mangaId] as { reason?: string } | undefined)?.reason).find(Boolean);
  const loading = lookups && group.hits.some((h) => !chapters[h.mangaId] || chapters[h.mangaId].state === "loading");

  // Adult series from mixed sites stay out of sight while 18+ mode is off.
  const adultHidden = useHiddenAdult({ mangaId: group.hits[0].mangaId, title: group.title, sourceId: group.hits[0].sourceId }, near);
  if (adultHidden) return null;
  if (sel?.gone.has(group.key)) return null;
  const picking = sel?.active === true;
  const picked = picking && sel!.selected.has(group.key);
  if (hideBad && allFailed) return null;
  if (dismissed) {
    return (
      <li className="gridCard dismissedCard" ref={ref}>
        <p>Won't suggest <strong>{tidyTitle(group.title)}</strong> again.</p>
        <button type="button" className="button secondary small" onClick={() => { setDismissed(false); onDismiss?.(group, false); }}>Undo</button>
      </li>
    );
  }
  return (
    <li className={`gridCard ${allFailed ? "unavailable" : ""} ${onDismiss && !picking ? "dismissable" : ""} ${picking ? "picking" : ""} ${picked ? "picked" : ""}`} ref={ref}>
      {picking && (
        <button type="button" className="pickOverlay" aria-pressed={picked} aria-label={`${picked ? "Deselect" : "Select"} ${tidyTitle(group.title)}`} onClick={() => sel!.toggle(group)}>
          <span className="pickBox" aria-hidden="true">{picked ? "✓" : ""}</span>
        </button>
      )}
      {onDismiss && !picking && (
        <button type="button" className="dismissBtn" aria-label={`Not interested in ${tidyTitle(group.title)}`} title="Not interested" onClick={() => { setDismissed(true); onDismiss(group, true); }}>
          <span aria-hidden="true">✕</span>
        </button>
      )}
      <a href={seriesHref(target)} className="gridCover">
        <CoverImg src={thumbnailUrl(group.cover ?? target)} />
        {sourceNames.length > 1 && <span className="badge">{sourceNames.length} sources</span>}
        {rating && <span className="badge score" title={`${rating.source} rating`}>★ {rating.value.toFixed(1)}</span>}
      </a>
      {lib.ready && !picking && (
        <button
          type="button"
          className={`addBtn ${saved ? "on" : ""}`}
          onClick={() => void lib.toggle(saved ? (group.hits.find((h) => lib.has(h.mangaId)) ?? hit) : hit)}
          aria-label={saved ? "Remove from library" : "Add to library"}
          title={saved ? "In your library (tap to remove)" : "Add to library"}
        >
          <span className="addIc" aria-hidden="true">{saved ? "✓" : "＋"}</span>
          <span className="addIcHover" aria-hidden="true">{saved ? "✕" : "＋"}</span>
        </button>
      )}
      <a href={seriesHref(target)} className="gridTitle" title={group.title}>
        {tidyTitle(group.title)}
      </a>
      <span className="muted gridMeta">
        {best
          ? `${formatChapter(best.n)} · ${best.sourceName}`
          : lookups
            ? loading
              ? "checking sources…"
              : (
                <span title={failReason ? `The source said: ${failReason}` : "The source didn't answer for this series."}>
                  {failReason && failReason.length <= 40 ? `${failReason.replace(/\.$/, "").toLowerCase()}` : "couldn't load"} ·{" "}
                  <button type="button" className="linkish inlineRetry" onClick={() => setTries((n) => n + 1)}>retry</button>
                </span>
              )
            : sourceNames.join(", ")}
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
  compact = false,
  onDismiss,
}: {
  result: SearchResult;
  note?: string;
  empty?: string;
  lookups?: boolean;
  hasMore?: boolean;
  onMore?: () => void;
  /** Just the grid: no count line or end marker (for rows inside a bigger page). */
  compact?: boolean;
  /** Offers "Not interested" on each card (recommendations only). */
  onDismiss?: (group: SeriesGroup, on: boolean) => void;
}) {
  const queue = useMemo(() => createQueue(4), []);
  const [bad, setBad] = useState<Set<string>>(new Set());
  const [hideBad, setHideBad] = useState(false);
  const onBad = useMemo(
    () => (key: string, isBad: boolean) =>
      setBad((prev) => {
        if (prev.has(key) === isBad) return prev;
        const next = new Set(prev);
        isBad ? next.add(key) : next.delete(key);
        return next;
      }),
    [],
  );
  const end = useRef<HTMLDivElement>(null);
  // How many columns the grid has right now, so the placeholders can fill the last row.
  const gridRef = useRef<HTMLUListElement>(null);
  const [cols, setCols] = useState(4);
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const measure = () => setCols(Math.max(1, getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = end.current;
    if (!el || !hasMore || !onMore) return;
    // Two and a half screens early: the next page is usually fetched already (usePaged asks one page ahead),
    // so its cards land well before you get there.
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onMore(), { rootMargin: "0px 0px 250% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onMore, result]);

  const shownNote = note ?? result.note;
  return (
    <>
      {!compact && <p className="muted resultMeta">
        {result.groups.length} series{result.searched > 0 ? ` from ${result.searched} source${result.searched === 1 ? "" : "s"}` : ""}.
        {result.failed.length > 0 && <> Didn't answer: {result.failed.map((f) => f.sourceName).join(", ")}.</>}
        {shownNote && <> {shownNote}</>}
        {bad.size > 0 && (
          <>
            {" "}
            {bad.size} couldn't load.{" "}
            <button type="button" className="linkish" onClick={() => setHideBad((v) => !v)}>
              {hideBad ? "Show them" : "Hide them"}
            </button>
          </>
        )}
      </p>}
      {result.groups.length === 0 && empty && <p className="muted">{empty}</p>}
      <ul className="grid" ref={gridRef}>
        {result.groups.map((group) => (
          <Card key={group.key} group={group} queue={queue} lookups={lookups} hideBad={hideBad} onBad={onBad} onDismiss={onDismiss} />
        ))}
        {/* Placeholders for the next page, in the same grid: they finish the last row, then add one more. */}
        {!compact && hasMore && Array.from({ length: (cols - (result.groups.length % cols)) % cols + cols }, (_, i) => <SkeletonCard key={`sk${i}`} i={i} />)}
      </ul>
      {!compact && <div ref={end} className="gridEnd muted">
        {hasMore ? <span className="srOnly" role="status">Loading more…</span> : result.groups.length > 0 ? "That's everything." : ""}
      </div>}
    </>
  );
}
