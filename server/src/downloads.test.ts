import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";
import { fakeEngine } from "./test-engine.js";

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "sapphire-dl-"));
  const config = loadConfig({ WEB_DIR: "./does-not-exist", DATA_DIR: dataDir });
  const store = new Store(":memory:");
  const app = await buildApp(config, { fetchImpl: fakeEngine(), store });
  return { app, store, dataDir };
}

const body = (extra = {}) => ({
  mangaId: 10,
  title: "Nano Machine",
  sourceId: "1",
  sourceName: "Asura Scans",
  chapters: [{ id: 501, name: "Chapter 3", number: 3 }],
  ...extra,
});

describe("downloads", () => {
  it("saves a chapter to disk and then reads it from disk", async () => {
    const { app, dataDir } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/downloads", payload: body() })).json()).toEqual({ queued: 1 });
    await app.downloader.idle();

    const { items, totalBytes } = (await app.inject({ url: "/api/downloads" })).json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ chapterId: 501, status: "done", pages: 2 });
    expect(totalBytes).toBe(4); // two 2-byte fake pages
    expect(existsSync(join(dataDir, "downloads", "10", "501", "0.webp"))).toBe(true);

    // The page list now points at local files, and they are served from disk.
    const pages = (await app.inject({ url: "/api/chapters/501/pages" })).json();
    expect(pages).toMatchObject({ pages: ["/api/dl/501/0", "/api/dl/501/1"], downloaded: true });
    const img = await app.inject({ url: "/api/dl/501/1" });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/webp");
    expect(img.rawPayload.length).toBe(2);

    // The cover is kept too, so the downloads page works without the engine.
    expect(existsSync(join(dataDir, "downloads", "10", "cover.png"))).toBe(true);

    expect((await app.inject({ url: "/api/manga/10/downloads" })).json().items).toEqual([{ chapterId: 501, status: "done", error: null }]);
  });

  it("doesn't queue the same chapter twice, and removes files on delete", async () => {
    const { app, dataDir } = await setup();
    await app.inject({ method: "POST", url: "/api/downloads", payload: body() });
    await app.downloader.idle();
    expect((await app.inject({ method: "POST", url: "/api/downloads", payload: body() })).json()).toEqual({ queued: 0 });
    await app.inject({ method: "DELETE", url: "/api/downloads/501" });
    expect(existsSync(join(dataDir, "downloads", "10"))).toBe(false);
    expect((await app.inject({ url: "/api/downloads" })).json().items).toEqual([]);
    expect((await app.inject({ url: "/api/dl/501/0" })).statusCode).toBe(404);
  });

  it("marking chapters read by hand clears their downloads too (auto-delete), the last one included", async () => {
    const { app, store } = await setup();
    await app.inject({ method: "PUT", url: "/api/library/10", payload: { sourceId: "1", sourceName: "Asura Scans", title: "Nano Machine" } });
    await app.inject({ method: "PUT", url: "/api/settings/automation", payload: { autoDelete: true, autoDownload: 0 } });
    await app.inject({ method: "POST", url: "/api/downloads", payload: body({ chapters: [{ id: 501, name: "Chapter 3", number: 3 }] }) });
    await app.downloader.idle();
    expect(store.getDownload(501)).toMatchObject({ status: "done" });
    // 501 is also where you are now (the last one you read): it goes too.
    await app.inject({ method: "POST", url: "/api/manga/10/read", payload: { chapterIds: [501], read: true } });
    expect((await app.inject({ url: "/api/manga/10/downloads" })).json().items).toEqual([]);
  });

  it("marks a chapter failed when the source's pages can't be fetched, and can retry it", async () => {
    const { app, store } = await setup();
    // Chapter 502 makes the fake engine return an address outside the allowed pattern.
    await app.inject({ method: "POST", url: "/api/downloads", payload: body({ chapters: [{ id: 502, name: "Bad", number: 4 }] }) });
    await app.downloader.idle();
    expect(store.getDownload(502)).toMatchObject({ status: "failed" });
    expect(store.getDownload(502)?.error).toBeTruthy();
    expect((await app.inject({ method: "POST", url: "/api/downloads", payload: body({ chapters: [{ id: 502, name: "Bad", number: 4 }] }) })).json()).toEqual({ queued: 1 });
  });

  it("keeps 18+ downloads behind the lock", async () => {
    const { app } = await setup();
    const adult = body({ sourceId: "3", sourceName: "ToonGod", title: "Secret" });
    expect((await app.inject({ method: "POST", url: "/api/downloads", payload: adult })).statusCode).toBe(403);
    const cookie = String((await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } })).headers["set-cookie"]).split(";")[0];
    expect((await app.inject({ method: "POST", url: "/api/downloads", payload: adult, headers: { cookie } })).statusCode).toBe(200);
    await app.downloader.idle();
    expect((await app.inject({ url: "/api/downloads" })).json().items).toEqual([]);
    expect((await app.inject({ url: "/api/downloads", headers: { cookie } })).json().items).toHaveLength(1);
  });

  it("rejects bad requests", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/downloads", payload: { mangaId: 1 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/downloads", payload: body({ chapters: [] }) })).statusCode).toBe(400);
  });
});
