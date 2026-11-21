/**
 * Sapphire's loading cat: a cat head inside a spinning ring. The eyes blink and the whiskers twitch
 * while it works. It scales with the screen, and holds still for people who prefer less motion.
 */
export function CatSpinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  return (
    <svg className={`catSpinner ${size}`} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <circle className="catRingTrack" cx="32" cy="32" r="29" fill="none" strokeWidth="3" />
      <circle className="catRing" cx="32" cy="32" r="29" fill="none" strokeWidth="3" strokeLinecap="round" pathLength="100" />
      <g className="catHead" transform="translate(11 12) scale(0.083)">
        <path d="M110 210 L132 92 L220 160 Q256 150 292 160 L380 92 L402 210 Q420 250 410 300 Q392 400 256 410 Q120 400 102 300 Q92 250 110 210 Z" fill="#3b82f6" />
        <path d="M138 128 L196 170 Q160 180 140 206 Z" fill="#93c5fd" />
        <path d="M374 128 L316 170 Q352 180 372 206 Z" fill="#93c5fd" />
        <g className="catEyes">
          <ellipse cx="200" cy="268" rx="26" ry="32" fill="#0b1220" />
          <ellipse cx="312" cy="268" rx="26" ry="32" fill="#0b1220" />
          <ellipse cx="208" cy="258" rx="8" ry="10" fill="#e0f2fe" />
          <ellipse cx="320" cy="258" rx="8" ry="10" fill="#e0f2fe" />
        </g>
        <path d="M242 318 L270 318 L256 336 Z" fill="#fbcfe8" />
        <path d="M256 336 Q256 356 232 358 M256 336 Q256 356 280 358" stroke="#0b1220" strokeWidth="6" fill="none" strokeLinecap="round" />
        <g className="catWhiskersL" stroke="#e0f2fe" strokeWidth="6" strokeLinecap="round">
          <path d="M150 322 L70 304" />
          <path d="M150 342 L76 356" />
        </g>
        <g className="catWhiskersR" stroke="#e0f2fe" strokeWidth="6" strokeLinecap="round">
          <path d="M362 322 L442 304" />
          <path d="M362 342 L436 356" />
        </g>
      </g>
    </svg>
  );
}

/** A loading message with the cat beside (or above) it. Announced politely to screen readers. */
export function Loading({ label, size = "md", block = true }: { label?: string; size?: "sm" | "md" | "lg"; block?: boolean }) {
  return (
    <div className={`loading ${block ? "block" : "inline"}`} role="status" aria-live="polite">
      <CatSpinner size={size} />
      {label && <span className="loadingLabel">{label}</span>}
    </div>
  );
}
