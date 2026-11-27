import type { CSSProperties } from "react";

export const GRADIENTS = [
  "linear-gradient(135deg, #f6d5e1 0%, #c07a98 100%)",
  "linear-gradient(135deg, #cfe3f3 0%, #4691c3 100%)",
  "linear-gradient(135deg, #e2def3 0%, #7873af 100%)",
  "linear-gradient(120deg, #fde3cf 0%, #d87249 100%)",
  "linear-gradient(120deg, #fbefc9 0%, #e3ac38 100%)",
  "linear-gradient(120deg, #cdeee1 0%, #3eb489 100%)",
  "linear-gradient(160deg, #3a3a3c 0%, #8e8e93 100%)",
  "linear-gradient(135deg, #4691c3 0%, #7873af 50%, #c07a98 100%)",
  "linear-gradient(135deg, #e3ac38 0%, #d87249 50%, #c1575c 100%)",
  "linear-gradient(135deg, #3eb489 0%, #4691c3 100%)",
  "radial-gradient(circle at 20% 20%, #f6d5e1 0%, transparent 50%), radial-gradient(circle at 80% 60%, #cfe3f3 0%, transparent 55%), #e2def3",
  "radial-gradient(circle at 30% 70%, #3eb489 0%, transparent 50%), radial-gradient(circle at 75% 30%, #4691c3 0%, transparent 55%), #1f2a36",
];

export const COLORS = ["#c1575c", "#d87249", "#e3ac38", "#3eb489", "#4691c3", "#7873af", "#c07a98", "#8e8e93", "#2c2c2e", "#ece9e4"];

export function coverValue(cover: string): string | null {
  if (cover.startsWith("gradient:")) return GRADIENTS[Number(cover.slice(9)) % GRADIENTS.length] ?? null;
  if (cover.startsWith("color:")) return COLORS[Number(cover.slice(6)) % COLORS.length] ?? null;
  return null;
}

export function coverStyle(cover: string, imageUrl: string | null, y = 50): CSSProperties {
  if (imageUrl) return { backgroundImage: `url("${imageUrl}")`, backgroundSize: "cover", backgroundPosition: `center ${y}%` };
  const value = coverValue(cover);
  return value ? { background: value } : {};
}
