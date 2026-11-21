import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";

const PREFIX = "sapphire-";
const KEEP = 7;

export const backupName = (d = new Date()) => `${PREFIX}${d.toISOString().slice(0, 10)}.db`;

/** Writes today's snapshot into `<data>/backups` and deletes all but the newest seven. */
export function snapshot(store: Store, dataDir: string, now = new Date()): string {
  const dir = join(dataDir, "backups");
  const file = join(dir, backupName(now));
  if (existsSync(file)) rmSync(file); // one snapshot per day; a later run replaces it
  store.backupTo(file);
  const old = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(".db"))
    .sort()
    .reverse()
    .slice(KEEP);
  for (const f of old) rmSync(join(dir, f));
  return file;
}
