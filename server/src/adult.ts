import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.js";

export const COOKIE = "sapphire_18";
/** Unlocked stays unlocked while you keep using the app; this long with no requests locks it again. */
const IDLE_MS = 2 * 60 * 60 * 1000;
/** Writes of "last active" to disk are at most this often. */
const SAVE_EVERY_MS = 60 * 1000;
const MAX_TRIES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

const hash = (pin: string, salt: Buffer) => scryptSync(pin, salt, 32);

/**
 * The PIN behind 18+ mode, and who is currently unlocked. Unlocking is per browser. It survives
 * app updates and restarts (sessions are saved), lasts while the app is in use, ends after two
 * hours with no activity, and the cookie itself goes when the browser is closed.
 */
export class AdultGate {
  /** token -> when it was last used. */
  private sessions = new Map<string, number>();
  private failures: number[] = [];
  private savedAt = 0;

  constructor(private store: Store) {
    try {
      const saved = JSON.parse(store.getSetting("adult_sessions") ?? "{}") as Record<string, unknown>;
      const now = Date.now();
      for (const [token, last] of Object.entries(saved)) if (typeof last === "number" && now - last < IDLE_MS) this.sessions.set(token, last);
    } catch {
      // Start with nobody unlocked.
    }
  }

  private save(force = false) {
    const now = Date.now();
    if (!force && now - this.savedAt < SAVE_EVERY_MS) return;
    this.savedAt = now;
    this.store.setSetting("adult_sessions", JSON.stringify(Object.fromEntries(this.sessions)));
  }

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
    this.sessions.set(token, Date.now());
    this.save(true);
    return token;
  }

  private tokenFrom(cookieHeader: string | undefined): string | null {
    const match = new RegExp(`(?:^|;\\s*)${COOKIE}=([0-9a-f]+)`).exec(cookieHeader ?? "");
    return match ? match[1] : null;
  }

  unlocked(cookieHeader: string | undefined): boolean {
    const token = this.tokenFrom(cookieHeader);
    const last = token ? this.sessions.get(token) : undefined;
    if (!token || last === undefined) return false;
    const now = Date.now();
    if (now - last > IDLE_MS) {
      this.sessions.delete(token);
      this.save(true);
      return false;
    }
    // Every request while unlocked counts as activity.
    this.sessions.set(token, now);
    this.save();
    return true;
  }

  close(cookieHeader: string | undefined): void {
    const token = this.tokenFrom(cookieHeader);
    if (token) {
      this.sessions.delete(token);
      this.save(true);
    }
  }

  /** Locking from one device locks every device. */
  closeAll(): void {
    this.sessions.clear();
    this.save(true);
  }
}

export const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
export const clearedCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
