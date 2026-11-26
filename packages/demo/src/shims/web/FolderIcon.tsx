import { useEffect, useId, useRef } from "react";
import { StyleSheet, View } from "react-native";
import type { FolderIconProps } from "@ardia-real/shell";
import { BLEED, DURATION_MS, FOLDER_PALETTE, folderShapes, HINGE_Y, STROKE_WIDTH, VIEW_BOX } from "./folderArt";

const DEFAULT_SIDE = 16;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.(REDUCED_MOTION).matches;

type Motion = { from: number; to: number; start: number; duration: number; frame: number };

export function FolderIcon({ open, stroke, face, insideTop, insideBottom, style, ...props }: FolderIconProps) {
  const flat = StyleSheet.flatten(style) ?? {};
  const width = typeof flat.width === "number" ? flat.width : DEFAULT_SIDE;
  const height = typeof flat.height === "number" ? flat.height : width;
  const side = Math.min(width, height);
  const art = side * (1 + 2 * BLEED);
  const gradient = `ardia-folder-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const rear = useRef<SVGPathElement>(null);
  const front = useRef<SVGPathElement>(null);
  const interior = useRef<SVGLinearGradientElement>(null);
  const progress = useRef(open ? 1 : 0);
  const motion = useRef<Motion | null>(null);
  const initial = useRef(folderShapes(progress.current));

  useEffect(() => {
    const paint = (value: number) => {
      progress.current = value;
      const shapes = folderShapes(value);
      rear.current?.setAttribute("d", shapes.rear);
      front.current?.setAttribute("d", shapes.front);
      interior.current?.setAttribute("y1", String(shapes.top));
    };
    const to = open ? 1 : 0;
    const running = motion.current;
    if (running) cancelAnimationFrame(running.frame);
    motion.current = null;
    const from = progress.current;
    const duration = DURATION_MS * Math.abs(to - from);
    if (duration <= 0 || reducedMotion() || typeof requestAnimationFrame === "undefined") {
      paint(to);
      return;
    }
    const step = (now: number) => {
      const current = motion.current;
      if (!current) return;
      const t = Math.min(1, Math.max(0, (now - current.start) / current.duration));
      paint(current.from + (current.to - current.from) * t);
      if (t < 1) current.frame = requestAnimationFrame(step);
      else motion.current = null;
    };
    motion.current = { from, to, start: performance.now(), duration, frame: requestAnimationFrame(step) };
    return () => {
      if (motion.current) cancelAnimationFrame(motion.current.frame);
      motion.current = null;
    };
  }, [open]);

  const strokeColor = stroke ?? FOLDER_PALETTE.stroke;
  return (
    <View {...props} pointerEvents="none" style={style}>
      <svg
        aria-hidden
        width={art}
        height={art}
        viewBox={VIEW_BOX}
        style={{ position: "absolute", left: (width - art) / 2, top: (height - art) / 2, overflow: "visible", pointerEvents: "none" }}
      >
        <defs>
          <linearGradient ref={interior} id={gradient} gradientUnits="userSpaceOnUse" x1={0} x2={0} y1={initial.current.top} y2={HINGE_Y} spreadMethod="pad">
            <stop offset={0} stopColor={insideTop ?? FOLDER_PALETTE.insideTop} />
            <stop offset={1} stopColor={insideBottom ?? FOLDER_PALETTE.insideBottom} />
          </linearGradient>
        </defs>
        <g fill="none" stroke={strokeColor} strokeWidth={STROKE_WIDTH} strokeLinejoin="round" strokeLinecap="round">
          <path ref={rear} d={initial.current.rear} fill={`url(#${gradient})`} />
          <path ref={front} d={initial.current.front} fill={face ?? FOLDER_PALETTE.face} />
        </g>
      </svg>
    </View>
  );
}
