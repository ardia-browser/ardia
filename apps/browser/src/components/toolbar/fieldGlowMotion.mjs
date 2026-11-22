import { readFileSync } from "node:fs";

const { FIELD_LOAD } = await import("./tokens.ts");

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const EASINGS = {
  linear: (t) => t,
  quad: (t) => t * t,
  cubic: (t) => t * t * t,
  sin: (t) => 1 - Math.cos((t * Math.PI) / 2),
  exp: (t) => (t === 0 ? 0 : Math.pow(2, 10 * (t - 1))),
};
const WRAPPERS = {
  in: (f) => f,
  out: (f) => (t) => 1 - f(1 - t),
  inOut: (f) => (t) => (t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2),
};

function easingOf(expression) {
  const wrapped = /^Easing\.(in|out|inOut)\(Easing\.(\w+)\)$/.exec(expression);
  if (wrapped) return WRAPPERS[wrapped[1]](EASINGS[wrapped[2]]);
  const plain = /^Easing\.(\w+)$/.exec(expression);
  if (plain && EASINGS[plain[1]]) return EASINGS[plain[1]];
  throw new Error(`the field glow's native curves cover only Easing.in/out/inOut of linear, quad, cubic, sin and exp, not ${expression}`);
}

const curveExpressions = () => {
  const motion = source("../ui/motion.ts");
  const block = motion.slice(motion.indexOf("export const curve"));
  return Object.fromEntries([...block.matchAll(/^\s+(\w+): (Easing\.[^,\n]+),$/gm)].map(([, name, expression]) => [name, expression]));
};

const stepCurves = () => {
  const tokens = source("./tokens.ts");
  const block = tokens.slice(tokens.indexOf("  motion: {"), tokens.indexOf("\n  },", tokens.indexOf("  motion: {")));
  return Object.fromEntries([...block.matchAll(/^\s+(\w+): \{ duration: [^,]+, easing: curve\.(\w+) \}/gm)].map(([, step, curve]) => [step, curve]));
};

export function fieldGlowMotion(points = 101) {
  const curves = curveExpressions();
  const steps = stepCurves();
  const out = {};
  for (const [step, curve] of Object.entries(steps)) {
    const expression = curves[curve];
    const ease = easingOf(expression);
    out[step] = {
      duration: FIELD_LOAD.motion[step].duration,
      curve,
      expression,
      samples: Array.from({ length: points }, (_, i) => ease(i / (points - 1))),
    };
  }
  out.hold = { duration: FIELD_LOAD.motion.hold };
  return out;
}
