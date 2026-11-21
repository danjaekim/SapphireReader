export interface Config {
  port: number;
  host: string;
  webDir: string;
  dataDir: string;
  engineUrl: string;
  engineUser: string;
  enginePassword: string;
  /** ntfy publish address, e.g. http://ntfy:80. Empty turns alerts off. */
  ntfyUrl: string;
  ntfyTopic: string;
  ntfyUser: string;
  ntfyPassword: string;
  /** How Sapphire is reached from your phone, so tapping an alert opens the series. */
  publicUrl: string;
  checkIntervalHours: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    webDir: env.WEB_DIR ?? "./public",
    dataDir: env.DATA_DIR ?? "./data",
    engineUrl: (env.ENGINE_URL ?? "http://engine:4567").replace(/\/+$/, ""),
    engineUser: env.ENGINE_USER ?? "",
    enginePassword: env.ENGINE_PASSWORD ?? "",
    ntfyUrl: (env.NTFY_URL ?? "").replace(/\/+$/, ""),
    ntfyTopic: env.NTFY_TOPIC ?? "sapphire",
    ntfyUser: env.NTFY_USER ?? "",
    ntfyPassword: env.NTFY_PASSWORD ?? "",
    publicUrl: (env.PUBLIC_URL ?? "").replace(/\/+$/, ""),
    checkIntervalHours: Number(env.CHECK_INTERVAL_HOURS ?? 6),
  };
}
