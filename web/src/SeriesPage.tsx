import { Loading } from "./Loading";
import { useEffect, useState } from "react";
import { addToLibrary, alternatives, categories as loadCategories, markChapters, setSeriesCategories, type Category, removeFromLibrary, series, similar, thumbnailUrl, type Alternative, type SeriesData, type SeriesGroup } from "./api";
import { genreHref, readHref } from "./route";
import { TrackerLinkCard } from "./Trackers";
import { useSeriesDownloads } from "./useDownloads";
import { useScore } from "./shared";
import { chapterDate } from "./util";

function chapterLabel(c: { name: string; chapterNumber: number }): string {
  return c.chapterNumber >= 0 ? `Ch. ${Number.isInteger(c.chapterNumber) ? c.chapterNumber : c.chapterNumber.toFixed(1)}` : c.name;
}

export function DownloadButton({ state, onDownload }: { state?: { status: string; error: string | null }; onDownload: () => void }) {
  if (state?.status === "done") return <span className="dlState done" title="Saved on the NAS. Remove it from the Downloads page.">✓</span>;
  if (state?.status === "queued" || state?.status === "downloading") {
    return <span className="dlState" title={state.status === "queued" ? "Waiting to download" : "Downloading"}>…</span>;
  }
  return (
    <button type="button" className="dlBtn" onClick={onDownload} title={state?.status === "failed" ? `Failed: ${state.error ?? "try again"}. Tap to retry.` : "Download this chapter to the NAS"} aria-label="Download chapter">
      {state?.status === "failed" ? "⚠" : "⬇"}
    </button>
  );
}

export function SeriesPage({ mangaId }: { mangaId: number }) {
  const [data, setData] = useState<SeriesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newestFirst, setNewestFirst] = useState(true);
  const [fullDesc, setFullDesc] = useState(false);
  const [jump, setJump] = useState("");
  const score = useScore(data?.manga.title ?? null);
  const [fullAlt, setFullAlt] = useState(false);
  // After marking one chapter read, offer to mark the unread ones before it too (handy when you read them elsewhere).
  const [shelves, setShelves] = useState<Category[]>([]);
  useEffect(() => {
    loadCategories().then((r) => setShelves(r.categories), () => {});
  }, []);
  const [offer, setOffer] = useState<{ label: string; ids: number[] } | null>(null);

  const { states, download } = useSeriesDownloads(mangaId);
  const [similarGroups, setSimilarGroups] = useState<SeriesGroup[] | null>(null);
  const [basedOn, setBasedOn] = useState<string[]>([]);
  const [others, setOthers] = useState<Alternative[] | null>(null);

  // Similar series load on their own once the series itself is up, so the page isn't held back.
  const loaded = data !== null;
  useEffect(() => {
    setSimilarGroups(null);
    if (!loaded) return;
    let cancelled = false;
    similar(mangaId).then(
      (r) => {
        if (cancelled) return;
        setSimilarGroups(r.groups);
        setBasedOn(r.basedOn ?? []);
      },
      () => !cancelled && setSimilarGroups([]),
    );
    return () => {
      cancelled = true;
    };
  }, [mangaId, loaded]);

  useEffect(() => {
    setOthers(null);
    alternatives(mangaId).then((r) => setOthers(r.alternatives), () => setOthers([]));
  }, [mangaId]);

  useEffect(() => {
    setData(null);
    setError(null);
    series(mangaId).then(setData, (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load this series."));
  }, [mangaId]);

  // Tab title (left plain for 18+ series, so they stay out of browser history).
  useEffect(() => {
    if (!data || data.adult) return;
    document.title = `${data.manga.title} · Sapphire`;
    return () => {
      document.title = "Sapphire";
    };
  }, [data?.manga.title]);

  async function mark(chapterIds: number[], read: boolean) {
    if (!data) return;
    const before = data;
    const ids = new Set(data.readChapterIds);
    for (const id of chapterIds) (read ? ids.add(id) : ids.delete(id));
    setData({ ...data, readChapterIds: [...ids] });
    try {
      const r = await markChapters(mangaId, chapterIds, read);
      setData((d) => (d ? { ...d, readChapterIds: r.readChapterIds, progress: r.progress } : d));
    } catch {
      setData(before);
    }
  }

  async function toggleLibrary() {
    if (!data) return;
    const next = !data.inLibrary;
    setData({ ...data, inLibrary: next });
    try {
      if (next) await addToLibrary(mangaId, data.manga.sourceId, data.manga.sourceName, data.manga.title);
      else await removeFromLibrary(mangaId);
    } catch {
      setData((d) => (d ? { ...d, inLibrary: !next } : d));
    }
  }

  const readIds = new Set(data?.readChapterIds ?? []);
  const about = data?.about ?? { body: data?.manga.description ?? "", altTitles: [], stats: [] };
  const unread = data ? data.chapters.filter((c) => !readIds.has(c.id) && states[c.id]?.status !== "done") : [];
  const notSaved = data ? data.chapters.filter((c) => !states[c.id] || states[c.id].status === "failed") : [];
  const working = Object.values(states).filter((d) => d.status === "queued" || d.status === "downloading").length;
  const resume = data?.progress ? data.chapters.find((c) => c.id === data.progress!.chapterId) : undefined;
  // Finished the chapter you were on: point at the next one, or say you're caught up.
  const resumeDone = !!resume && readIds.has(resume.id);
  const next = resume && resumeDone ? data!.chapters[data!.chapters.indexOf(resume) + 1] : undefined;
  const caughtUp = resumeDone && !next;

  return (
    <section>
      <a className="back" href="#/">← Back</a>
      {error && <p className="bad">{error}</p>}
      {!data && !error && <Loading label="Loading from the source. This can take several seconds." size="lg" />}
      {data && (
        <>
          <div className="seriesHead">
            <img src={thumbnailUrl(mangaId)} alt="" width={120} height={173} />
            <div className="info">
              <h2>{data.manga.title}</h2>
              {about.altTitles.length > 0 && (
                <p className={`altTitles ${fullAlt ? "open" : ""}`}>
                  {(fullAlt ? about.altTitles : about.altTitles.slice(0, 3)).join(" · ")}
                  {about.altTitles.length > 3 && (
                    <button type="button" className="linkish" onClick={() => setFullAlt((v) => !v)}>
                      {fullAlt ? " less" : ` +${about.altTitles.length - 3} more`}
                    </button>
                  )}
                </p>
              )}
              <p className="muted">
                {[data.manga.sourceName, data.manga.status.toLowerCase(), data.manga.author].filter(Boolean).join(" · ")}
              </p>
              {(score != null || about.stats.length > 0) && (
                <ul className="statChips">
                  {about.stats.map((st) => (
                    <li key={st.label} title={`From ${data.manga.sourceName ?? "the source"}`}>
                      <span className="muted">{st.label}</span> <strong>{st.value}</strong>
                    </li>
                  ))}
                  {score != null && (
                    <li title="AniList average score">
                      <span className="muted">AniList</span> <strong className="seriesScore">★ {(score / 10).toFixed(1)}</strong>
                    </li>
                  )}
                </ul>
              )}
              <p className="muted">
                {data.latest.latestNumber !== null
                  ? `${data.latest.chapterCount} chapters, latest ${chapterLabel({ name: "", chapterNumber: data.latest.latestNumber })}`
                  : `${data.latest.chapterCount} chapters`}
              </p>
              <div className="actions">
                {data.chapters.length > 0 &&
                  (caughtUp ? (
                    <span className="button caughtUp" title={`You've read up to ${chapterLabel(resume!)}, the newest chapter.`}>Caught up ✓</span>
                  ) : (
                    <a className="button" href={readHref(mangaId, (next ?? resume ?? data.chapters[0]).id)}>
                      {next ? `Next: ${chapterLabel(next)}` : resume ? `Continue ${chapterLabel(resume)}` : "Start reading"}
                    </a>
                  ))}
                <button type="button" className="button secondary" onClick={toggleLibrary}>
                  {data.inLibrary ? "In library ✓" : "Add to library"}
                </button>
              </div>
              {data.inLibrary && shelves.length > 0 && (
                <div className="chips shelfPick" aria-label="Shelves">
                  {shelves.map((c) => {
                    const on = (data.categories ?? []).includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className={`chip small ${on ? "on" : ""}`}
                        aria-pressed={on}
                        onClick={() => {
                          const ids = on ? (data.categories ?? []).filter((x) => x !== c.id) : [...(data.categories ?? []), c.id];
                          setData({ ...data, categories: ids });
                          setSeriesCategories(mangaId, ids).catch(() => setData(data));
                        }}
                      >
                        {on ? "✓ " : ""}{c.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          {data.manga.genre.length > 0 && (
            <ul className="genres">
              {data.manga.genre.map((g) => (
                <li key={g}><a className="tag" href={genreHref(g, data.manga.id, data.adult)}>{g}</a></li>
              ))}
            </ul>
          )}
          {about.body && (
            <div className="descWrap">
              <p className={`desc ${fullDesc ? "" : "clamped"}`}>{about.body}</p>
              {about.body.length > 280 && (
                <button type="button" className="linkish" onClick={() => setFullDesc((v) => !v)}>
                  {fullDesc ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}
          {others && others.length > 0 && (
            <div className="card">
              <h3>Also on</h3>
              <ul className="sources">
                {others.map((o) => {
                  const ahead = o.latestNumber !== null && data.latest.latestNumber !== null && o.latestNumber > data.latest.latestNumber;
                  return (
                    <li key={o.mangaId} className={ahead ? "best" : undefined}>
                      <a href={`#/series/${o.mangaId}`}>{o.sourceName}</a>
                      <span className="muted">{o.latestNumber !== null ? chapterLabel({ name: "", chapterNumber: o.latestNumber }) : "no numbered chapters"}</span>
                      {ahead && <span className="tag">further ahead</span>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <TrackerLinkCard mangaId={mangaId} title={data.manga.title} />
          {similarGroups === null && <Loading label="Finding similar series…" size="sm" />}
          {similarGroups && similarGroups.length > 0 && (
            <div className="card">
              <h3>Similar series</h3>
              {basedOn.length > 0 && <p className="muted small">Matched mostly on {basedOn.join(", ")}.</p>}
              <ul className="similar">
                {similarGroups.map((g) => (
                  <li key={g.key}>
                    <a href={`#/series/${g.hits[0].mangaId}`}>
                      <img src={thumbnailUrl(g.hits[0].mangaId)} alt="" loading="lazy" width={80} height={116} />
                      <span>{g.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="chapterHead">
            <h3>
              Chapters{" "}
              {data.chapters.length > 0 && (
                <span className="muted small">
                  {data.chapters.filter((c) => !readIds.has(c.id)).length} unread of {data.chapters.length}
                </span>
              )}
            </h3>
            <div className="chapterTools">
              {data.chapters.length > 30 && (
                <input
                  type="search"
                  inputMode="decimal"
                  className="jump"
                  placeholder="Find chapter"
                  value={jump}
                  onChange={(e) => setJump(e.target.value)}
                  aria-label="Find a chapter by number or name"
                />
              )}
              <button type="button" className="linkish" onClick={() => setNewestFirst((v) => !v)}>
                {newestFirst ? "Newest first" : "Oldest first"}
              </button>
            </div>
          </div>
          <div className="actions dlActions">
            <button type="button" className="button small secondary" disabled={notSaved.length === 0} onClick={() => download(data.manga, notSaved)}>
              Download all{notSaved.length ? ` (${notSaved.length})` : ""}
            </button>
            <button
              type="button"
              className="button small secondary"
              disabled={unread.filter((c) => !states[c.id]).length === 0}
              onClick={() => download(data.manga, unread.filter((c) => !states[c.id] || states[c.id].status === "failed"))}
            >
              Download unread
            </button>
            {working > 0 && <span className="muted">Downloading {working} chapter{working === 1 ? "" : "s"} to the NAS…</span>}
          </div>
          {offer && (
            <div className="offer">
              <span>Also mark the {offer.ids.length} unread chapter{offer.ids.length === 1 ? "" : "s"} before {offer.label} as read?</span>
              <button type="button" className="button small" onClick={() => { void mark(offer.ids, true); setOffer(null); }}>Mark read</button>
              <button type="button" className="linkish" onClick={() => setOffer(null)}>No thanks</button>
            </div>
          )}
          <ul className="chapters">
            {(newestFirst ? [...data.chapters].reverse() : data.chapters)
              .filter((c) => !jump.trim() || chapterLabel(c).toLowerCase().includes(jump.trim().toLowerCase()) || c.name.toLowerCase().includes(jump.trim().toLowerCase()))
              .map((c) => (
              <li key={c.id} className={readIds.has(c.id) ? "read" : undefined}>
                <a href={readHref(mangaId, c.id)}>
                  <span>{chapterLabel(c)}</span>
                  {c.name && c.chapterNumber >= 0 && c.name !== chapterLabel(c) && <span className="muted"> {c.name}</span>}
                  <span className="muted date" title={c.uploadDate ? new Date(c.uploadDate).toLocaleDateString() : undefined}>{chapterDate(c.uploadDate)}</span>
                </a>
                <button
                  type="button"
                  className="dlBtn"
                  title={readIds.has(c.id) ? "Mark as unread" : "Mark as read"}
                  aria-label={readIds.has(c.id) ? "Mark as unread" : "Mark as read"}
                  onClick={() => {
                    const read = !readIds.has(c.id);
                    void mark([c.id], read);
                    const earlier = data.chapters.slice(0, data.chapters.indexOf(c)).filter((x) => !readIds.has(x.id)).map((x) => x.id);
                    setOffer(read && earlier.length > 0 ? { label: chapterLabel(c), ids: earlier } : null);
                  }}
                >
                  {readIds.has(c.id) ? "◉" : "○"}
                </button>
                <DownloadButton state={states[c.id]} onDownload={() => download(data.manga, [c])} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
