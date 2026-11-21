export interface Config {
  port: number;
  host: string;
  webDir: string;
  engineUrl: string;
  engineUser: string;
  enginePassword: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8080),
    host: env.HOST ?? "0.0.0.0",
    webDir: env.WEB_DIR ?? "./public",
    engineUrl: (env.ENGINE_URL ?? "http://engine:4567").replace(/\/+$/, ""),
    engineUser: env.ENGINE_USER ?? "",
    enginePassword: env.ENGINE_PASSWORD ?? "",
  };
}
