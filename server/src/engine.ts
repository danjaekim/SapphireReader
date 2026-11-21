import type { Config } from "./config.js";

export interface EngineStatus {
  reachable: boolean;
  version?: string;
  error?: string;
}

/** Asks the Suwayomi engine for its version; used by the status page. */
export async function checkEngine(
  config: Config,
  fetchImpl: typeof fetch = fetch,
): Promise<EngineStatus> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.engineUser) {
    const token = Buffer.from(`${config.engineUser}:${config.enginePassword}`).toString("base64");
    headers.authorization = `Basic ${token}`;
  }
  try {
    const res = await fetchImpl(`${config.engineUrl}/api/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: "{ aboutServer { version } }" }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { reachable: false, error: `engine answered ${res.status}` };
    const json = (await res.json()) as { data?: { aboutServer?: { version?: string } } };
    return { reachable: true, version: json.data?.aboutServer?.version };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : "unknown error" };
  }
}
