import { Loading } from "./Loading";
import { useEffect, useMemo, useState } from "react";
import { changeExtension, checkSources, setSourceAdult, extensions, genreSupport, refreshExtensionList, sources, type ExtensionInfo, type GenreSupport, type SourceRow } from "./api";

const LANGS: Record<string, string> = { en: "English", all: "Multi-language", multi: "Multi-language" };

function displayName(e: ExtensionInfo) {
  return e.name.replace(/^Tachiyomi:\s*/, "");
}

function ago(iso: string | null) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
}

/** The one-line reason from an engine error; the full stack trace stays in the details. */
function shortError(e: string | null): string {
  if (!e) return "no answer";
  const cut = e.search(/\s(?:at\s|java\.|kotlin|Caused by)/);
  const line = (cut > 0 ? e.slice(0, cut) : e).replace(/^Exception while fetching data \([^)]*\)\s*:\s*/, "").trim();
  return line.length > 110 ? `${line.slice(0, 107)}…` : line || "no answer";
}

const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** The sources an installed extension provides (matched by name). */
function sourcesFor(e: ExtensionInfo, rows: SourceRow[]): SourceRow[] {
  const n = norm(displayName(e));
  return rows.filter((r) => {
    const m = norm(r.name);
    return m === n || (m.length >= 4 && (n.includes(m) || m.includes(n)));
  });
}

function sourceStatus(r: SourceRow): { state: "good" | "bad" | "idle"; text: string } {
  const h = r.health;
  if (!h) return { state: "idle", text: "not checked yet" };
  const total = h.okCount + h.failCount;
  const lastBad = h.lastFail && (!h.lastOk || h.lastFail > h.lastOk);
  return lastBad
    ? { state: "bad", text: `failing: ${shortError(h.lastError)}` }
    : { state: "good", text: `${h.avgMs ? `${(h.avgMs / 1000).toFixed(1)}s typical` : "ok"} · ${Math.round((h.okCount / total) * 100)}% of ${total} requests worked` };
}

/** Which sources can filter by genre, and what their filters are called (handy when a genre search comes back thin). */
function GenreSupportPanel() {
  const [rows, setRows] = useState<GenreSupport[] | null>(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setRows((await genreSupport().catch(() => ({ sources: [] }))).sources);
    setBusy(false);
  }
  return (
    <>
      <div className="chapterHead">
        <h3>Genre filters</h3>
        <button type="button" className="linkish" onClick={load} disabled={busy}>
          {busy ? "Checking…" : rows ? "Check again" : "Check which sources support them"}
        </button>
      </div>
      {rows && (
        <ul className="extList">
          {rows.map((r) => (
            <li key={r.id} className="extRow">
              <div className="info">
                <span className={`dot ${r.error ? "bad" : r.genres > 0 || r.anyTag ? "good" : ""}`} /> <strong>{r.name}</strong>
                <span className="muted">
                  {" "}
                  {r.error ? `couldn't read filters: ${r.error}` : r.anyTag ? `any tag by name${r.genres > 0 ? `, ${r.genres} listed` : ""}` : r.genres > 0 ? `${r.genres} genres` : "no genre filter found, checked by each series' tags"}
                </span>
                {r.genres === 0 && !r.anyTag && !r.error && r.filters.length > 0 && (
                  <div className="muted small">Its filters: {r.filters.slice(0, 8).join(" · ")}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function Sources() {
  const [list, setList] = useState<ExtensionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [englishOnly, setEnglishOnly] = useState(true);
  const [working, setWorking] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [sourceRows, setSourceRows] = useState<SourceRow[]>([]);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const loadSources = () => sources().then((r) => setSourceRows(r.sources), () => {});
  useEffect(() => void loadSources(), []);

  async function checkAll() {
    setChecking(true);
    await checkSources().catch(() => {});
    await loadSources();
    setChecking(false);
  }
  async function setAdult(r: SourceRow, adult: boolean) {
    setNote(null);
    try {
      // Back to "whatever the extension says" when the choice matches its own flag.
      await setSourceAdult(r.id, adult === (r.flaggedNsfw ?? r.isNsfw) ? null : adult);
      await loadSources();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "That didn't work.");
    }
  }
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); n.has(k) ? n.delete(k) : n.add(k); return n; });

  useEffect(() => {
    extensions().then((r) => setList(r.extensions), (e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load extensions."));
  }, []);

  async function act(e: ExtensionInfo, action: "install" | "update" | "uninstall") {
    setWorking((w) => ({ ...w, [e.pkgName]: action === "uninstall" ? "Removing…" : action === "update" ? "Updating…" : "Installing…" }));
    setError(null);
    try {
      const { extension } = await changeExtension(e.pkgName, action);
      setList((l) => l?.map((x) => (x.pkgName === e.pkgName ? { ...x, ...extension } : x)) ?? l);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setWorking((w) => {
        const { [e.pkgName]: _, ...rest } = w;
        return rest;
      });
    }
  }

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      setList((await refreshExtensionList()).extensions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  }

  const { installed, available } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const sorted = [...(list ?? [])].sort((a, b) => displayName(a).localeCompare(displayName(b)));
    const match = (e: ExtensionInfo) =>
      (!q || displayName(e).toLowerCase().includes(q)) && (e.isInstalled || !englishOnly || e.lang in LANGS);
    return {
      // Anything that's failing floats to the top so it's the first thing you see.
      installed: sorted
        .filter((e) => e.isInstalled && match(e))
        .sort((a, b) => Number(sourcesFor(b, sourceRows).some((r) => sourceStatus(r).state === "bad")) - Number(sourcesFor(a, sourceRows).some((r) => sourceStatus(r).state === "bad"))),
      available: sorted.filter((e) => !e.isInstalled && match(e)),
    };
  }, [list, filter, englishOnly, sourceRows]);

  function row(e: ExtensionInfo) {
    const busy = working[e.pkgName];
    const mine = e.isInstalled ? sourcesFor(e, sourceRows) : [];
    const statuses = mine.map(sourceStatus);
    const worst = statuses.some((x) => x.state === "bad") ? "bad" : statuses.some((x) => x.state === "good") ? "good" : "idle";
    const first = statuses.find((x) => x.state === worst) ?? statuses[0];
    const locked = mine.length > 0 && mine.every((r) => r.hidden);
    const expandable = e.isInstalled && mine.length > 0 && !locked;
    const isOpen = open.has(e.pkgName);
    return (
      <li key={e.pkgName} className={`extItem ${isOpen ? "open" : ""}`}>
        <div className="extRow">
          {locked ? (
            <span className="extToggle static" title="18+ source"><span aria-hidden="true">🔒</span></span>
          ) : expandable ? (
            <button type="button" className="extToggle" onClick={() => toggle(e.pkgName)} aria-expanded={isOpen} aria-label={`Details for ${displayName(e)}`}>
              <span className={`dot ${worst === "idle" ? "" : worst}`} />
              <span className="chev" aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
            </button>
          ) : e.isInstalled ? (
            <span className="extToggle static"><span className="dot" /></span>
          ) : null}
          {e.apkName && <img className="extIcon" src={`/api/extension-icon/${encodeURIComponent(e.apkName)}`} alt="" loading="lazy" width={36} height={36} onError={(ev) => (ev.currentTarget.style.visibility = "hidden")} />}
          <div className="info">
            <strong>{displayName(e)}</strong>
            <span className="muted"> {LANGS[e.lang] ?? e.lang} · v{e.versionName}</span>
            {e.hasUpdate && <span className="tag"> update available</span>}
            {e.isInstalled && locked && <div className="small muted">18+ source. Turn on 18+ mode to see its status.</div>}
            {e.isInstalled && mine.length === 0 && <div className="small muted">No status yet. Press “Check all now”.</div>}
            {e.isInstalled && !locked && first && mine.length === 1 && <div className={`small ${worst === "bad" ? "bad" : "muted"}`}>{first.text}</div>}
            {e.isInstalled && !locked && mine.length > 1 && (
              <div className={`small ${worst === "bad" ? "bad" : "muted"}`}>
                {mine.length} sources{worst === "bad" ? `, ${statuses.filter((x) => x.state === "bad").length} failing` : ""}
              </div>
            )}
          </div>
          {busy ? (
            <span className="muted">{busy}</span>
          ) : e.isInstalled ? (
            <span className="extActions">
              {e.hasUpdate && (
                <button type="button" className="button small" onClick={() => act(e, "update")}>Update</button>
              )}
              <button type="button" className="button small secondary" onClick={() => act(e, "uninstall")}>Remove</button>
            </span>
          ) : (
            <button type="button" className="button small" onClick={() => act(e, "install")}>Install</button>
          )}
        </div>
        {isOpen && (
          <div className="extDetails">
            {mine.map((r, i) => {
              const h = r.health;
              const st = statuses[i];
              return (
                <div key={r.id} className="srcDetail">
                  <div className="srcHead">
                    <span className={`dot ${st.state === "idle" ? "" : st.state}`} />
                    <strong>{r.name}</strong>
                    <span className="muted small"> {LANGS[r.lang] ?? r.lang}</span>
                    <label className="muted small adultFlag" title="Where this source's series show up: the 18+ pages (checked) or the ordinary ones. Turn on 18+ mode to change it.">
                      <input type="checkbox" checked={r.isNsfw} onChange={(ev) => void setAdult(r, ev.target.checked)} /> 18+
                      {r.adultOverride != null && " (set by you)"}
                    </label>
                  </div>
                  <div className="muted small">
                    {st.state === "good" ? st.text : st.state === "idle" ? st.text : "failing"}
                    {h && ` · seen ${ago(h.lastOk ?? h.lastFail)}`}
                  </div>
                  {st.state === "bad" && h?.lastError && (
                    <div className="errBox">
                      <div className="errHead">
                        <strong>{shortError(h.lastError)}</strong>
                        <button type="button" className="linkish small" onClick={() => void navigator.clipboard?.writeText(h.lastError ?? "").catch(() => {})}>Copy details</button>
                      </div>
                      <pre>{h.lastError}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </li>
    );
  }

  // Sources the engine reports that no extension row above claimed (rare).
  const claimed = new Set(installed.flatMap((e) => sourcesFor(e, sourceRows).map((r) => r.id)));
  const orphans = sourceRows.filter((r) => !claimed.has(r.id) && !r.hidden);

  return (
    <section>
      {note && <p className="bad">{note}</p>}
      <GenreSupportPanel />
      <h3>Extensions</h3>
      <p className="muted">
        Extensions are what let Sapphire read each site. Installed ones show up in search and discovery right away.
      </p>
      <div className="searchbar">
        <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a site" aria-label="Find a site" />
        <button type="button" onClick={refresh} disabled={refreshing}>{refreshing ? "Refreshing…" : "Refresh list"}</button>
      </div>
      <label className="muted">
        <input type="checkbox" checked={englishOnly} onChange={(e) => setEnglishOnly(e.target.checked)} /> English and multi-language only
      </label>
      {error && <p className="bad">{error}</p>}
      {!list && !error && <Loading label="Loading the extension list. The first time can take a moment." />}
      {list && (
        <>
          <div className="chapterHead">
            <h3>Installed ({installed.length})</h3>
            <button type="button" className="linkish" onClick={checkAll} disabled={checking}>
              {checking ? "Checking every source…" : "Check all now"}
            </button>
          </div>
          {installed.length === 0 ? <p className="muted">None match.</p> : <ul className="extList">{installed.map(row)}</ul>}
          {orphans.length > 0 && !filter.trim() && (
            <p className="muted small">Also answering: {orphans.map((r) => r.name).join(", ")}.</p>
          )}
          <h3>Available ({available.length})</h3>
          <ul className="extList">{available.slice(0, 100).map(row)}</ul>
          {available.length > 100 && <p className="muted">Showing 100. Type in the box to narrow the list.</p>}
        </>
      )}
    </section>
  );
}
