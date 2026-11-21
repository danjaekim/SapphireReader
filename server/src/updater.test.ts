import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { clearUpdateCache, requestUpdate, updateInfo } from "./updater.js";

const config = { ...loadConfig({}), updateUrl: "http://watchtower:8080", updateToken: "tok" };

beforeEach(clearUpdateCache);

describe("updater", () => {
  it("says an update is available when main moved on", async () => {
    const f = (async () => new Response(JSON.stringify({ sha: "abcdef1234567" }))) as unknown as typeof fetch;
    expect(await updateInfo(config, "1111111", f)).toEqual({ enabled: true, available: true, latest: "abcdef1" });
    clearUpdateCache();
    expect((await updateInfo(config, "abcdef1", f)).available).toBe(false);
  });

  it("doesn't guess when GitHub or the version is unknown", async () => {
    const down = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect((await updateInfo(config, "1111111", down)).available).toBeNull();
    clearUpdateCache();
    const f = (async () => new Response(JSON.stringify({ sha: "abcdef1234567" }))) as unknown as typeof fetch;
    expect((await updateInfo(config, "dev", f)).available).toBeNull();
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
