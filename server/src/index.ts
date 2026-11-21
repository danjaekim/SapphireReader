import { buildApp } from "./app.js";
import { snapshot } from "./backup.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store(`${config.dataDir}/sapphire.db`);
const app = await buildApp(config, { store });
await app.listen({ port: config.port, host: config.host });

// Look for new chapters in the background and push alerts. First run a couple of minutes
// after start so the engine has time to boot.
if (config.ntfyUrl && config.checkIntervalHours > 0) {
  const run = () => app.runCheck().catch((err: unknown) => app.log.warn(err, "library check failed"));
  setTimeout(run, 2 * 60_000);
  setInterval(run, config.checkIntervalHours * 3_600_000);
}

// A daily copy of the database in data/backups, newest seven kept.
const backup = () => {
  try {
    snapshot(store, config.dataDir);
  } catch (err) {
    app.log.warn(err, "backup failed");
  }
};
setTimeout(backup, 30_000);
setInterval(backup, 24 * 3_600_000);
