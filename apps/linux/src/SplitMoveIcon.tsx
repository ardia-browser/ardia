import splitMoveSvg from "../../browser/assets/split-move.svg";

export function SplitMoveIcon({ size, color }: { size: number; color: string }) {
  const mask = `url("${splitMoveSvg}") center / contain no-repeat`;
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        backgroundColor: color,
        mask,
        WebkitMask: mask,
        pointerEvents: "none",
      }}
    />
  );
}
