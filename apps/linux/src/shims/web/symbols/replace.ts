const STIFFNESS = 380;
const DAMPING = 26;
const SETTLE_MS = 420;
const SAMPLES = 32;

function springCurve() {
  const omega = Math.sqrt(STIFFNESS);
  const zeta = DAMPING / (2 * omega);
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const at = (t: number) => 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
  const points = Array.from({ length: SAMPLES + 1 }, (_, i) => at(((i / SAMPLES) * SETTLE_MS) / 1000).toFixed(4));
  points[SAMPLES] = "1";
  return `linear(${points.join(", ")})`;
}

export const SYMBOL_REPLACE = {
  out: { duration: 160, scale: 0.5, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
  in: { duration: SETTLE_MS, scale: 0.5, easing: springCurve() },
  fade: { duration: 150, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
} as const;
