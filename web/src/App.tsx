import { useEffect, useState } from "react";
import { AdultLock } from "./AdultLock";
import { adultState, type AdultState } from "./api";
import { Discover } from "./Discover";
import { Library } from "./Library";
import { Reader } from "./Reader";
import { Search } from "./Search";
import { Sources } from "./Sources";
import { TrackerSettings } from "./Trackers";
import { SeriesPage } from "./SeriesPage";
import { useRoute } from "./route";

interface Status {
  server: { ok: boolean; version: string };
  engine: { reachable: boolean; version?: string; error?: string };
  alerts?: { enabled: boolean; everyHours: number };
}

const baseTabs = ["Search", "Library", "Discover", "Updates", "Sources", "Status"] as const;
const adultTabs = ["Search", "Library", "Discover", "Discover (18+)", "Updates", "Sources", "Status"] as const;
type Tab = (typeof adultTabs)[number];

function StatusCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function sendTest() {
    setTestResult("Sending…");
    const res = await fetch("/api/notify/test", { method: "POST" }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
    setTestResult(res?.ok ? "Sent. Check your phone." : (body.error ?? "Couldn't reach the Sapphire server."));
  }

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setFailed(true));
  }, []);

  return (
    <section className="card">
      <h3>System status</h3>
      {failed && <p className="bad">Can't reach the Sapphire server.</p>}
      {!status && !failed && <p className="muted">Checking…</p>}
      {status && (
        <ul>
          <li>
            <span className="dot good" /> Server, version {status.server.version}
          </li>
          <li>
            <span className={`dot ${status.engine.reachable ? "good" : "bad"}`} />{" "}
            {status.engine.reachable
              ? `Source engine${status.engine.version ? `, version ${status.engine.version}` : ""}`
              : `Source engine unreachable${status.engine.error ? `: ${status.engine.error}` : ""}`}
          </li>
          {status.alerts && (
            <li>
              <span className={`dot ${status.alerts.enabled ? "good" : "bad"}`} />{" "}
              {status.alerts.enabled
                ? `New-chapter alerts on, checking every ${status.alerts.everyHours} hours `
                : "New-chapter alerts off (NTFY_URL isn't set) "}
              {status.alerts.enabled && (
                <button type="button" className="linkish" onClick={sendTest}>
                  Send test alert
                </button>
              )}
              {testResult && <span className="muted"> {testResult}</span>}
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

export function App() {
  const [adult, setAdult] = useState<AdultState>({ pinSet: false, unlocked: false });
  useEffect(() => {
    adultState().then(setAdult, () => {});
  }, []);
  const tabs: readonly Tab[] = adult.unlocked ? adultTabs : baseTabs;
  const [pickedTab, setTab] = useState<Tab>("Search");
  const route = useRoute();
  // A genre link opens Search with that genre selected.
  const genres = route.name === "tab" ? route.genres : [];
  // If 18+ mode is switched off while its page is open, fall back to Search.
  const tab: Tab = genres.length > 0 ? "Search" : tabs.includes(pickedTab) ? pickedTab : "Search";

  if (route.name === "read") {
    return (
      <div className="shell reading">
        <Reader mangaId={route.mangaId} chapterId={route.chapterId} />
      </div>
    );
  }

  function pickTab(t: Tab) {
    setTab(t);
    // Leaving a series page: go back to the tab view.
    if (route.name !== "tab" || route.genres.length > 0) window.location.hash = "#/";
  }

  return (
    <div className="shell">
      <header className="top">
        <img src="/icon.svg" alt="" width={32} height={32} />
        <h1>Sapphire</h1>
        <AdultLock state={adult} onChange={setAdult} />
      </header>
      <main className="content">
        {route.name === "series" ? (
          <SeriesPage mangaId={route.mangaId} />
        ) : (
          <>
            <h2>{tab}</h2>
            {tab === "Search" && <Search key={`${genres.join("|")}${adult.unlocked}`} initialGenres={genres} />}
            {tab === "Discover" && <Discover key={String(adult.unlocked)} />}
            {tab === "Discover (18+)" && <Discover adult />}
            {tab === "Sources" && <Sources />}
            {tab === "Status" && (
              <>
                <StatusCard />
                <TrackerSettings />
                <section className="card">
                  <h3>Backup</h3>
                  <p className="muted">
                    Sapphire saves a copy of your library and progress every day on the NAS (data/app/backups, last 7 days).
                    You can also download one now.
                  </p>
                  <a className="button small" href="/api/backup" download>Download backup</a>
                </section>
              </>
            )}
            {tab === "Library" && <Library key={String(adult.unlocked)} />}
            {tab === "Updates" && <p className="muted">Coming soon.</p>}
          </>
        )}
      </main>
      <nav className="tabs" aria-label="Main">
        {tabs.map((t) => (
          <button key={t} aria-current={route.name === "tab" && t === tab ? "page" : undefined} onClick={() => pickTab(t)}>
            {t}
          </button>
        ))}
      </nav>
    </div>
  );
}
