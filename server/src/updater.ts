import type { Config } from "./config.js";

type FetchLike = typeof fetch;

const TTL_MS = 10 * 60 * 1000;
let cached: { at: number; sha: string | null; problem: UpdateInfo["problem"] } | null = null;

export function clearUpdateCache(): void {
  cached = null;
}

/** The newest commit on main, which is what the image is built from. Null if GitHub can't be reached. */
async function latestSha(config: Config, fetchImpl: FetchLike): Promise<{ sha: string | null; problem: UpdateInfo["problem"] }> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  let sha: string | null = null;
  let problem: UpdateInfo["problem"] = null;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${config.updateRepo}/commits/main`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "sapphire",
        // A private repo is invisible without a token (GitHub answers 404).
        ...(config.updateGithubToken ? { authorization: `Bearer ${config.updateGithubToken}` } : {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) sha = ((await res.json()) as { sha?: string }).sha ?? null;
    else problem = res.status === 404 || res.status === 401 || res.status === 403 ? (config.updateGithubToken ? "token" : "private") : "github";
  } catch {
    problem = "offline";
  }
  cached = { at: Date.now(), sha, problem };
  return cached;
}

export interface UpdateInfo {
  /** Whether Watchtower is set up, so the button can work. */
  enabled: boolean;
  /** True/false when known, null when the latest version couldn't be checked. */
  available: boolean | null;
  latest: string | null;
  /** Why it couldn't check: the repo is private and no token is set, the token was refused, GitHub erred, or no internet. */
  problem: "private" | "token" | "github" | "offline" | "version" | null;
}

export async function updateInfo(config: Config, current: string, fetchImpl: FetchLike): Promise<UpdateInfo> {
  const enabled = config.updateUrl !== "" && config.updateToken !== "";
  const { sha, problem } = await latestSha(config, fetchImpl);
  const versionKnown = /^[0-9a-f]{7}$/.test(current);
  const known = sha !== null && versionKnown;
  return {
    enabled,
    available: known ? !sha.startsWith(current) : null,
    latest: sha ? sha.slice(0, 7) : null,
    problem: problem ?? (versionKnown ? null : "version"),
  };
}

/**
 * Asks Watchtower to pull and restart. Watchtower answers only after it has restarted this very
 * app, so the request is sent and not waited for: success here just means the request went out.
 */
export async function requestUpdate(config: Config, fetchImpl: FetchLike): Promise<void> {
  if (!config.updateUrl || !config.updateToken) throw new Error("Updates aren't set up.");
  const sent = fetchImpl(`${config.updateUrl}/v1/update`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.updateToken}` },
  }).catch(() => {});
  // Fail fast on a refused connection or a wrong token; otherwise let it run on.
  const early = await Promise.race([
    fetchImpl(`${config.updateUrl}/`, { signal: AbortSignal.timeout(3000) }).then(() => "up", () => "down"),
    new Promise<string>((r) => setTimeout(() => r("up"), 3500)),
  ]);
  if (early === "down") throw new Error("Couldn't reach Watchtower.");
  void sent;
}
