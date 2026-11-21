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
  /** Why the newest release couldn't be read, in a few words. */
  detail?: string;
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

/**
 * The newest release tag. GitHub's API first; it's rate-limited per address (60 an hour), so when it
 * refuses, the public "releases/latest" redirect, which isn't, says the same thing.
 */
let lastFailure = "";
async function latestRelease(config: Config, fetchImpl: FetchLike): Promise<string | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.tag;
  const done = (tag: string) => {
    cache = { at: Date.now(), tag };
    lastFailure = "";
    return tag;
  };
  try {
    const res = await fetchImpl("https://api.github.com/repos/Suwayomi/Suwayomi-Server/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "sapphire", ...(config.updateGithubToken ? { authorization: `Bearer ${config.updateGithubToken}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const tag = ((await res.json()) as { tag_name?: string }).tag_name;
      if (tag) return done(tag);
    }
    lastFailure = `GitHub's API answered ${res.status}`;
  } catch {
    lastFailure = "GitHub's API couldn't be reached";
  }
  try {
    const res = await fetchImpl("https://github.com/Suwayomi/Suwayomi-Server/releases/latest", {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": "sapphire" },
      signal: AbortSignal.timeout(8000),
    });
    const tag = /\/releases\/tag\/([^/?#]+)/.exec(res.headers.get("location") ?? "")?.[1];
    if (tag) return done(decodeURIComponent(tag));
    lastFailure += `, and the releases page answered ${res.status}`;
  } catch {
    lastFailure += ", and the releases page couldn't be reached";
  }
  return cache?.tag ?? null;
}

export const engineLatestFailure = () => lastFailure;

/** Compares the engine's own version with the newest Suwayomi release. */
export async function engineUpdateInfo(config: Config, currentVersion: string | undefined, fetchImpl: FetchLike): Promise<EngineUpdateInfo> {
  const enabled = config.engineUpdateUrl !== "" && config.engineUpdateToken !== "";
  const latest = await latestRelease(config, fetchImpl);
  if (!currentVersion) return { current: null, latest, available: null, enabled, problem: "engine" };
  if (!latest) return { current: currentVersion, latest: null, available: null, enabled, problem: "github", detail: lastFailure || undefined };
  return { current: currentVersion, latest, available: compareVersions(latest, currentVersion) > 0, enabled, problem: null };
}

/** Asks the engine's own Watchtower to pull and restart it. */
export function requestEngineUpdate(config: Config, fetchImpl: FetchLike): Promise<void> {
  return requestUpdate({ ...config, updateUrl: config.engineUpdateUrl, updateToken: config.engineUpdateToken }, fetchImpl);
}
