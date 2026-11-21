import { useEffect, useState, type FormEvent } from "react";
import { forYou, homeData, thumbnailUrl, type HomeData, type SeriesGroup, type UpdateRow } from "./api";
import { navigate, pageHref, readHref, seriesHref } from "./route";
import { ago, chapterText } from "./util";

function UpdateRowView({ u }: { u: UpdateRow }) {
  return (
    <li className="feedRow">
      <img src={thumbnailUrl(u.mangaId)} alt="" width={44} height={60} loading="lazy" />
      <div className="info">
        <a href={seriesHref(u.mangaId)} className="libTitle">{u.title}</a>
        <span> · {chapterText(u.latestNumber)}{u.newCount > 1 ? ` (+${u.newCount})` : ""}</span>
        <div className="muted small">{u.sourceName ?? "source"} · {ago(u.detectedAt)}</div>
      </div>
      <a className="button small" href={seriesHref(u.mangaId)}>Read</a>
    </li>
  );
}

export function Home() {
  const [data, setData] = useState<HomeData | null>(null);
  const [recs, setRecs] = useState<{ groups: SeriesGroup[]; because: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    homeData().then(setData, (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the home page."));
    forYou().then(setRecs, () => setRecs({ groups: [], because: [] }));
  }, []);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    if (q.trim().length >= 2) navigate(pageHref("search", { q: q.trim() }));
  }

  const fresh = data?.newChapters.filter((u) => Date.now() - new Date(u.detectedAt).getTime() < 36 * 3600 * 1000).length ?? 0;

  return (
    <div className="home">
      <form className="searchbar" onSubmit={onSearch} role="search">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search all sources" aria-label="Search all sources" />
        <button type="submit" disabled={q.trim().length < 2}>Search</button>
        <a className="button ghost" href={pageHref("discover")}>Discover</a>
      </form>
      <h1>Welcome back</h1>
      {error && <p className="bad">{error}</p>}
      {data && (
        <p className="muted">
          {data.libraryCount === 0
            ? "Your library is empty. Search for a series and add it to get started."
            : fresh > 0
              ? `${fresh} ${fresh === 1 ? "series has" : "series have"} new chapters since yesterday.`
              : "No new chapters since yesterday."}
        </p>
      )}

      {data && data.continueReading.length > 0 && (
        <>
          <h2>Continue reading <small>behind the latest chapter, most recent first</small></h2>
          <ul className="row">
            {data.continueReading.map((i) => {
              const p = i.progress!;
              const pct = i.latestNumber ? Math.min(100, Math.round((Math.max(p.chapterNumber, 0) / i.latestNumber) * 100)) : 0;
              return (
                <li key={i.mangaId} className="gridCard">
                  <a href={readHref(i.mangaId, p.chapterId)} className="gridCover">
                    <img src={thumbnailUrl(i.mangaId)} alt="" loading="lazy" />
                    <span className="badge">{i.unread} unread</span>
                  </a>
                  <a href={seriesHref(i.mangaId)} className="gridTitle" title={i.title}>{i.title}</a>
                  <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                  <span className="muted gridMeta">
                    {p.chapterNumber >= 0 ? chapterText(p.chapterNumber) : p.chapterName}
                    {i.latestNumber ? ` of ${Math.floor(i.latestNumber)}` : ""}
                    {i.sourceName ? ` · ${i.sourceName}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {data && data.newChapters.length > 0 && (
        <>
          <h2>New chapters for caught-up series <small>checked {ago(data.lastCheckedAt)}</small></h2>
          <ul className="feed">{data.newChapters.map((u, i) => <UpdateRowView key={`${u.mangaId}-${i}`} u={u} />)}</ul>
          <p><a href={pageHref("updates")} className="linkish">See all updates</a></p>
        </>
      )}

      {recs && recs.groups.length > 0 && (
        <>
          <h2>Recommended for you <small>{recs.because.length ? `because you like ${recs.because.join(", ")}` : ""}</small></h2>
          <ul className="row">
            {recs.groups.slice(0, 12).map((g) => (
              <li key={g.key} className="gridCard">
                <a href={seriesHref(g.hits[0].mangaId)} className="gridCover">
                  <img src={thumbnailUrl(g.hits[0].mangaId)} alt="" loading="lazy" />
                  {g.hits.length > 1 && <span className="badge">{g.hits.length} sources</span>}
                </a>
                <a href={seriesHref(g.hits[0].mangaId)} className="gridTitle" title={g.title}>{g.title}</a>
                <span className="muted gridMeta">{g.hits.map((h) => h.sourceName).join(", ")}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {!recs && <p className="muted">Finding recommendations…</p>}
    </div>
  );
}
