import type { Config } from "./config.js";
import { requestUpdate } from "./updater.js";

type FetchLike = typeof fetch;

const TTL_MS = 60 * 60 * 1000;
let cache: { at: number; tag: string | null } | null = null;

export function clearEngineUpdateCache(): void {
  cache = null;
}

export interface EngineUpdateInfo {
  /** The engine is reachable, and this is what it says it is running. */
  current: string | null;
  /** The newest Suwayomi release on GitHub. */
  latest: string | null;
  /** True/false when both are known, null when either couldn't be read. */
  available: boolean | null;
  /** The one-tap button is set up (a second Watchtower for the engine). */
  enabled: boolean;
  problem: "engine" | "github" | null;
}

/** "v2.1.1867", "2.1.1867-r1867" and the like: major, minor and build (a trailing revision is ignored). */
export function versionParts(v: string): number[] {
  return (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
}

/** Positive when `a` is newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function latestRelease(config: Config, fetchImpl: FetchLike): Promise<string | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.tag;
  try {
    const res = await fetchImpl("https://api.github.com/repos/Suwayomi/Suwayomi-Server/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "sapphire", ...(config.updateGithubToken ? { authorization: `Bearer ${config.updateGithubToken}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return cache?.tag ?? null;
    const tag = ((await res.json()) as { tag_name?: string }).tag_name ?? null;
    cache = { at: Date.now(), tag };
    return tag;
  } catch {
    return cache?.tag ?? null;
  }
}

/** Compares the engine's own version with the newest Suwayomi release. */
export async function engineUpdateInfo(config: Config, currentVersion: string | undefined, fetchImpl: FetchLike): Promise<EngineUpdateInfo> {
  const enabled = config.engineUpdateUrl !== "" && config.engineUpdateToken !== "";
  const latest = await latestRelease(config, fetchImpl);
  if (!currentVersion) return { current: null, latest, available: null, enabled, problem: "engine" };
  if (!latest) return { current: currentVersion, latest: null, available: null, enabled, problem: "github" };
  return { current: currentVersion, latest, available: compareVersions(latest, currentVersion) > 0, enabled, problem: null };
}

/** Asks the engine's own Watchtower to pull and restart it. */
export function requestEngineUpdate(config: Config, fetchImpl: FetchLike): Promise<void> {
  return requestUpdate({ ...config, updateUrl: config.engineUpdateUrl, updateToken: config.engineUpdateToken }, fetchImpl);
}
