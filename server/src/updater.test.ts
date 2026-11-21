import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { clearUpdateCache, requestUpdate, updateInfo } from "./updater.js";

const config = { ...loadConfig({}), updateUrl: "http://watchtower:8080", updateToken: "tok" };

beforeEach(clearUpdateCache);

/** A fake GHCR + GitHub: `tags` maps a tag to its digest; `commits` is main's history, newest first. */
function fakeWorld(opts: { tags: Record<string, string>; commits?: string[]; runs?: { status: string; conclusion: string | null }[]; denied?: boolean; revision?: string }) {
  return (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.startsWith("https://ghcr.io/token")) return opts.denied ? new Response("{}", { status: 401 }) : new Response(JSON.stringify({ token: "t" }));
    if (u.includes("/blobs/")) return new Response(JSON.stringify({ config: { Labels: { "org.opencontainers.image.revision": (opts.revision ?? "").padEnd(40, "0") } } }));
    const m = u.match(/ghcr\.io\/v2\/.+\/manifests\/(.+)$/);
    if (m && init?.method !== "HEAD") {
      if (!opts.revision) return new Response(null, { status: 404 });
      // The image index lists the real image and a build-provenance entry.
      if (m[1] === "latest") return new Response(JSON.stringify({ manifests: [{ digest: "sha256:att", platform: { os: "unknown" } }, { digest: "sha256:img", platform: { os: "linux" } }] }));
      return new Response(JSON.stringify({ config: { digest: "sha256:cfg" } }));
    }
    if (m) {
      const d = opts.tags[m[1]];
      return d ? new Response(null, { headers: { "docker-content-digest": d } }) : new Response(null, { status: 404 });
    }
    if (u.includes("/commits?")) return new Response(JSON.stringify((opts.commits ?? []).map((sha) => ({ sha: sha.padEnd(40, "0") }))));
    if (u.includes("/actions/runs")) return new Response(JSON.stringify({ workflow_runs: opts.runs ?? [] }));
    throw new Error(`unexpected request ${u}`);
  }) as unknown as typeof fetch;
}

describe("updater", () => {
  it("says an update is available when a newer image is published, and names it", async () => {
    const f = fakeWorld({ tags: { latest: "sha256:new", "sha-1111111": "sha256:old", "sha-abcdef1": "sha256:new" }, commits: ["abcdef1", "1111111"] });
    expect(await updateInfo(config, "1111111", f)).toMatchObject({ enabled: true, available: true, latest: "abcdef1", building: false, problem: null });
  });

  it("names the newest image from its own revision label, even when GitHub's commit list can't be read", async () => {
    const f = fakeWorld({ tags: { latest: "sha256:new", "sha-1111111": "sha256:old" }, commits: [], revision: "abcdef1" });
    expect(await updateInfo(config, "1111111", f)).toMatchObject({ available: true, latest: "abcdef1" });
  });

  it("says you're up to date when your image is the newest published one", async () => {
    const f = fakeWorld({ tags: { latest: "sha256:x", "sha-abcdef1": "sha256:x" }, commits: ["abcdef1"] });
    expect(await updateInfo(config, "abcdef1", f)).toMatchObject({ available: false, latest: "abcdef1", building: false });
  });

  it("doesn't offer a commit whose image isn't published yet, and notes the build", async () => {
    const f = fakeWorld({
      tags: { latest: "sha256:x", "sha-1111111": "sha256:x" },
      commits: ["2222222", "1111111"],
      runs: [{ status: "in_progress", conclusion: null }],
    });
    expect(await updateInfo(config, "1111111", f)).toMatchObject({ available: false, latest: "1111111", building: true });
  });

  it("reports a failed build", async () => {
    const f = fakeWorld({ tags: { latest: "sha256:x", "sha-1111111": "sha256:x" }, commits: ["2222222", "1111111"], runs: [{ status: "completed", conclusion: "failure" }] });
    expect(await updateInfo(config, "1111111", f)).toMatchObject({ available: false, building: false, problem: "build" });
  });

  it("explains a private package and doesn't guess when it can't tell", async () => {
    expect(await updateInfo(config, "1111111", fakeWorld({ tags: {}, denied: true }))).toMatchObject({ available: null, problem: "private" });
    clearUpdateCache();
    expect(await updateInfo({ ...config, updateGithubToken: "gh" }, "1111111", fakeWorld({ tags: {}, denied: true }))).toMatchObject({ problem: "token" });
    clearUpdateCache();
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await updateInfo(config, "1111111", down)).toMatchObject({ available: null, problem: "offline" });
    clearUpdateCache();
    expect(await updateInfo(config, "dev", fakeWorld({ tags: { latest: "sha256:x" } }))).toMatchObject({ available: null, problem: "version" });
  });

  it("posts to Watchtower with the token and fails when it's unreachable", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const ok = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      return new Response("{}");
    }) as unknown as typeof fetch;
    await requestUpdate(config, ok);
    expect(seen[0]).toEqual({ url: "http://watchtower:8080/v1/update", auth: "Bearer tok" });
    const down = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    await expect(requestUpdate(config, down)).rejects.toThrow(/Watchtower/);
    await expect(requestUpdate({ ...config, updateUrl: "" }, ok)).rejects.toThrow();
  });
});
