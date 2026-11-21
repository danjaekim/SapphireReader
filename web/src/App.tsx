import { useEffect, useState } from "react";
import { Search } from "./Search";

interface Status {
  server: { ok: boolean; version: string };
  engine: { reachable: boolean; version?: string; error?: string };
}

const tabs = ["Search", "Library", "Discover", "Updates", "Status"] as const;

export function App() {
  const [tab, setTab] = useState<(typeof tabs)[number]>("Search");
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setFailed(true));
  }, []);

  return (
    <div className="shell">
      <header className="top">
        <img src="/icon.svg" alt="" width={32} height={32} />
        <h1>Sapphire</h1>
      </header>
      <main className="content">
        <h2>{tab}</h2>
        {tab === "Search" ? (
          <Search />
        ) : tab === "Status" ? (
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
        ) : (
          <p className="muted">Coming soon.</p>
        )}
      </main>
      <nav className="tabs" aria-label="Main">
        {tabs.map((t) => (
          <button key={t} aria-current={t === tab ? "page" : undefined} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
    </div>
  );
}
