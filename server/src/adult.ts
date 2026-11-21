import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.js";

export const COOKIE = "sapphire_18";
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_TRIES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

const hash = (pin: string, salt: Buffer) => scryptSync(pin, salt, 32);

/** The PIN behind 18+ mode, and who is currently unlocked. Unlocking is per browser, for 12 hours. */
export class AdultGate {
  private sessions = new Map<string, number>();
  private failures: number[] = [];

  constructor(private store: Store) {}

  pinSet(): boolean {
    return this.store.getSetting("adult_pin") !== null;
  }

  /** A PIN is 4 to 8 digits. */
  static validPin(pin: unknown): pin is string {
    return typeof pin === "string" && /^\d{4,8}$/.test(pin);
  }

  setPin(pin: string): void {
    const salt = randomBytes(16);
    this.store.setSetting("adult_pin", `${salt.toString("hex")}:${hash(pin, salt).toString("hex")}`);
  }

  /** Checks a PIN, with a short lockout after too many wrong guesses. */
  check(pin: string): "ok" | "wrong" | "locked" {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < LOCKOUT_MS);
    if (this.failures.length >= MAX_TRIES) return "locked";
    const stored = this.store.getSetting("adult_pin");
    if (!stored) return "wrong";
    const [salt, expected] = stored.split(":");
    const ok = timingSafeEqual(hash(pin, Buffer.from(salt, "hex")), Buffer.from(expected, "hex"));
    if (!ok) this.failures.push(now);
    else this.failures = [];
    return ok ? "ok" : "wrong";
  }

  open(): string {
    const token = randomBytes(24).toString("hex");
    this.sessions.set(token, Date.now() + SESSION_MS);
    return token;
  }

  private tokenFrom(cookieHeader: string | undefined): string | null {
    const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`).exec(cookieHeader ?? "");
    return match ? match[1] : null;
  }

  unlocked(cookieHeader: string | undefined): boolean {
    const token = this.tokenFrom(cookieHeader);
    const expires = token ? this.sessions.get(token) : undefined;
    if (!token || !expires) return false;
    if (expires < Date.now()) {
      this.sessions.delete(token);
      return false;
    }
    return true;
  }

  close(cookieHeader: string | undefined): void {
    const token = this.tokenFrom(cookieHeader);
    if (token) this.sessions.delete(token);
  }

  /** Locking from one device locks every device. */
  closeAll(): void {
    this.sessions.clear();
  }
}

export const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`;
export const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
