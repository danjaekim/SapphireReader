import { adultState, getJson, send, type AdultState } from "./api";
import { rememberKeys } from "./offlineLock";

/**
 * Face ID / Touch ID / fingerprint unlock for 18+ mode, through the browser's passkey support (WebAuthn).
 * Needs https, so it works on the Tailscale address and not on plain http.
 */
export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
}

export const passkeysSupported = () => typeof window !== "undefined" && window.isSecureContext && "PublicKeyCredential" in window && !!navigator.credentials;

const fromB64u = (s: string): ArrayBuffer => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
};
const toB64u = (buf: ArrayBuffer | null): string => {
  const bytes = new Uint8Array(buf ?? new ArrayBuffer(0));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

interface CredDesc {
  id: string;
  type: "public-key";
  transports?: AuthenticatorTransport[];
}
const descs = (l: CredDesc[] | undefined): PublicKeyCredentialDescriptor[] => (l ?? []).map((c) => ({ ...c, id: fromB64u(c.id) }));

/** True when the person cancelled the Face ID prompt (not an error worth showing). */
export const cancelled = (e: unknown) => e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "AbortError");

export const listPasskeys = () => getJson<{ passkeys: PasskeyInfo[] }>("/api/adult/passkeys").then((r) => r.passkeys);
export const removePasskey = (id: string) => send("DELETE", `/api/adult/passkeys/${encodeURIComponent(id)}`) as Promise<{ passkeys: PasskeyInfo[] }>;

/** Adds this device: asks for Face ID once, then remembers the key on the server. */
export async function addPasskey(name: string): Promise<PasskeyInfo[]> {
  const o = (await send("POST", "/api/adult/passkey/register/options")) as { challenge: string; rp: { name: string; id: string }; user: { id: string; name: string; displayName: string }; pubKeyCredParams: PublicKeyCredentialParameters[]; timeout?: number; excludeCredentials?: CredDesc[]; authenticatorSelection?: AuthenticatorSelectionCriteria; attestation?: AttestationConveyancePreference };
  const cred = (await navigator.credentials.create({
    publicKey: { ...o, challenge: fromB64u(o.challenge), user: { ...o.user, id: fromB64u(o.user.id) }, excludeCredentials: descs(o.excludeCredentials) },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Nothing was added.");
  const r = cred.response as AuthenticatorAttestationResponse;
  const response = {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports?.() ?? [] },
  };
  const done = (await send("POST", "/api/adult/passkey/register/verify", { response, challenge: o.challenge, name })) as { passkeys: PasskeyInfo[] };
  rememberKeys([cred.id]);
  return done.passkeys;
}

/** Turns on 18+ mode with Face ID instead of the PIN. */
export async function unlockWithPasskey(): Promise<AdultState> {
  const o = (await send("POST", "/api/adult/passkey/login/options")) as { challenge: string; rpId?: string; timeout?: number; allowCredentials?: CredDesc[]; userVerification?: UserVerificationRequirement };
  const cred = (await navigator.credentials.get({ publicKey: { ...o, challenge: fromB64u(o.challenge), allowCredentials: descs(o.allowCredentials) } })) as PublicKeyCredential | null;
  if (!cred) throw new Error("Face ID didn't answer.");
  const r = cred.response as AuthenticatorAssertionResponse;
  const response = {
    id: cred.id,
    rawId: toB64u(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : undefined },
  };
  await send("POST", "/api/adult/passkey/login/verify", { response, challenge: o.challenge });
  rememberKeys([cred.id]);
  return adultState();
}
