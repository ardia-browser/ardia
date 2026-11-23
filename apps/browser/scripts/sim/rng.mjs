export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomInt = (random, below) => Math.floor(random() * below);

export async function shrinkSequence(steps, stillFails, { budget = 600 } = {}) {
  let tries = 0;
  const attempt = async (candidate) => {
    tries++;
    return candidate.length > 0 && (await stillFails(candidate));
  };
  let current = steps;
  for (let changed = true; changed && tries < budget; ) {
    changed = false;
    const removed = await removeSteps(current, attempt, () => tries < budget);
    if (removed.length < current.length) {
      current = removed;
      changed = true;
    }
    for (let i = 0; i < current.length && tries < budget; i++) {
      for (const step of simplerPicks(current[i])) {
        const candidate = current.map((s, j) => (j === i ? step : s));
        if (await attempt(candidate)) {
          current = candidate;
          changed = true;
          break;
        }
      }
    }
    for (let i = 0; i < current.length && tries < budget; i++) {
      for (const step of otherPicks(current[i])) {
        const candidate = current.map((s, j) => (j === i ? step : s));
        const shorter = await removeSteps(candidate, attempt, () => tries < budget);
        if (shorter.length < current.length) {
          current = shorter;
          changed = true;
          break;
        }
      }
    }
  }
  return { steps: current, tries };
}

async function removeSteps(steps, attempt, more) {
  let current = steps;
  let granularity = 2;
  while (current.length >= 2 && more()) {
    const size = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length && more(); start += size) {
      const candidate = [...current.slice(0, start), ...current.slice(start + size)];
      if (await attempt(candidate)) {
        current = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(granularity * 2, current.length);
    }
  }
  return current;
}

function otherPicks(step) {
  const out = [];
  step.picks.forEach((p, i) => {
    for (const v of [1, 2, 3]) if (p !== v) out.push({ ...step, picks: step.picks.map((q, j) => (j === i ? v : q)) });
  });
  return out;
}

function simplerPicks(step) {
  const out = [];
  step.picks.forEach((p, i) => {
    if (p !== 0) out.push({ ...step, picks: step.picks.map((q, j) => (j === i ? 0 : q)) });
  });
  return out;
}
