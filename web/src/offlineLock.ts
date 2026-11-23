import type { AdultState } from "./api";

/**
 * Unlocking 18+ mode while the NAS can't be reached. Offline the lock only guards what's already saved on
 * this phone, so the phone checks for itself: the PIN against a salted PBKDF2 hash kept here (stored after
 * the PIN last worked online), or Face ID through the same passkey, asked for on this device with user
 * verification. When the NAS is back, its own lock decides again.
 */
const PIN_KEY = "sapphire.offlinePin";
const KEYS_KEY = "sapphire.offlineKeys";
const STATE_KEY = "sapphire.adultKnown";

const get = <T>(k: string): T | null => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? "null") as T | null;
  } catch {
    return null;
  }
};
const put = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // Can't keep it; offline unlock just won't be offered.
  }
};
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));

async function derive(pin: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 310_000 }, key, 256));
}

/** After the PIN worked (or was set) online: keep a hash of it so it also works offline. */
export async function rememberPin(pin: string): Promise<void> {
  if (!crypto?.subtle) return;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  put(PIN_KEY, { salt: hex(salt), hash: await derive(pin, salt) });
}

let tries: number[] = [];
export async function checkPinOffline(pin: string): Promise<"ok" | "wrong" | "locked" | "unknown"> {
  const saved = get<{ salt: string; hash: string }>(PIN_KEY);
  if (!saved || !crypto?.subtle) return "unknown";
  const now = Date.now();
  tries = tries.filter((t) => now - t < 5 * 60_000);
  if (tries.length >= 5) return "locked";
  const ok = (await derive(pin, unhex(saved.salt))) === saved.hash;
  if (!ok) tries.push(now);
  else tries = [];
  return ok ? "ok" : "wrong";
}
export const pinKnownOffline = () => get(PIN_KEY) !== null;

/** Passkey ids this phone can use (learned when Face ID is set up or used online). */
export function rememberKeys(ids: string[]): void {
  const have = get<string[]>(KEYS_KEY) ?? [];
  put(KEYS_KEY, [...new Set([...have, ...ids])].slice(-10));
}
/** The NAS's own list (when 18+ is on online), so a removed passkey stops working offline too. */
export function setKnownKeys(ids: string[]): void {
  put(KEYS_KEY, ids.slice(-10));
}
export const faceKnownOffline = () => (get<string[]>(KEYS_KEY) ?? []).length > 0;

const b64uToBytes = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** Face ID on this device with no NAS: succeeds only if the phone verified you for this site's passkey. */
export async function faceOffline(): Promise<boolean> {
  const ids = get<string[]>(KEYS_KEY) ?? [];
  if (ids.length === 0) return false;
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      userVerification: "required",
      allowCredentials: ids.map((id) => ({ id: b64uToBytes(id), type: "public-key" as const, transports: ["internal" as AuthenticatorTransport] })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) return false;
  const data = new Uint8Array((cred.response as AuthenticatorAssertionResponse).authenticatorData);
  const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(location.hostname)));
  const sameSite = rpHash.every((b, i) => data[i] === b);
  const verified = (data[32] & 0x04) !== 0; // UV: Face ID / fingerprint / passcode, not just a tap
  return sameSite && verified && ids.includes(cred.id);
}

/** What the NAS last said (PIN set, Face ID set up), so the lock looks right with no connection. */
export function rememberState(s: AdultState): void {
  put(STATE_KEY, { pinSet: s.pinSet, passkey: !!s.passkey });
}
export function knownState(): AdultState {
  const s = get<{ pinSet: boolean; passkey: boolean }>(STATE_KEY);
  return { pinSet: s?.pinSet ?? false, unlocked: false, passkey: s?.passkey ?? false };
}
