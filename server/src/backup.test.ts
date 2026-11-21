import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { snapshot } from "./backup.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig({ WEB_DIR: "./does-not-exist" });

describe("backups", () => {
  it("writes a restorable snapshot and keeps only the newest seven", () => {
    const dir = mkdtempSync(join(tmpdir(), "sapphire-bk-"));
    const store = new Store(":memory:");
    store.addToLibrary({ mangaId: 1, sourceId: "s", sourceName: null, title: "Kept" });
    for (let day = 1; day <= 9; day++) snapshot(store, dir, new Date(`2026-11-0${day}T12:00:00Z`));
    const files = readdirSync(join(dir, "backups")).sort();
    expect(files).toHaveLength(7);
    expect(files[0]).toBe("sapphire-2026-11-03.db");
    const copy = new DatabaseSync(join(dir, "backups", files[6]));
    expect(copy.prepare("SELECT title FROM library").get()).toEqual({ title: "Kept" });
  });

  it("serves a download, but behind the 18+ PIN once one is set", async () => {
    const store = new Store(":memory:");
    const app = await buildApp(config, { store });
    const open = await app.inject({ url: "/api/backup" });
    expect(open.statusCode).toBe(200);
    expect(open.headers["content-disposition"]).toContain("sapphire-");
    expect(open.rawPayload.subarray(0, 15).toString()).toBe("SQLite format 3");

    const set = await app.inject({ method: "POST", url: "/api/adult/pin", payload: { pin: "4321" } });
    const cookie = String(set.headers["set-cookie"]).split(";")[0];
    await app.inject({ method: "POST", url: "/api/adult/lock", headers: { cookie } });
    expect((await app.inject({ url: "/api/backup" })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/backup", headers: { cookie } })).statusCode).toBe(403); // locked again
  });
});
