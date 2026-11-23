import { useEffect, useRef, useState } from "react";
import { lockAdult, setAdultPin, unlockAdult, type AdultState } from "./api";
import { addPasskey, cancelled, listPasskeys, passkeysSupported, removePasskey, unlockWithPasskey, type PasskeyInfo } from "./passkey";
import { toast, toastError } from "./toast";
import { isOffline } from "./connection";
import { checkPinOffline, faceKnownOffline, faceOffline, rememberPin, setKnownKeys } from "./offlineLock";

/** The 18+ row in the menu: shows whether 18+ mode is on and opens the PIN dialog. */
export function AdultButton({ state, onOpen }: { state: AdultState; onOpen: () => void }) {
  return (
    <button type="button" className={`navItem adultItem ${state.unlocked ? "on" : ""}`} onClick={onOpen} aria-haspopup="dialog">
      <span className="navIcon" aria-hidden="true">{state.unlocked ? "🔓" : "🔒"}</span>
      <span className="navLabel">18+ mode</span>
      <span className={`navBadge ${state.unlocked ? "on" : ""}`}>{state.unlocked ? "On" : "Off"}</span>
    </button>
  );
}

type Step = "unlock" | "create" | "confirm" | "current" | "change" | "changeConfirm" | "on";

/**
 * Set a PIN once, then unlock with it. A big on-screen keypad (so phones don't need the keyboard),
 * and typing works too. Locking applies to every device.
 */
export function AdultDialog({ state, onChange, onClose }: { state: AdultState; onChange: (s: AdultState) => void; onClose: () => void }) {
  const [step, setStep] = useState<Step>(state.unlocked ? "on" : state.pinSet ? "unlock" : "create");
  const [pin, setPin] = useState("");
  const [first, setFirst] = useState("");
  const [current, setCurrent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const [keys, setKeys] = useState<PasskeyInfo[] | null>(null);
  const canFace = passkeysSupported();

  // While on, list the Face ID devices so they can be added or removed.
  useEffect(() => {
    if (step === "on" && canFace && !isOffline())
      listPasskeys().then((l) => {
        setKeys(l);
        setKnownKeys(l.map((k) => k.id));
      }, () => setKeys([]));
  }, [step, canFace]);

  // With Face ID set up, opening the lock goes straight to it; the PIN pad stays underneath as the fallback.
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current || step !== "unlock" || !state.passkey || !canFace || (isOffline() && !faceKnownOffline())) return;
    autoTried.current = true;
    void faceUnlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Face ID has its own busy flag, so the PIN pad stays usable while the Face ID prompt is up.
  const [faceBusy, setFaceBusy] = useState(false);
  async function faceUnlock() {
    if (faceBusy) return;
    setFaceBusy(true);
    setError(null);
    try {
      if (isOffline()) {
        if (!(await faceOffline())) throw new Error("Face ID didn't match.");
        onChange({ ...state, unlocked: true, offline: true });
      } else onChange(await unlockWithPasskey());
      onClose();
    } catch (err) {
      if (!cancelled(err)) setError(err instanceof Error ? err.message : "Face ID didn't work. Use your PIN.");
    } finally {
      setFaceBusy(false);
    }
  }
  async function addFace() {
    setBusy(true);
    try {
      const label = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone or iPad" : /Android/.test(navigator.userAgent) ? "Android phone" : "This computer";
      setKeys(await addPasskey(label));
      toast("Face ID is set up. Next time, use it instead of the PIN.");
      onChange({ ...state, passkey: true });
    } catch (err) {
      if (!cancelled(err)) toastError(err instanceof Error ? err.message : "Couldn't set up Face ID.");
    } finally {
      setBusy(false);
    }
  }

  const prompts: Record<Step, string> = {
    unlock: "Enter your PIN to turn on 18+ mode",
    create: "Choose a PIN (4 to 8 digits) to protect 18+ mode",
    confirm: "Enter the same PIN again",
    current: "Enter your current PIN",
    change: "Choose a new PIN (4 to 8 digits)",
    changeConfirm: "Enter the new PIN again",
    on: "18+ mode is on",
  };

  async function submit() {
    if (pin.length < 4 || busy) return;
    setError(null);
    if (step === "create" || step === "change") {
      setFirst(pin);
      setPin("");
      setStep(step === "create" ? "confirm" : "changeConfirm");
      return;
    }
    if (step === "current") {
      setCurrent(pin);
      setPin("");
      setStep("change");
      return;
    }
    if ((step === "confirm" || step === "changeConfirm") && pin !== first) {
      setError("Those didn't match. Start again.");
      setPin("");
      setFirst("");
      setStep(step === "confirm" ? "create" : "change");
      return;
    }
    setBusy(true);
    try {
      if (isOffline()) {
        // No NAS: the PIN is checked on this phone, and only what's saved here opens up.
        if (step !== "unlock") throw new Error("Setting or changing the PIN needs the NAS. Try again when you're back online.");
        const r = await checkPinOffline(pin);
        if (r === "locked") throw new Error("Too many wrong tries. Wait a few minutes.");
        if (r === "unknown") throw new Error("Unlock 18+ once while online on this phone, then it works offline too.");
        if (r === "wrong") throw new Error("Wrong PIN.");
        onChange({ ...state, unlocked: true, offline: true });
        onClose();
        return;
      }
      const next =
        step === "unlock" ? await unlockAdult(pin) : step === "confirm" ? await setAdultPin(pin) : await setAdultPin(pin, current);
      void rememberPin(pin);
      onChange(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
      setPin("");
      if (step === "changeConfirm") setStep("current");
    } finally {
      setBusy(false);
    }
  }

  // Typing works as well as tapping; Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (step === "on") return;
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < 8 ? p + e.key : p));
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Enter") void submit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => dialog.current?.focus(), []);

  const press = (d: string) => setPin((p) => (p.length < 8 ? p + d : p));

  return (
    <div className="sheetBackdrop" onClick={onClose}>
      <div className="sheet pinSheet" role="dialog" aria-modal="true" aria-label="18+ mode" ref={dialog} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" aria-hidden="true" />
        <h3>{prompts[step]}</h3>
        {step === "on" ? (
          <>
            <p className="muted">18+ sources, your 18+ library and Discover (18+) are showing. Turning it off hides them on every device.</p>
            <div className="sheetActions">
              <button
                type="button"
                className="button"
                onClick={async () => {
                  onChange(await lockAdult().catch(() => ({ ...state, unlocked: false, offline: false })));
                  onClose();
                }}
              >
                Turn off 18+ mode
              </button>
              <button type="button" className="button secondary" onClick={() => { setStep("current"); setPin(""); }}>
                Change PIN
              </button>
            </div>
            {canFace && keys !== null && (
              <div className="faceBox">
                <h4>Face ID</h4>
                {keys.map((k) => (
                  <div key={k.id} className="faceRow">
                    <span>{k.name}</span>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => void removePasskey(k.id).then((l) => { setKeys(l.passkeys); onChange({ ...state, passkey: l.passkeys.length > 0 }); }, () => toastError("Couldn't remove that."))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
                <button type="button" className="button secondary small" disabled={busy} onClick={() => void addFace()}>
                  {keys.length ? "Add this device" : "Set up Face ID on this device"}
                </button>
                <p className="muted small">Unlock 18+ mode with Face ID or your fingerprint instead of the PIN. Works on the https (Tailscale) address.</p>
              </div>
            )}
          </>
        ) : (
          <>
            {step === "unlock" && state.passkey && canFace && (!isOffline() || faceKnownOffline()) && (
              <button type="button" className="button faceBtn" disabled={faceBusy} onClick={() => void faceUnlock()}>
                Use Face ID
              </button>
            )}
            <div className={`pinDots ${error ? "shake" : ""}`} aria-live="polite" aria-label={`${pin.length} digits entered`}>
              {Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
                <span key={i} className={i < pin.length ? "filled" : ""} />
              ))}
            </div>
            {error ? <p className="bad pinMsg">{error}</p> : <p className="muted pinMsg">&nbsp;</p>}
            <div className="keypad">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <button key={d} type="button" onClick={() => press(d)}>{d}</button>
              ))}
              <button type="button" aria-label="Delete" onClick={() => setPin((p) => p.slice(0, -1))}>⌫</button>
              <button type="button" onClick={() => press("0")}>0</button>
              <button type="button" className="go" aria-label="Done" disabled={pin.length < 4 || busy} onClick={() => void submit()}>
                {busy ? "…" : "✓"}
              </button>
            </div>
          </>
        )}
        <button type="button" className="linkish sheetClose" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
