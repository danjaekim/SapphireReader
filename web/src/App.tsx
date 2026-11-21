import { useEffect, useState } from "react";
import { Library } from "./Library";
import { Reader } from "./Reader";
import { Search } from "./Search";
import { SeriesPage } from "./SeriesPage";
import { useRoute } from "./route";

interface Status {
  server: { ok: boolean; version: string };
  engine: { reachable: boolean; version?: string; error?: string };
}

const tabs = ["Search", "Library", "Discover", "Updates", "Status"] as const;
type Tab = (typeof tabs)[number];

function StatusCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);

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
        </ul>
      )}
    </section>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("Search");
  const route = useRoute();

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
    if (route.name !== "tab") window.location.hash = "#/";
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
            {tab === "Search" && <Search />}
            {tab === "Status" && <StatusCard />}
            {tab === "Library" && <Library />}
            {tab !== "Search" && tab !== "Status" && tab !== "Library" && <p className="muted">Coming soon.</p>}
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
