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

describe("hidden tags", () => {
  it("saves one entry per genre and hides series that have it", async () => {
    const { Store } = await import("./store.js");
    const store = new Store(":memory:");
    store.recordSeriesTags(1, ["Romance", "Yaoi"]);
    store.recordSeriesTags(2, ["Action", "Fantasy"]);
    store.recordSeriesTags(3, ["Boy's Love"]);
    const app = await buildApp(loadConfig({ WEB_DIR: "./does-not-exist", ENGINE_URL: "http://127.0.0.1:1" }), { store });

    const saved = await app.inject({ method: "PUT", url: "/api/settings/hidden-tags", payload: { tags: ["BL", "boys love", " Yaoi "] } });
    expect(saved.json()).toEqual({ tags: ["Boys' Love"] });
    expect((await app.inject({ method: "GET", url: "/api/settings/hidden-tags" })).json()).toEqual({ tags: ["Boys' Love"] });

    const items = [1, 2, 3].map((mangaId) => ({ mangaId, title: `S${mangaId}` }));
    const res = await app.inject({ method: "POST", url: "/api/classify", payload: { items } });
    expect(res.json()).toEqual({ hide: { 1: true, 3: true } });

    await app.inject({ method: "PUT", url: "/api/settings/hidden-tags", payload: { tags: [] } });
    expect((await app.inject({ method: "POST", url: "/api/classify", payload: { items } })).json()).toEqual({ hide: {} });
  });

  it("rejects a malformed list", async () => {
    const app = await buildApp(loadConfig({ WEB_DIR: "./does-not-exist" }));
    expect((await app.inject({ method: "PUT", url: "/api/settings/hidden-tags", payload: { tags: "BL" } })).statusCode).toBe(400);
  });
});
