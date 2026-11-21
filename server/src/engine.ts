import type { Config } from "./config.js";

export interface EngineStatus {
  reachable: boolean;
  version?: string;
  error?: string;
}

type FetchLike = typeof fetch;

function authHeaders(config: Config): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.engineUser) {
    const token = Buffer.from(`${config.engineUser}:${config.enginePassword}`).toString("base64");
    headers.authorization = `Basic ${token}`;
  }
  return headers;
}

/** Runs one GraphQL request against the Suwayomi engine. Throws on transport or GraphQL errors. */
export async function engineQuery<T>(
  config: Config,
  query: string,
  variables: Record<string, unknown> = {},
  opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {},
): Promise<T> {
  const { fetchImpl = fetch, timeoutMs = 20000 } = opts;
  const res = await fetchImpl(`${config.engineUrl}/api/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(config) },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`engine answered ${res.status}`);
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  if (!json.data) throw new Error("engine returned no data");
  return json.data;
}

/** Downloads a file (such as a cover image) from the engine. */
export async function engineFile(
  config: Config,
  path: string,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  return fetchImpl(`${config.engineUrl}${path}`, {
    headers: authHeaders(config),
    signal: AbortSignal.timeout(20000),
  });
}

/** Asks the engine for its version; used by the status card. */
export async function checkEngine(
  config: Config,
  fetchImpl: FetchLike = fetch,
): Promise<EngineStatus> {
  try {
    const data = await engineQuery<{ aboutServer: { version?: string } }>(
      config,
      "{ aboutServer { version } }",
      {},
      { fetchImpl, timeoutMs: 5000 },
    );
    return { reachable: true, version: data.aboutServer?.version };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : "unknown error" };
  }
}
