import { useState, type FormEvent } from "react";
import { lockAdult, setAdultPin, unlockAdult, type AdultState } from "./api";

/** The 18+ switch: set a PIN once, then unlock with it. Locking applies to every device. */
export function AdultLock({ state, onChange }: { state: AdultState; onChange: (s: AdultState) => void }) {
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [oldPin, setOldPin] = useState("");
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function done(next: AdultState) {
    setPin("");
    setOldPin("");
    setChanging(false);
    setOpen(false);
    onChange(next);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (changing) done(await setAdultPin(pin, oldPin));
      else if (!state.pinSet) done(await setAdultPin(pin));
      else done(await unlockAdult(pin));
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work.");
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  async function lock() {
    done(await lockAdult().catch(() => state));
  }

  return (
    <div className="adultLock">
      <button
        type="button"
        className={`chip ${state.unlocked ? "on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={state.unlocked ? "18+ mode is on" : "18+ mode is off"}
      >
        {state.unlocked ? "18+ on" : "18+"}
      </button>
      {open && (
        <div className="adultPanel card">
          {state.unlocked && !changing ? (
            <>
              <p className="muted">18+ sources, library and Discover (18+) are showing. Locking hides them on every device.</p>
              <div className="actions">
                <button type="button" className="button small" onClick={lock}>Turn off 18+ mode</button>
                <button type="button" className="button small secondary" onClick={() => setChanging(true)}>Change PIN</button>
              </div>
            </>
          ) : (
            <form onSubmit={submit}>
              <p className="muted">
                {changing ? "Enter your current PIN, then a new one." : state.pinSet ? "Enter your PIN to turn on 18+ mode." : "Choose a PIN (4 to 8 digits) to protect 18+ mode."}
              </p>
              {changing && (
                <input type="password" inputMode="numeric" autoComplete="off" value={oldPin} onChange={(e) => setOldPin(e.target.value)} placeholder="Current PIN" aria-label="Current PIN" />
              )}
              <input
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder={changing || !state.pinSet ? "New PIN" : "PIN"}
                aria-label="PIN"
                autoFocus
              />
              {error && <p className="bad">{error}</p>}
              <div className="actions">
                <button type="submit" className="button small" disabled={busy || pin.length < 4}>
                  {changing ? "Change PIN" : state.pinSet ? "Unlock" : "Set PIN and unlock"}
                </button>
                {changing && (
                  <button type="button" className="button small secondary" onClick={() => setChanging(false)}>Cancel</button>
                )}
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
