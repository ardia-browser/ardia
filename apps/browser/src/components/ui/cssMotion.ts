type Curve = (t: number) => number;

type SpringPhysics = { stiffness: number; damping: number; mass: number };

const CURVE_STEPS = 32;
const SPRING_STEPS = 60;
const SPRING_REST = 0.001;
const SPRING_LONGEST_MS = 10000;
const REACH_STEPS = 40;

const fixed = (n: number) => String(Math.round(n * 10000) / 10000);

export function cssEasing(curve: Curve, steps = CURVE_STEPS): string {
  const points = Array.from({ length: steps + 1 }, (_, i) => fixed(i === 0 ? 0 : i === steps ? 1 : curve(i / steps)));
  return `linear(${points.join(", ")})`;
}

function springAt({ stiffness, damping, mass }: SpringPhysics) {
  const omega = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  if (zeta < 1) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    return (t: number) => {
      const decay = Math.exp(-zeta * omega * t);
      const x = 1 - decay * (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t));
      const v = decay * Math.sin(omegaD * t) * ((omega * omega) / omegaD);
      return { x, v };
    };
  }
  return (t: number) => {
    const decay = Math.exp(-omega * t);
    return { x: 1 - decay * (1 + omega * t), v: omega * omega * t * decay };
  };
}

export function cssSpring(physics: SpringPhysics, steps = SPRING_STEPS): { duration: number; easing: string } {
  const at = springAt(physics);
  let ms = 1;
  while (ms < SPRING_LONGEST_MS) {
    const { x, v } = at(ms / 1000);
    if (Math.abs(1 - x) < SPRING_REST && Math.abs(v) < SPRING_REST) break;
    ms += 1;
  }
  const curve = (t: number) => at((t * ms) / 1000).x;
  return { duration: ms, easing: cssEasing(curve, steps) };
}

export function timeToReach(curve: Curve, progress: number): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < REACH_STEPS; i++) {
    const mid = (low + high) / 2;
    if (curve(mid) >= progress) high = mid;
    else low = mid;
  }
  return high;
}
