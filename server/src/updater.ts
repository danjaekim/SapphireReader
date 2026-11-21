import type { Config } from "./config.js";

type FetchLike = typeof fetch;

const TTL_MS = 10 * 60 * 1000;
const GH_HEADERS = { accept: "application/vnd.github+json", "user-agent": "sapphire" };

export function clearUpdateCache(): void {
  digestCache.clear();
  tokenCache.clear();
  revisionCache.clear();
  commitCache = null;
}

export interface UpdateInfo {
  /** Whether Watchtower is set up, so the button can work. */
  enabled: boolean;
  /** True/false when known, null when the published image couldn't be checked. */
  available: boolean | null;
  /** The version (short commit) of the newest published image, when it can be worked out. */
  latest: string | null;
  /** A newer build than the published image is still being made (it'll be installable soon). */
  building?: boolean;
  /** Why it couldn't check. */
  problem: "private" | "token" | "github" | "offline" | "version" | "build" | null;
}

/** "ghcr.io/<owner>/sapphire": the image the CI workflow publishes. */
function imageRepo(config: Config): string {
  if (config.updateImage) return config.updateImage.replace(/^ghcr\.io\//, "");
  return `${config.updateRepo.split("/")[0].toLowerCase()}/sapphire`;
}

type DigestResult = { digest: string | null; status: "ok" | "missing" | "denied" | "error" };
const digestCache = new Map<string, { at: number; value: DigestResult }>();
const tokenCache = new Map<string, { at: number; token: string | null; denied: boolean }>();

async function registryToken(config: Config, repo: string, fetchImpl: FetchLike): Promise<{ token: string | null; denied: boolean }> {
  const hit = tokenCache.get(repo);
  if (hit && Date.now() - hit.at < 4 * 60 * 1000) return hit;
  const headers: Record<string, string> = {};
  // A private package needs a login; the same read-only GitHub token works for it (needs read:packages).
  if (config.updateGithubToken) headers.authorization = `Basic ${Buffer.from(`sapphire:${config.updateGithubToken}`).toString("base64")}`;
  const res = await fetchImpl(`https://ghcr.io/token?scope=repository:${repo}:pull`, { headers, signal: AbortSignal.timeout(8000) });
  const out = res.ok ? { at: Date.now(), token: ((await res.json()) as { token?: string }).token ?? null, denied: false } : { at: Date.now(), token: null, denied: res.status === 401 || res.status === 403 };
  tokenCache.set(repo, out);
  return out;
}

/** The content digest of a tag on the published image ("latest", or "sha-abc1234" for one build). */
async function tagDigest(config: Config, tag: string, fetchImpl: FetchLike): Promise<DigestResult> {
  const repo = imageRepo(config);
  const key = `${repo}:${tag}`;
  const hit = digestCache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value: DigestResult;
  try {
    const { token, denied } = await registryToken(config, repo, fetchImpl);
    if (!token) value = { digest: null, status: denied ? "denied" : "error" };
    else {
      const res = await fetchImpl(`https://ghcr.io/v2/${repo}/manifests/${tag}`, {
        method: "HEAD",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json",
        },
        signal: AbortSignal.timeout(8000),
      });
      value = res.ok
        ? { digest: res.headers.get("docker-content-digest"), status: "ok" }
        : { digest: null, status: res.status === 404 ? "missing" : res.status === 401 || res.status === 403 ? "denied" : "error" };
    }
  } catch {
    value = { digest: null, status: "error" };
  }
  if (value.status !== "error") digestCache.set(key, { at: Date.now(), value });
  return value;
}

const revisionCache = new Map<string, string | null>();
const MANIFEST_ACCEPT = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json";

/**
 * The commit a published image was built from, read from the image itself (its
 * org.opencontainers.image.revision label). Needs only the registry, not GitHub's API, so it keeps
 * working when GitHub rate-limits us or the commit is no longer in the newest few.
 */
async function imageRevision(config: Config, tag: string, digest: string, fetchImpl: FetchLike): Promise<string | null> {
  const repo = imageRepo(config);
  if (revisionCache.has(digest)) return revisionCache.get(digest) ?? null;
  try {
    const { token } = await registryToken(config, repo, fetchImpl);
    if (!token) return null;
    const get = async (path: string, accept: string) => {
      const res = await fetchImpl(`https://ghcr.io/v2/${repo}/${path}`, { headers: { authorization: `Bearer ${token}`, accept }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`registry answered ${res.status}`);
      return res.json() as Promise<Record<string, unknown>>;
    };
    let manifest = await get(`manifests/${tag}`, MANIFEST_ACCEPT);
    const entries = manifest.manifests as { digest: string; platform?: { os?: string } }[] | undefined;
    if (entries) {
      // An index: take a real image (not the build-provenance entries).
      const pick = entries.find((m) => m.platform?.os === "linux") ?? entries[0];
      manifest = await get(`manifests/${pick.digest}`, MANIFEST_ACCEPT);
    }
    const configDigest = (manifest.config as { digest?: string } | undefined)?.digest;
    if (!configDigest) return null;
    const cfg = (await get(`blobs/${configDigest}`, "application/vnd.oci.image.config.v1+json")) as { config?: { Labels?: Record<string, string> } };
    const rev = cfg.config?.Labels?.["org.opencontainers.image.revision"]?.slice(0, 7) ?? null;
    revisionCache.set(digest, rev);
    return rev;
  } catch {
    return null;
  }
}

/** The newest few commits on main (newest first), used to put a version number on the published image. */
let commitCache: { at: number; shas: string[] } | null = null;
async function recentCommits(config: Config, fetchImpl: FetchLike): Promise<string[]> {
  if (commitCache && Date.now() - commitCache.at < TTL_MS) return commitCache.shas;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${config.updateRepo}/commits?sha=main&per_page=12`, {
      headers: { ...GH_HEADERS, ...(config.updateGithubToken ? { authorization: `Bearer ${config.updateGithubToken}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return commitCache?.shas ?? [];
    const shas = ((await res.json()) as { sha: string }[]).map((c) => c.sha.slice(0, 7));
    commitCache = { at: Date.now(), shas };
    return shas;
  } catch {
    return commitCache?.shas ?? [];
  }
}

/** Whether the newest commit's build is still running (so a newer image is coming) or failed. */
async function buildState(config: Config, sha: string, fetchImpl: FetchLike): Promise<"building" | "failed" | "done" | "unknown"> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${config.updateRepo}/actions/runs?head_sha=${sha}&per_page=10`, {
      headers: { ...GH_HEADERS, ...(config.updateGithubToken ? { authorization: `Bearer ${config.updateGithubToken}` } : {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "unknown";
    const runs = ((await res.json()) as { workflow_runs?: { status: string; conclusion: string | null }[] }).workflow_runs ?? [];
    if (runs.length === 0) return "unknown";
    if (runs.some((r) => r.status !== "completed")) return "building";
    if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out")) return "failed";
    return "done";
  } catch {
    return "unknown";
  }
}

/**
 * Compares the image this copy runs with the newest published image ("latest" on GHCR). Both are
 * identified by their digests, so a new commit only counts once its image actually exists.
 */
export async function updateInfo(config: Config, current: string, fetchImpl: FetchLike): Promise<UpdateInfo> {
  const enabled = config.updateUrl !== "" && config.updateToken !== "";
  const base = { enabled, available: null, latest: null, building: false } as const;
  const versionKnown = /^[0-9a-f]{7}$/.test(current);

  const latest = await tagDigest(config, "latest", fetchImpl);
  if (latest.status === "denied") return { ...base, problem: config.updateGithubToken ? "token" : "private" };
  if (!latest.digest) return { ...base, problem: latest.status === "error" ? "offline" : "github" };
  if (!versionKnown) return { ...base, problem: "version" };

  const mine = await tagDigest(config, `sha-${current}`, fetchImpl);
  if (mine.status === "denied") return { ...base, problem: config.updateGithubToken ? "token" : "private" };
  if (!mine.digest) return { ...base, problem: mine.status === "error" ? "offline" : "version" };
  const available = mine.digest !== latest.digest;

  // Put a version number on the newest image: the image says which commit it was built from.
  let latestName: string | null = available ? await imageRevision(config, "latest", latest.digest, fetchImpl) : current;
  // Note a newer build that's still on its way (and name the image from commits if its label was unreadable).
  const commits = await recentCommits(config, fetchImpl);
  let building = false;
  let problem: UpdateInfo["problem"] = null;
  if (commits.length > 0) {
    const head = commits[0];
    const headDigest = (await tagDigest(config, `sha-${head}`, fetchImpl)).digest;
    if (headDigest === latest.digest) latestName = head;
    else if (headDigest === null) {
      const state = await buildState(config, head, fetchImpl);
      building = state === "building";
      if (state === "failed") problem = "build";
    }
    if (!latestName) {
      for (const sha of commits.slice(1)) {
        if ((await tagDigest(config, `sha-${sha}`, fetchImpl)).digest === latest.digest) {
          latestName = sha;
          break;
        }
      }
    }
  }
  return { enabled, available, latest: latestName, building, problem };
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
