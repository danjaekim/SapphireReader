import { Loading } from "./Loading";
import { useEffect, useState } from "react";
import { AdultLock } from "./AdultLock";
import { adultState, type AdultState } from "./api";
import { Discover } from "./Discover";
import { Downloads } from "./Downloads";
import { Home } from "./Home";
import { Library } from "./Library";
import { Reader } from "./Reader";
import { Search } from "./Search";
import { SeriesPage } from "./SeriesPage";
import { Sources } from "./Sources";
import { TrackerSettings } from "./Trackers";
import { Updates } from "./Updates";
import { clearPagedCache } from "./usePaged";
import { navigate, pageHref, useRoute, type PageName } from "./route";

interface Status {
  server: { ok: boolean; version: string };
  engine: { reachable: boolean; version?: string; error?: string };
  alerts?: { enabled: boolean; everyHours: number };
}

const NAV: { page: PageName; label: string; icon: string; adultOnly?: boolean }[] = [
  { page: "home", label: "Home", icon: "🏠" },
  { page: "search", label: "Search", icon: "🔍" },
  { page: "library", label: "Library", icon: "📚" },
  { page: "discover", label: "Discover", icon: "✨" },
  { page: "discover-18", label: "Discover (18+)", icon: "🔞", adultOnly: true },
  { page: "downloads", label: "Downloads", icon: "⬇️" },
  { page: "updates", label: "Updates", icon: "🔔" },
  { page: "sources", label: "Sources", icon: "🧩" },
  { page: "status", label: "Status", icon: "📊" },
];

const TITLES: Record<PageName, string> = {
  home: "Home",
  search: "Search",
  library: "Library",
  discover: "Discover",
  "discover-18": "Discover (18+)",
  downloads: "Downloads",
  updates: "Updates",
  sources: "Sources",
  status: "Status",
};

/** Pages made of a grid use the full width; the rest are centered in a readable column. */
const WIDE: PageName[] = ["home", "search", "library", "discover", "discover-18"];

function SideNav({
  current,
  adult,
  onAdult,
  overlay = false,
}: {
  current: PageName | null;
  adult: AdultState;
  onAdult: (s: AdultState) => void;
  overlay?: boolean;
}) {
  return (
    <aside className={`sidenav ${overlay ? "overlay" : ""}`}>
      <a className="brand" href={pageHref("home")}>
        <img src="/icon.svg" alt="" width={32} height={32} />
        <h1>Sapphire</h1>
      </a>
      <nav aria-label="Main">
        {NAV.filter((n) => !n.adultOnly || adult.unlocked).map((n) => (
          <a key={n.page} className="navItem" href={pageHref(n.page)} aria-current={n.page === current ? "page" : undefined} title={n.label}>
            <span className="navIcon" aria-hidden="true">{n.icon}</span>
            <span className="navLabel">{n.label}</span>
          </a>
        ))}
      </nav>
      <AdultLock state={adult} onChange={onAdult} />
    </aside>
  );
}

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
      {!status && !failed && <Loading label="Checking…" size="sm" />}
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
  const route = useRoute();

  // Locking or unlocking changes what searches return, so remembered results are dropped.
  function onAdult(next: AdultState) {
    clearPagedCache();
    setAdult(next);
    if (!next.unlocked && route.name === "page" && route.page === "discover-18") navigate(pageHref("home"));
  }

  // 18+ page without the lock open: back to home.
  const page: PageName | null = route.name === "page" ? (route.page === "discover-18" && !adult.unlocked ? "home" : route.page) : null;

  useEffect(() => {
    document.title = route.name === "page" ? (page === "home" ? "Sapphire" : `${TITLES[page!]} · Sapphire`) : "Sapphire";
    // Series pages start at the top; remembered result lists restore their own position.
    if (route.name === "series") window.scrollTo(0, 0);
  }, [route.name, page, route.name === "series" ? route.mangaId : 0]);

  const nav = (overlay: boolean) => <SideNav current={overlay ? null : page} adult={adult} onAdult={onAdult} overlay={overlay} />;

  if (route.name === "read") {
    return (
      <div className="reading">
        <Reader mangaId={route.mangaId} chapterId={route.chapterId} nav={nav(true)} />
      </div>
    );
  }

  const wide = route.name === "series" ? false : WIDE.includes(page!);
  const scopeTag = String(adult.unlocked);

  return (
    <div className="shell">
      {nav(false)}
      <main className={`content ${wide ? "" : "narrow"}`}>
        {route.name === "series" ? (
          <SeriesPage mangaId={route.mangaId} />
        ) : (
          <>
            {page !== "home" && <h2>{TITLES[page!]}</h2>}
            {page === "home" && <Home key={scopeTag} />}
            {page === "search" && <Search params={route.params} scopeTag={scopeTag} />}
            {page === "discover" && <Discover params={route.params} scopeTag={scopeTag} />}
            {page === "discover-18" && <Discover adult params={route.params} scopeTag={scopeTag} />}
            {page === "library" && <Library key={scopeTag} />}
            {page === "downloads" && <Downloads key={scopeTag} />}
            {page === "updates" && <Updates key={scopeTag} />}
            {page === "sources" && <Sources key={scopeTag} />}
            {page === "status" && (
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
          </>
        )}
      </main>
    </div>
  );
}
