import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Loading } from "./Loading";
import { VERSION_PRESETS, chapterPages, dismissMerge, mergeSuggestions, mergeTitle, series, setVersion, thumbnailUrl, type MergeSuggestion, type SeriesData } from "./api";
import { seriesHref } from "./route";
import { tidyTitle } from "./titles";
import { toast, toastError } from "./toast";
import { chapterDate, chapterText } from "./util";

/** One side of a pair to compare: the listing, plus the version word its name carries (if any). */
export interface CompareSide {
  mangaId: number;
  title: string;
  sourceName: string | null;
  label: string | null;
}

const VERSION_CHOICES = VERSION_PRESETS;

function excerpt(text: string | undefined | null, n = 260): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n).replace(/\s+\S*$/, "") + "…" : t;
}

/** Who scanlates the newest chapters (the last few names, most recent first). */
function scanlators(d: SeriesData): string[] {
  const out: string[] = [];
  for (const c of [...d.chapters].reverse().slice(0, 20)) {
    const s = c.scanlator?.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, 2);
}

/**
 * The two listings side by side before merging: covers, chapters, who scanlates them, the blurb and a page
 * from the same chapter in each, so you can see which is cleaner or uncensored. You pick which one becomes
 * main and set each one's version label; name, cover and description can still be mixed later in Manage.
 */
export function CompareSheet({ a, b, onMerged, onClose }: { a: CompareSide; b: CompareSide; onMerged: (mainId: number) => void; onClose: () => void }) {
  const sides = [a, b];
  const [data, setData] = useState<(SeriesData | null | undefined)[]>([undefined, undefined]);
  const [main, setMain] = useState<number | null>(null);
  const [labels, setLabels] = useState<(string | null)[]>([a.label, b.label]);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ number: number; label: string; pages: (string[] | null)[]; index: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

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

  useEffect(() => {
    let live = true;
    Promise.all(sides.map((s) => series(s.mangaId).catch(() => null))).then((ds) => {
      if (!live) return;
      setData(ds);
      // Labels: a version already set wins over the word in the name.
      setLabels((ls) => ls.map((l, i) => ds[i]?.version ?? l));
      // Main: the plainly named one; otherwise the one with more chapters.
      const plain = sides.findIndex((s, i) => !(ds[i]?.version ?? s.label));
      const more = (ds[1]?.latest.chapterCount ?? 0) > (ds[0]?.latest.chapterCount ?? 0) ? 1 : 0;
      setMain(plain >= 0 && sides.filter((s, i) => !(ds[i]?.version ?? s.label)).length === 1 ? plain : more);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.mangaId, b.mangaId]);

  // The chapter to compare pages of: the newest number both listings have, or, for single-chapter works
  // (one-shots, doujin) whose numbering needn't agree, the one chapter each has.
  const shared = (() => {
    const [x, y] = data;
    if (!x || !y) return null;
    const nums = new Set(y.chapters.map((c) => c.chapterNumber));
    const both = x.chapters.filter((c) => c.chapterNumber >= 0 && nums.has(c.chapterNumber));
    if (both.length) {
      const n = both[both.length - 1].chapterNumber;
      return { label: chapterText(n), number: n, ids: [x.chapters.find((c) => c.chapterNumber === n)!.id, y.chapters.find((c) => c.chapterNumber === n)!.id] };
    }
    if (x.chapters.length === 1 && y.chapters.length === 1) return { label: "the only chapter", number: x.chapters[0].chapterNumber, ids: [x.chapters[0].id, y.chapters[0].id] };
    return null;
  })();

  const loadPreview = async () => {
    if (shared === null || !data[0] || !data[1]) return;
    setPreviewBusy(true);
    try {
      const pages = await Promise.all(shared.ids.map((id) => chapterPages(id).then((r) => r.pages, () => null)));
      // Skip a credits page at the start when there's more to see.
      setTimeout(() => document.querySelector(".comparePageNav")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
      setPreview({ number: shared.number, label: shared.label, pages, index: Math.min(1, Math.max(0, Math.min(...pages.map((p) => (p?.length ?? 1) - 1)))) });
    } finally {
      setPreviewBusy(false);
    }
  };
  const maxIndex = preview ? Math.max(0, Math.min(...preview.pages.map((p) => (p?.length ?? 1) - 1))) : 0;

  const merge = async () => {
    if (main === null) return;
    const other = main === 0 ? 1 : 0;
    const otherTitle = data[other]?.sourceTitle ?? sides[other].title;
    setBusy(true);
    try {
      await mergeTitle(sides[main].mangaId, otherTitle, sides[other].mangaId);
      await Promise.all(
        sides.map((s, i) => ((data[i]?.version ?? null) !== labels[i] ? setVersion(s.mangaId, labels[i]).catch(() => undefined) : Promise.resolve())),
      );
      toast(`Merged. ${tidyTitle(data[main]?.manga.title ?? sides[main].title)} is the main listing.`);
      onMerged(sides[main].mangaId);
    } catch {
      toastError("Couldn't merge those. Try again.");
      setBusy(false);
    }
  };

  const loading = data.some((d) => d === undefined);
  // On the body, so it sits above the phone tab bar and the series page's pinned bar.
  return createPortal(
    <div className="sheetBackdrop" onClick={onClose}>
      <div className="sheet tall compareSheet" role="dialog" aria-modal="true" aria-label="Compare before merging" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" aria-hidden="true" />
        <header className="filterSheetHead">
          <h3>Compare before merging</h3>
          <button type="button" className="iconBtn" aria-label="Close" onClick={onClose}>×</button>
        </header>
        <div className="filterSheetBody">
          {loading ? (
            <Loading label="Loading both listings…" />
          ) : (
            <>
              <div className="compareCols">
                {sides.map((s, i) => {
                  const d = data[i];
                  const subs = d ? scanlators(d) : [];
                  return (
                    <section key={s.mangaId} className={`compareCol${main === i ? " main" : ""}`}>
                      <label className="compareMain">
                        <input type="radio" name="compareMain" checked={main === i} onChange={() => setMain(i)} />
                        <span>{main === i ? "Main" : "Make main"}</span>
                      </label>
                      <a href={seriesHref(s.mangaId)} className="compareCover">
                        <img src={thumbnailUrl(s.mangaId)} alt="" loading="lazy" />
                      </a>
                      <strong className="compareTitle">{d?.sourceTitle ?? s.title}</strong>
                      <span className="muted small">{d?.manga.sourceName ?? s.sourceName ?? "Source"}</span>
                      <label className="compareVer">
                        <span className="muted small">Version</span>
                        <select value={labels[i] ?? ""} onChange={(e) => setLabels((ls) => ls.map((l, j) => (j === i ? e.target.value || null : l)))}>
                          <option value="">None</option>
                          {[...new Set([...(labels[i] && !VERSION_CHOICES.includes(labels[i]!) ? [labels[i]!] : []), ...VERSION_CHOICES])].map((v) => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      </label>
                      {d ? (
                        <dl className="compareFacts">
                          <dt>Chapters</dt>
                          <dd>{d.latest.chapterCount}</dd>
                          <dt>Latest</dt>
                          <dd>
                            {d.latest.latestNumber !== null ? chapterText(d.latest.latestNumber) : "–"}
                            {d.latest.latestUploadDate && <span className="muted"> · {chapterDate(d.latest.latestUploadDate)}</span>}
                          </dd>
                          {subs.length > 0 && (
                            <>
                              <dt>By</dt>
                              <dd>{subs.join(", ")}</dd>
                            </>
                          )}
                        </dl>
                      ) : (
                        <p className="muted small">Couldn't load this listing.</p>
                      )}
                      {d && <p className="compareBlurb small">{excerpt(d.about?.body ?? d.manga.description) || <span className="muted">No description.</span>}</p>}
                    </section>
                  );
                })}
              </div>
              <div className="comparePages">
                {shared === null ? (
                  <p className="muted small">They share no chapter number and have more than one chapter each, so there's no page to compare.</p>
                ) : !preview ? (
                  <button type="button" className="button small secondary" disabled={previewBusy} onClick={() => void loadPreview()}>
                    {previewBusy ? "Loading pages…" : `Compare a page from ${shared.label}`}
                  </button>
                ) : (
                  <>
                    <div className="comparePageNav">
                      <button type="button" className="iconBtn" aria-label="Previous page" disabled={preview.index <= 0} onClick={() => setPreview({ ...preview, index: preview.index - 1 })}>‹</button>
                      <span className="small">
                        {preview.label}, page {preview.index + 1}
                      </span>
                      <button type="button" className="iconBtn" aria-label="Next page" disabled={preview.index >= maxIndex} onClick={() => setPreview({ ...preview, index: preview.index + 1 })}>›</button>
                    </div>
                    <div className="compareCols">
                      {preview.pages.map((p, i) => (
                        <div key={i} className="comparePage">
                          {p && p[preview.index] ? <img src={p[preview.index]} alt={`Page ${preview.index + 1}, ${sides[i].sourceName ?? "listing " + (i + 1)}`} /> : <p className="muted small">No page.</p>}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
              <p className="muted small">The main listing gives the series its name, cover and description; you can mix those later under Manage. Reading carries across either way.</p>
            </>
          )}
        </div>
        <footer className="filterSheetFoot">
          <button type="button" className="button secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="button" disabled={loading || busy || main === null} onClick={() => void merge()}>
            {busy ? "Merging…" : "Merge"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function Side({ l }: { l: MergeSuggestion["a"] }) {
  return (
    <a className="mergePickSide" href={seriesHref(l.mangaId)}>
      <img src={thumbnailUrl(l.mangaId)} alt="" loading="lazy" width={48} height={70} />
      <span className="mergeInfo">
        <strong>{tidyTitle(l.title)}</strong>
        <span className="muted small">
          {l.sourceName ?? "Source"}
          {l.label && <span className="tag verTag">{l.label}</span>}
        </span>
      </span>
    </a>
  );
}

/** Pairs of listings that look like the same series, to merge or wave off one by one. */
export function Merges() {
  const [list, setList] = useState<MergeSuggestion[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [comparing, setComparing] = useState<MergeSuggestion | null>(null);
  useEffect(() => {
    mergeSuggestions().then((r) => setList(r.suggestions), () => setList([]));
  }, []);
  const drop = (key: string) => setList((l) => (l ?? []).filter((s) => s.key !== key));
  const notSame = async (s: MergeSuggestion) => {
    setBusy(s.key);
    try {
      await dismissMerge({ key: s.key });
      drop(s.key);
      toast("Okay, they stay separate.");
    } catch {
      toastError("Couldn't save that. Try again.");
    } finally {
      setBusy(null);
    }
  };
  if (list === null) return <Loading label="Looking for duplicates…" />;
  return (
    <section className="mergesPage">
      <p className="muted">
        Listings that look like the same series under slightly different names, from what you've opened, read or seen side by side.
        Compare one to see both listings side by side and pick which becomes main before merging.
      </p>
      {list.length === 0 ? (
        <p className="muted">Nothing to merge right now.</p>
      ) : (
        <ul className="mergePicks">
          {list.map((s) => (
            <li key={s.key} className="card">
              <p className="muted small mergeWhy">{s.reason === "mangabaka" ? "Both match the same MangaBaka entry" : s.reason === "tidy" ? "Same title once the tags and notes are tidied away" : "Same name apart from the version"}</p>
              <div className="mergePickPair">
                <Side l={s.a} />
                <Side l={s.b} />
              </div>
              <div className="manageActions">
                <button type="button" className="button small" disabled={busy === s.key} onClick={() => setComparing(s)}>Compare &amp; merge</button>
                <button type="button" className="button small secondary" disabled={busy === s.key} onClick={() => void notSame(s)}>Not the same</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {comparing && (
        <CompareSheet
          a={comparing.a}
          b={comparing.b}
          onClose={() => setComparing(null)}
          onMerged={() => {
            drop(comparing.key);
            setComparing(null);
          }}
        />
      )}
    </section>
  );
}
