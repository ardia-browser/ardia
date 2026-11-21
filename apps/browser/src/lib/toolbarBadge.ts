const BADGE_CHARS = 4;
const COUNT = /^(-?)(\d+(?:\.\d+)?)([kmb]?)$/i;
const UNITS = ["", "k", "m", "b"];

export function toolbarBadgeText(value: string | number): string {
  if (typeof value === "number") return (Math.abs(value) > 999 ? `${value < 0 ? "-" : ""}999+` : String(value)).slice(0, BADGE_CHARS);
  if (value.length <= BADGE_CHARS) return value;
  return roundedCount(value) ?? value.slice(0, BADGE_CHARS);
}

function roundedCount(text: string): string | null {
  const match = COUNT.exec(text);
  if (!match) return null;
  const [, sign = "", digits = "", suffix = ""] = match;
  const upper = suffix !== suffix.toLowerCase();
  let amount = Number(digits);
  for (const unit of UNITS.slice(UNITS.indexOf(suffix.toLowerCase()))) {
    const name = upper ? unit.toUpperCase() : unit;
    for (const decimals of [1, 0]) {
      const shown = `${sign}${Number(amount.toFixed(decimals))}${name}`;
      if (shown.length <= BADGE_CHARS) return shown;
    }
    amount /= 1000;
  }
  return null;
}
