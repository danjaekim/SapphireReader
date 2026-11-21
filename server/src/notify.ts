import type { Config } from "./config.js";

export interface Notification {
  title: string;
  message: string;
  /** Where tapping the notification opens, e.g. the series page. */
  click?: string;
}

export type Notifier = (n: Notification) => Promise<void>;

/** Posts to the self-hosted ntfy server. Returns a notifier that does nothing when ntfy isn't configured. */
export function createNotifier(config: Config, fetchImpl: typeof fetch = fetch): Notifier | null {
  if (!config.ntfyUrl) return null;
  const auth =
    config.ntfyUser && config.ntfyPassword
      ? `Basic ${Buffer.from(`${config.ntfyUser}:${config.ntfyPassword}`).toString("base64")}`
      : null;
  return async (n) => {
    // JSON publishing keeps non-ASCII titles intact (HTTP headers can't carry them).
    const res = await fetchImpl(config.ntfyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify({
        topic: config.ntfyTopic,
        title: n.title,
        message: n.message,
        click: n.click,
        tags: ["books"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  };
}
