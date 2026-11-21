import { useEffect, useState } from "react";
import { Discover } from "./Discover";
import { Library } from "./Library";
import { Reader } from "./Reader";
import { Search } from "./Search";
import { Sources } from "./Sources";
import { SeriesPage } from "./SeriesPage";
import { useRoute } from "./route";

interface Status {
  server: { ok: boolean; version: string };
  engine: { reachable: boolean; version?: string; error?: string };
  alerts?: { enabled: boolean; everyHours: number };
}

const tabs = ["Search", "Library", "Discover", "Updates", "Sources", "Status"] as const;
type Tab = (typeof tabs)[number];

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
  const [pickedTab, setTab] = useState<Tab>("Search");
  const route = useRoute();
  // A genre link opens Search with that genre selected.
  const genres = route.name === "tab" ? route.genres : [];
  const tab: Tab = genres.length > 0 ? "Search" : pickedTab;

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
      </header>
      <main className="content">
        {route.name === "series" ? (
          <SeriesPage mangaId={route.mangaId} />
        ) : (
          <>
            <h2>{tab}</h2>
            {tab === "Search" && <Search key={genres.join("|")} initialGenres={genres} />}
            {tab === "Discover" && <Discover />}
            {tab === "Sources" && <Sources />}
            {tab === "Status" && <StatusCard />}
            {tab === "Library" && <Library />}
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
