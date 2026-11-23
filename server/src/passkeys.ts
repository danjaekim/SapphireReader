import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Store } from "./store.js";

/**
 * Passkeys (Face ID, Touch ID, a phone's fingerprint) as another way to turn on 18+ mode. The PIN stays: it
 * sets the passkey up (you must be unlocked to add one) and is the fallback. Only public keys are stored.
 * Passkeys need https on a fixed address, so they work on the Tailscale address and not on plain http.
 */
const CHALLENGE_MS = 5 * 60 * 1000;
const USER_ID = new TextEncoder().encode("sapphire-owner");

export interface PasskeyRow {
  id: string;
  name: string;
  createdAt: string;
}

export class Passkeys {
  /** challenge -> expiry; each is good for one try. */
  private challenges = new Map<string, number>();

  constructor(private store: Store) {}

  private take(challenge: string): boolean {
    const now = Date.now();
    for (const [c, t] of this.challenges) if (t < now) this.challenges.delete(c);
    const ok = (this.challenges.get(challenge) ?? 0) > now;
    this.challenges.delete(challenge);
    return ok;
  }
  private remember(challenge: string) {
    this.challenges.set(challenge, Date.now() + CHALLENGE_MS);
  }

  any(): boolean {
    return this.store.passkeys().length > 0;
  }
  list(): PasskeyRow[] {
    return this.store.passkeys().map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt }));
  }
  remove(id: string): void {
    this.store.removePasskey(id);
  }

  async registerOptions(rpID: string) {
    const options = await generateRegistrationOptions({
      rpName: "Sapphire",
      rpID,
      userName: "Sapphire",
      userID: USER_ID,
      attestationType: "none",
      excludeCredentials: this.store.passkeys().map((p) => ({ id: p.id, transports: p.transports as never })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
    });
    this.remember(options.challenge);
    return options;
  }

  async registerVerify(response: RegistrationResponseJSON, challenge: string, origin: string, rpID: string, name: string): Promise<boolean> {
    if (!this.take(challenge)) return false;
    const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }).catch(() => null);
    if (!v?.verified) return false;
    const c = v.registrationInfo.credential;
    this.store.addPasskey({ id: c.id, publicKey: Buffer.from(c.publicKey), counter: c.counter, transports: c.transports ?? [], name });
    return true;
  }

  async loginOptions(rpID: string) {
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "required",
      // A passkey made on this device is asked for on this device only, so the phone goes straight to Face ID
      // instead of offering "use a phone or security key" first.
      allowCredentials: this.store.passkeys().map((p) => ({ id: p.id, transports: (p.transports.includes("internal") ? ["internal"] : p.transports) as never })),
    });
    this.remember(options.challenge);
    return options;
  }

  async loginVerify(response: AuthenticationResponseJSON, challenge: string, origin: string, rpID: string): Promise<boolean> {
    if (!this.take(challenge)) return false;
    const p = this.store.passkeys().find((x) => x.id === response.id);
    if (!p) return false;
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: p.id, publicKey: new Uint8Array(p.publicKey), counter: p.counter, transports: p.transports as never },
      requireUserVerification: true,
    }).catch(() => null);
    if (!v?.verified) return false;
    this.store.touchPasskey(p.id, v.authenticationInfo.newCounter);
    return true;
  }
}

export const newPasskeyName = () => `Passkey ${randomBytes(2).toString("hex")}`;
