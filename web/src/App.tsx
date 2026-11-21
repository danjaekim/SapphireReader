import { Loading } from "./Loading";
import { useEffect, useState } from "react";
import { AdultButton, AdultDialog } from "./AdultLock";
import { adultState, lockAdult, type AdultState } from "./api";
import { Discover } from "./Discover";
import { Downloads } from "./Downloads";
import { Home } from "./Home";
import { History } from "./History";
import { savedTheme, setTheme, type Theme } from "./theme";
import { UpdateCard, startUpdate, useUpdate } from "./update";
import { automation, setAutomation, type Automation } from "./api";
import { Library } from "./Library";
import { Reader } from "./Reader";
import { Search } from "./Search";
import { SeriesPage } from "./SeriesPage";
import { Sources } from "./Sources";
import { TrackerSettings } from "./Trackers";
import { Updates } from "./Updates";
import { clearPagedCache } from "./usePaged";
import { resetHiddenCache } from "./shared";
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
  { page: "history", label: "History", icon: "🕘" },
  { page: "sources", label: "Sources", icon: "🧩" },
  { page: "status", label: "Settings", icon: "⚙️" },
];

const TITLES: Record<PageName, string> = {
  home: "Home",
  search: "Search",
  library: "Library",
  discover: "Discover",
  "discover-18": "Discover (18+)",
  downloads: "Downloads",
  updates: "Updates",
  history: "History",
  sources: "Sources",
  status: "Settings",
};

/** Pages made of a grid use the full width; the rest are centered in a readable column. */
const WIDE: PageName[] = ["home", "search", "library", "discover", "discover-18"];

/** Under Settings in the menu: shows up when a newer version is out (or while one installs). */
function UpdatePrompt({ onClose }: { onClose: () => void }) {
  const u = useUpdate();
  const busy = u.phase === "starting" || u.phase === "updating";
  if (!busy && u.info?.available !== true) return null;
  return (
    <div className="updatePrompt">
      {busy ? (
        <a className="updateCta busy" href={pageHref("status")} onClick={onClose}>
          <span className="spin" aria-hidden="true" /> Updating…
        </a>
      ) : (
        <button
          type="button"
          className="updateCta"
          onClick={() => {
            onClose();
            navigate(pageHref("status"));
            if (u.info?.enabled) void startUpdate();
          }}
        >
          <span aria-hidden="true">⬆️</span>
          <span className="updateText">
            <strong>Update available</strong>
            <small>{u.info?.enabled ? `Install ${u.info.latest ?? "the new version"}` : "See Settings"}</small>
          </span>
        </button>
      )}
    </div>
  );
}

function UpdateDot() {
  const u = useUpdate();
  return u.info?.available === true ? <span className="navBadge on" title="A newer version is available">New</span> : null;
}

function SideNav({
  current,
  adult,
  onAdult,
  open,
  onClose,
}: {
  current: PageName | null;
  adult: AdultState;
  onAdult: () => void;
  /** On phones (and in the reader) the menu is a drawer that slides in. */
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {open && <div className="drawerBackdrop" onClick={onClose} aria-hidden="true" />}
      <aside className={`sidenav ${open ? "open" : ""}`} aria-label="Menu">
        <a className="brand" href={pageHref("home")} onClick={onClose}>
          <img src="/icon.svg" alt="" width={32} height={32} />
          <h1>Sapphire</h1>
        </a>
        <nav aria-label="Main">
          {NAV.filter((n) => !n.adultOnly || adult.unlocked).map((n) => (
            <a key={n.page} className="navItem" href={pageHref(n.page)} onClick={onClose} aria-current={n.page === current ? "page" : undefined} title={n.label}>
              <span className="navIcon" aria-hidden="true">{n.icon}</span>
              <span className="navLabel">{n.label}</span>
              {n.page === "status" && <UpdateDot />}
            </a>
          ))}
        </nav>
        <UpdatePrompt onClose={onClose} />
        <AdultButton state={adult} onOpen={onAdult} />
        <ThemeButton />
      </aside>
    </>
  );
}

/** Phones: a top bar with the menu button, the name of the page, and a search shortcut. */
function TopBar({ title, onMenu }: { title: string; onMenu: () => void }) {
  return (
    <header className="topbar">
      <button type="button" className="iconBtn" onClick={onMenu} aria-label="Open menu">
        <span className="burger" aria-hidden="true"><i /><i /><i /></span>
      </button>
      <a className="topbarBrand" href={pageHref("home")}>
        <img src="/icon.svg" alt="" width={26} height={26} />
        <span>{title}</span>
      </a>
      <a className="iconBtn" href={pageHref("search")} aria-label="Search">🔍</a>
    </header>
  );
}

const TABS: PageName[] = ["home", "search", "library", "discover", "updates"];

/** Phones: the main pages one tap away at the bottom; everything else stays in the ☰ menu. */
function TabBar({ current }: { current: PageName | null }) {
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map((p) => {
        const n = NAV.find((x) => x.page === p)!;
        return (
          <a key={p} href={pageHref(p)} className={current === p ? "active" : ""} aria-current={current === p ? "page" : undefined}>
            <span aria-hidden="true">{n.icon}</span>
            <span>{n.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

const THEMES: { id: Theme; label: string; icon: string }[] = [
  { id: "system", label: "Auto", icon: "🌗" },
  { id: "dark", label: "Dark", icon: "🌙" },
  { id: "light", label: "Light", icon: "☀️" },
];

/** In the menu: cycles Match device → Dark → Light. */
function ThemeButton() {
  const [theme, set] = useState<Theme>(savedTheme);
  const current = THEMES.find((t) => t.id === theme)!;
  return (
    <button
      type="button"
      className="navItem"
      onClick={() => {
        const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length].id;
        setTheme(next);
        set(next);
      }}
      title="Change the look"
    >
      <span className="navIcon" aria-hidden="true">{current.icon}</span>
      <span className="navLabel">Theme</span>
      <span className="navBadge">{current.label}</span>
    </button>
  );
}

function AppearanceCard() {
  const [theme, set] = useState<Theme>(savedTheme);
  return (
    <section className="card">
      <h3>Appearance</h3>
      <div className="chips" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} className={`chip ${theme === t.id ? "on" : ""}`} onClick={() => { setTheme(t.id); set(t.id); }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>
      <p className="muted small">Auto follows your device's light or dark setting. Saved on this device; the reader always stays dark.</p>
    </section>
  );
}

function AutomationCard() {
  const [a, setA] = useState<Automation | null>(null);
  useEffect(() => {
    automation().then(setA, () => {});
  }, []);
  if (!a) return null;
  const change = (patch: Partial<Automation>) => {
    setA({ ...a, ...patch });
    setAutomation(patch).then(setA, () => setA(a));
  };
  return (
    <section className="card">
      <h3>Automatic</h3>
      <label className="settingRow">
        <span>
          <strong>Download ahead</strong>
          <span className="muted small">For library series you're reading, keep the next chapters saved on the NAS.</span>
        </span>
        <select value={a.autoDownload} onChange={(e) => change({ autoDownload: Number(e.target.value) })}>
          <option value={0}>Off</option>
          {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>Next {n}</option>)}
        </select>
      </label>
      <label className="settingRow">
        <span>
          <strong>Suggest moving to the source that's furthest ahead</strong>
          <span className="muted small">When you're caught up and another source has newer chapters of the same series, you get an alert and a "Move to…?" card in Updates. Nothing moves until you say so; your place and read chapters come along.</span>
        </span>
        <input type="checkbox" checked={a.autoSwitch} onChange={(e) => change({ autoSwitch: e.target.checked })} />
      </label>
      <label className="settingRow">
        <span>
          <strong>Delete downloads after reading</strong>
          <span className="muted small">Once you finish a chapter, its copy on the NAS is removed to save space. Chapters saved on this device aren't touched.</span>
        </span>
        <input type="checkbox" checked={a.autoDelete} onChange={(e) => change({ autoDelete: e.target.checked })} />
      </label>
    </section>
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
        <ul className="statusList">
          <li>
            <span className="dot good" />
            <span>Server, version {status.server.version}</span>
          </li>
          <li>
            <span className={`dot ${status.engine.reachable ? "good" : "bad"}`} />
            <span>
              {status.engine.reachable
                ? `Source engine${status.engine.version ? `, version ${status.engine.version}` : ""}`
                : `Source engine unreachable${status.engine.error ? `: ${status.engine.error}` : ""}`}
            </span>
          </li>
          {status.alerts && (
            <li>
              <span className={`dot ${status.alerts.enabled ? "good" : "bad"}`} />
              <span>
                {status.alerts.enabled
                  ? `New-chapter alerts on, checking every ${status.alerts.everyHours} hours`
                  : "New-chapter alerts off (NTFY_URL isn't set)"}
                {status.alerts.enabled && (
                  <>
                    {" "}
                    <button type="button" className="linkish" onClick={sendTest}>
                      Send test alert
                    </button>
                  </>
                )}
                {testResult && <span className="muted"> {testResult}</span>}
              </span>
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
    // On a phone or tablet, closing the app and opening it again starts locked. A reload inside the
    // same session (an update, a refresh) keeps the unlock, because the session marker survives it.
    let fresh = false;
    try {
      if (window.matchMedia("(pointer: coarse)").matches && !sessionStorage.getItem("sapphire.session")) fresh = true;
      sessionStorage.setItem("sapphire.session", "1");
    } catch {
      // No session storage: never lock on every load.
    }
    (fresh ? lockAdult().catch(() => undefined) : Promise.resolve()).then(() => adultState().then(setAdult, () => {}));
  }, []);
  const route = useRoute();

  // Locking or unlocking changes what searches return, so remembered results are dropped.
  function onAdult(next: AdultState) {
    clearPagedCache();
    resetHiddenCache();
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

  const [menuOpen, setMenuOpen] = useState(false);
  const [adultOpen, setAdultOpen] = useState(false);
  // Any navigation closes the menu.
  useEffect(() => {
    setMenuOpen(false);
    setAdultOpen(false);
  }, [window.location.hash]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const reading = route.name === "read";
  const nav = (
    <>
      <SideNav
        current={reading ? null : page}
        adult={adult}
        onAdult={() => { setMenuOpen(false); setAdultOpen(true); }}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
      />
      {adultOpen && <AdultDialog state={adult} onChange={onAdult} onClose={() => setAdultOpen(false)} />}
    </>
  );

  if (route.name === "read") {
    return (
      <div className="reading">
        <div className="readerMenu">{nav}</div>
        <Reader mangaId={route.mangaId} chapterId={route.chapterId} startPage={route.page} onMenu={() => setMenuOpen(true)} />
      </div>
    );
  }

  const wide = route.name === "series" ? true : WIDE.includes(page!);
  const scopeTag = String(adult.unlocked);

  return (
    <div className="shell">
      <TopBar title={route.name === "series" ? "Sapphire" : page === "home" ? "Sapphire" : TITLES[page!]} onMenu={() => setMenuOpen(true)} />
      {nav}
      <main className={`content ${wide ? "" : "narrow"} ${route.name === "series" ? "withBackdrop" : ""}`}>
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
            {page === "history" && <History key={scopeTag} />}
            {page === "sources" && <Sources key={scopeTag} />}
            {page === "status" && (
              <>
                <StatusCard />
                <UpdateCard />
                <AppearanceCard />
                <AutomationCard />
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
      <TabBar current={route.name === "series" ? null : page} />
    </div>
  );
}
