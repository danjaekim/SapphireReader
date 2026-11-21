import { useEffect, useSyncExternalStore } from "react";
import { Loading } from "./Loading";
import { ago } from "./util";

export interface UpdateInfo {
  enabled: boolean;
  available: boolean | null;
  latest: string | null;
  /** The new version is on GitHub but its image is still being built. */
  building?: boolean;
  current?: string;
  problem?: "private" | "token" | "github" | "offline" | "version" | "build" | null;
}

/**
 * One shared picture of "is a new version out?", used by the Settings card and the menu prompt.
 * The update itself keeps going if you change pages while it runs.
 */
interface State {
  info: UpdateInfo | null;
  checking: boolean;
  checkedAt: string | null;
  phase: "idle" | "starting" | "updating" | "failed";
  message: string | null;
  startedAt: number | null;
}

let state: State = { info: null, checking: false, checkedAt: null, phase: "idle", message: null, startedAt: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export async function checkForUpdate(refresh = false): Promise<void> {
  if (state.checking) return;
  set({ checking: true });
  try {
    const info = (await fetch(`/api/update${refresh ? "?refresh=1" : ""}`).then((r) => r.json())) as UpdateInfo;
    set({ info, checkedAt: new Date().toISOString() });
    // A build takes a minute or two; look again until it's published.
    window.clearTimeout(buildTimer);
    if (info.building) buildTimer = window.setTimeout(() => void checkForUpdate(true), 20_000);
  } catch {
    /* keep what we had */
  } finally {
    set({ checking: false });
  }
}

let timer: number | undefined;
let buildTimer: number | undefined;

export async function startUpdate(): Promise<void> {
  if (state.phase === "starting" || state.phase === "updating") return;
  set({ phase: "starting", message: "Asking Watchtower to update…", startedAt: Date.now() });
  const res = await fetch("/api/update", { method: "POST" }).catch(() => null);
  const body = res ? ((await res.json().catch(() => ({}))) as { error?: string }) : {};
  if (!res?.ok) {
    if (res?.status === 409) void checkForUpdate(true);
    return set({ phase: "failed", message: body.error ?? "Couldn't reach the Sapphire server." });
  }
  set({ phase: "updating", message: "Downloading the new version. Sapphire restarts in a minute or so." });
  // Wait for the server to come back reporting a different version, then reload into it.
  const before = state.info?.current;
  window.clearInterval(timer);
  timer = window.setInterval(async () => {
    const s = await fetch("/api/update").then((r) => r.json() as Promise<UpdateInfo>).catch(() => null);
    if (s && s.current && s.current !== before) {
      window.clearInterval(timer);
      window.location.reload();
    } else if (!s) {
      set({ message: "Restarting…" });
    }
  }, 4000);
  window.setTimeout(() => {
    if (state.phase !== "updating") return;
    window.clearInterval(timer);
    set({ phase: "failed", message: "Still on the old version. If the new build isn't published yet, try again in a few minutes." });
  }, 5 * 60 * 1000);
}

/** Checks once when the app opens, again every half hour, and whenever you come back to the tab. */
export function useUpdate() {
  useEffect(() => {
    if (!state.info) void checkForUpdate();
    const every = window.setInterval(() => void checkForUpdate(), 30 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible" && (!state.checkedAt || Date.now() - Date.parse(state.checkedAt) > 10 * 60 * 1000)) void checkForUpdate();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(every);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => state);
}

const PROBLEMS: Record<string, string> = {
  private: "Can't check: the GitHub repo is private. Make it public or set UPDATE_GITHUB_TOKEN in the compose file (see README, Updating).",
  token: "Can't check: GitHub refused UPDATE_GITHUB_TOKEN. It may have expired.",
  github: "Couldn't check: GitHub had a problem. Try again in a moment.",
  offline: "Couldn't check: GitHub can't be reached from the NAS.",
  version: "This copy wasn't built by GitHub, so there's no version to compare.",
  build: "The new version's build failed on GitHub, so there's nothing to install yet. Check the Actions tab.",
};

/** The "Software update" card in Settings. */
export function UpdateCard() {
  const u = useUpdate();
  const { info, checking, phase } = u;
  const busy = phase === "starting" || phase === "updating";
  const building = info?.building === true;
  const available = info?.available === true;
  const problem = info?.available === null || info?.problem === "build" ? (PROBLEMS[info?.problem ?? "github"] ?? "Couldn't check for a newer version.") : null;

  return (
    <section className={`card updateCard ${available ? "hasUpdate" : ""}`}>
      <div className="updateHead">
        <h3>Software update</h3>
        <button type="button" className="button small secondary" onClick={() => void checkForUpdate(true)} disabled={checking || busy}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
      </div>

      {busy ? (
        <div className="updateBusy">
          <Loading label={u.message ?? "Updating…"} size="md" />
          <p className="muted small">
            Keep this page open. It reloads by itself when the new version is up.
            {phase === "updating" && u.startedAt ? ` Started ${ago(new Date(u.startedAt).toISOString())}.` : ""}
          </p>
        </div>
      ) : !info ? (
        <Loading label="Checking for a newer version…" size="sm" />
      ) : (
        <>
          <dl className="versionList">
            <div><dt>Installed</dt><dd><code>{info.current ?? "unknown"}</code></dd></div>
            <div><dt>Latest</dt><dd>{info.latest ? <code>{info.latest}</code> : <span className="muted">unknown</span>}</dd></div>
          </dl>
          {checking && <Loading label="Checking for a newer version…" size="sm" block={false} />}
          {building && (
            <div className="updateBuilding">
              <Loading label="An even newer version is being built. It'll be ready to install in a minute or two." size="sm" block={false} />
              <p className="muted small">This page checks again every few seconds, so you can leave it open.</p>
            </div>
          )}
          {!checking && available && (
            <p className="updateAvail">
              <span className="dot bad" /> A newer version is available.
            </p>
          )}
          {!checking && info.available === false && !building && (
            <p>
              <span className="dot good" /> You're on the latest version.
              {u.checkedAt && <span className="muted small"> Checked {ago(u.checkedAt)}.</span>}
            </p>
          )}
          {!checking && !building && problem && (
            <p className="bad">
              {problem}
            </p>
          )}
          {phase === "failed" && u.message && <p className="bad">{u.message}</p>}
          {available && !checking &&
            (info.enabled ? (
              <button type="button" className="button" onClick={() => void startUpdate()}>
                Update now
              </button>
            ) : (
              <p className="muted small">One-tap updates aren't set up (see the Watchtower part of the compose file). Update from the Docker app instead.</p>
            ))}
        </>
      )}
    </section>
  );
}
