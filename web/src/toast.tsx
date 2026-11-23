import { useEffect, useState } from "react";

/**
 * Short confirmations ("Marked 2 not 18+") that show for a few seconds at the bottom of the screen,
 * whatever page you're on, instead of a line that stays on the page after you've moved on.
 */
export interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error";
  action?: { label: string; run: () => void };
}

let next = 1;
let listeners: ((t: Toast) => void)[] = [];

export function toast(text: string, opts: { kind?: "ok" | "error"; action?: Toast["action"] } = {}): void {
  const t: Toast = { id: next++, text, kind: opts.kind ?? "ok", action: opts.action };
  for (const l of listeners) l(t);
}
export const toastError = (text: string) => toast(text, { kind: "error" });

/** Where toasts appear; rendered once by the app. */
export function Toaster() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => {
    const add = (t: Toast) => {
      // At most three at once; the newest at the bottom.
      setList((l) => [...l.slice(-2), t]);
      window.setTimeout(() => setList((l) => l.filter((x) => x.id !== t.id)), t.kind === "error" || t.action ? 6500 : 4000);
    };
    listeners.push(add);
    return () => {
      listeners = listeners.filter((l) => l !== add);
    };
  }, []);
  const close = (id: number) => setList((l) => l.filter((x) => x.id !== id));
  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span className="toastText">{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toastAction"
              onClick={() => {
                t.action!.run();
                close(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toastClose" aria-label="Dismiss" onClick={() => close(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
