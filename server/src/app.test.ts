import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

describe("api", () => {
  it("answers the health check", async () => {
    const app = await buildApp(loadConfig({ WEB_DIR: "./does-not-exist" }));
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, name: "sapphire" });
  });

  it("reports the engine as unreachable instead of failing", async () => {
    const app = await buildApp(
      loadConfig({ WEB_DIR: "./does-not-exist", ENGINE_URL: "http://127.0.0.1:1" }),
    );
    const res = await app.inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().engine.reachable).toBe(false);
  });
});
