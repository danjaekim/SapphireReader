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
  /** Watchtower's address and token, so the app can ask for an update. Empty turns the button off. */
  updateUrl: string;
  updateToken: string;
  /** A second Watchtower that can update only the engine. Empty hides the engine's update button. */
  engineUpdateUrl: string;
  engineUpdateToken: string;
  /** GitHub repo checked for newer versions. */
  updateRepo: string;
  /** Read-only GitHub token, needed to see a private repo's latest commit. */
  updateGithubToken: string;
  /** The published image to compare against, if it isn't ghcr.io/<owner>/sapphire. */
  updateImage: string;
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
    updateUrl: (env.UPDATE_URL ?? "").replace(/\/+$/, ""),
    updateToken: env.UPDATE_TOKEN ?? "",
    engineUpdateUrl: (env.ENGINE_UPDATE_URL ?? "").replace(/\/+$/, ""),
    engineUpdateToken: env.ENGINE_UPDATE_TOKEN ?? "",
    updateRepo: env.UPDATE_REPO ?? "danjaekim/SapphireReader",
    updateGithubToken: env.UPDATE_GITHUB_TOKEN ?? "",
    updateImage: env.UPDATE_IMAGE ?? "",
  };
}
