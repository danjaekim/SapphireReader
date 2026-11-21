import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { clearEngineUpdateCache, compareVersions, engineUpdateInfo } from "./engineupdate.js";

const config = loadConfig({ ENGINE_UPDATE_URL: "http://wt-engine:8080", ENGINE_UPDATE_TOKEN: "t" });
beforeEach(clearEngineUpdateCache);

const github = (tag: string | null) => (async () => (tag ? new Response(JSON.stringify({ tag_name: tag })) : new Response("{}", { status: 403 }))) as unknown as typeof fetch;

describe("engine update", () => {
  it("compares version numbers piece by piece", () => {
    expect(compareVersions("v2.1.1867", "v2.1.1799")).toBeGreaterThan(0);
    expect(compareVersions("v2.1.1867", "2.1.1867-r1867")).toBe(0);
    expect(compareVersions("v2.2.0", "v2.1.9999")).toBeGreaterThan(0);
    expect(compareVersions("v1.9.0", "v2.0.0")).toBeLessThan(0);
  });

  it("says an update is available when the newest release is ahead of the engine", async () => {
    expect(await engineUpdateInfo(config, "v2.1.1799", github("v2.1.1867"))).toMatchObject({ available: true, latest: "v2.1.1867", enabled: true, problem: null });
    clearEngineUpdateCache();
    expect(await engineUpdateInfo(config, "v2.1.1867", github("v2.1.1867"))).toMatchObject({ available: false });
  });

  it("doesn't guess when either side can't be read, and hides the button when it isn't set up", async () => {
    expect(await engineUpdateInfo(config, undefined, github("v2.1.1867"))).toMatchObject({ available: null, problem: "engine" });
    clearEngineUpdateCache();
    expect(await engineUpdateInfo(loadConfig({}), "v2.1.1799", github(null))).toMatchObject({ available: null, problem: "github", enabled: false });
  });
});

describe("engine update without GitHub's API", () => {
  it("falls back to the releases/latest redirect when the API refuses", async () => {
    const f = (async (url: string) => {
      if (String(url).startsWith("https://api.github.com")) return new Response("{}", { status: 403 });
      return new Response(null, { status: 302, headers: { location: "https://github.com/Suwayomi/Suwayomi-Server/releases/tag/v2.4.2400" } });
    }) as unknown as typeof fetch;
    expect(await engineUpdateInfo(config, "v2.4.2373", f)).toMatchObject({ available: true, latest: "v2.4.2400", problem: null });
  });
});
