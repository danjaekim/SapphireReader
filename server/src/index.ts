import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { Store } from "./store.js";

const config = loadConfig();
const store = new Store(`${config.dataDir}/sapphire.db`);
const app = await buildApp(config, { store });
await app.listen({ port: config.port, host: config.host });
