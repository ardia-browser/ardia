import type { CSSProperties, ReactNode } from "react";
import { SYMBOLS, symbolStyle, useSymbolSupport } from "./symbols";

const paths: Record<string, ReactNode> = {
  chevronRight: <path d="M6.5 4l4 4-4 4" />,
  chevronDown: <path d="M4 6.5l4 4 4-4" />,
  chevronLeft: <path d="M9.5 4l-4 4 4 4" />,
  chevronsLeft: <path d="M8.5 4l-4 4 4 4M12.5 4l-4 4 4 4" />,
  plus: <path d="M8 3v10M3 8h10" />,
  more: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  drag: (
    <>
      {[4, 8, 12].map((y) => (
        <g key={y}>
          <circle cx="6" cy={y} r="1.05" fill="currentColor" stroke="none" />
          <circle cx="10" cy={y} r="1.05" fill="currentColor" stroke="none" />
        </g>
      ))}
    </>
  ),
  search: <path d="M7 12a5 5 0 100-10 5 5 0 000 10zM10.6 10.6L14 14" />,
  home: <path d="M2.5 7.5L8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />,
  settings: <path d="M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" />,
  template: <path d="M3 2.5h10v11H3zM3 6h10M6.5 6v7.5" />,
  page: <path d="M4 2h5.5L12.5 5v9H4zM9.5 2v3h3M6 8h4.5M6 10.5h4.5" />,
  pageEmpty: <path d="M4 2h5.5L12.5 5v9H4zM9.5 2v3h3" />,
  star: <path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.2l-3.53 1.85.7-3.93L2.3 6.35l3.95-.55z" />,
  starFilled: <path d="M8 2.2l1.75 3.6 3.95.55-2.87 2.77.7 3.93L8 11.2l-3.53 1.85.7-3.93L2.3 6.35l3.95-.55z" fill="currentColor" />,
  comment: <path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z" />,
  clock: <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM8 4.8V8l2.2 1.4" />,
  lock: <path d="M4 7.5h8V14H4zM5.5 7.5V5.2a2.5 2.5 0 015 0v2.3" />,
  unlock: <path d="M4 7.5h8V14H4zM5.5 7.5V5.2a2.5 2.5 0 014.9-.7" />,
  link: <path d="M6.8 9.2a2.6 2.6 0 003.7 0l2-2a2.6 2.6 0 00-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 00-3.7 0l-2 2a2.6 2.6 0 003.7 3.7l.9-.9" />,
  copy: <path d="M5.5 5.5h7.5V13H5.5zM3 10.5V3h7.5" />,
  duplicate: <path d="M5.5 5.5h7.5V13H5.5zM3 10.5V3h7.5M9.25 7.5v3.5M7.5 9.25H11" />,
  move: <path d="M3 4.5h6.5a3 3 0 013 3V13M9.5 10.5l3 3 3-3" />,
  arrowUpRight: <path d="M5 11l6-6M6 5h5v5" />,
  arrowRight: <path d="M3 8h10M9 4l4 4-4 4" />,
  restore: <path d="M3.5 7.5A4.5 4.5 0 118 12.5M3.5 4v3.5H7" />,
  sidebar: <path d="M2.5 3h11v10h-11zM6.5 3v10" />,
  smile: <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM5.6 9.4a2.8 2.8 0 004.8 0M6 6.5h.01M10 6.5h.01" />,
  image: <path d="M2.5 3h11v10h-11zM2.5 10.5l3-3 3 3 2-2 3 3M10.5 6.2h.01" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3 8.5l3 3 7-7" />,
  text: <path d="M3.5 4V3h9v1M8 3v10M6.5 13h3" />,
  h1: <path d="M2.5 3.5v9M8 3.5v9M2.5 8H8M11 6l2-1.5v8" />,
  h2: <path d="M2 3.5v9M7.5 3.5v9M2 8h5.5M10 6.2a1.8 1.8 0 013.5.6c0 1.5-3.5 3.2-3.5 5.7h3.7" />,
  h3: <path d="M2 3.5v9M7.5 3.5v9M2 8h5.5M10 5h3.3l-1.8 2.6a1.9 1.9 0 11-1.6 3.4" />,
  bulleted: <path d="M6.5 4.5H14M6.5 8H14M6.5 11.5H14M3 4.5h.01M3 8h.01M3 11.5h.01" strokeWidth="1.6" />,
  numbered: <path d="M6.5 4.5H14M6.5 8H14M6.5 11.5H14M2.5 3.5l1-.5v3M2.3 9.4a.9.9 0 011.7.4c0 .7-1.6 1.2-1.6 2.2H4" />,
  todo: <path d="M3 3h10v10H3zM5.5 8l2 2 3.5-3.5" />,
  toggle: <path d="M4.5 3.5l6 4.5-6 4.5z" fill="currentColor" stroke="none" />,
  toggleList: <path d="M2.5 3l3.5 2.5L2.5 8zM8 5.5h6M8 11h6" />,
  quote: <path d="M3.5 3v10M6.5 5h7M6.5 8h7M6.5 11h4.5" />,
  callout: <path d="M2.5 3h11v10h-11zM5.5 6.5h.01M7.5 6.5h4M5.5 9.5h.01M7.5 9.5h4" />,
  divider: <path d="M2 8h12M4 4.5h8M4 11.5h8" strokeOpacity="0.9" />,
  code: <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5M9 3L7 13" />,
  table: <path d="M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.8h11M6.3 3v10M10 3v10" />,
  video: <path d="M2.5 4h8v8h-8zM10.5 7l3-2v6l-3-2" />,
  audio: <path d="M6 11.5V3.5l7-1.5v8M6 11.5a1.8 1.8 0 11-3.6 0 1.8 1.8 0 013.6 0zM13 10a1.8 1.8 0 11-3.6 0 1.8 1.8 0 013.6 0z" />,
  file: <path d="M10 5.5L6 9.5a1.4 1.4 0 002 2l4.5-4.5a2.8 2.8 0 00-4-4L4 7.5a4.2 4.2 0 006 6l3.5-3.5" />,
  bookmark: <path d="M4 2.5h8v11L8 10.5l-4 3z" />,
  embed: <path d="M2.5 3h11v10h-11zM6 7L4.5 8.5 6 10M10 7l1.5 1.5L10 10M8.8 6.5l-1.6 4.5" />,
  equation: <path d="M12 3H4l4 5-4 5h8" />,
  mermaid: <path d="M2.5 2.5h4v3h-4zM9.5 10.5h4v3h-4zM2.5 10.5h4v3h-4zM4.5 5.5v5M4.5 8h7v2.5" />,
  toc: <path d="M2.5 4H11M4.5 8H13M4.5 12H13M2.5 8h.01M2.5 12h.01" />,
  breadcrumb: <path d="M2 8h2.5M6.5 6l2 2-2 2M10.5 8H14" />,
  columns: <path d="M2.5 3h4.5v10H2.5zM9 3h4.5v10H9z" />,
  database: <path d="M2.5 3h11v10h-11zM2.5 6.5h11M6.3 6.5V13" />,
  board: <path d="M2.5 3h3v7h-3zM6.5 3h3v10h-3zM10.5 3h3v5h-3z" />,
  gallery: <path d="M2.5 3h5v4.5h-5zM8.5 3h5v4.5h-5zM2.5 8.5h5V13h-5zM8.5 8.5h5V13h-5z" />,
  list: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />,
  calendar: <path d="M2.5 3.5h11V13h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3" />,
  timeline: <path d="M2.5 4h6M5 8h7.5M3.5 12h5" strokeWidth="2" />,
  at: <path d="M10.5 8a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zM10.5 8v1a1.75 1.75 0 003.5 0V8a6 6 0 10-2.3 4.7" />,
  date: <path d="M2.5 3.5h11V13h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3M5 9h1M7.5 9h1M10 9h1M5 11h1M7.5 11h1" />,
  person: <path d="M8 8a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM3 13.5a5 5 0 0110 0" />,
  people: <path d="M6 7.5a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4zM1.8 13a4.2 4.2 0 018.4 0M10.5 3.3a2.2 2.2 0 010 4.2M12 9.2a4.2 4.2 0 012.2 3.8" />,
  bold: <path d="M4.5 3h4a2.5 2.5 0 010 5h-4zM4.5 8h4.8a2.5 2.5 0 010 5H4.5z" strokeWidth="1.8" />,
  italic: <path d="M9.5 3H12M4 13h2.5M10.5 3l-4.5 10" />,
  underline: <path d="M4.5 2.5V7a3.5 3.5 0 007 0V2.5M3.5 13.5h9" />,
  strike: <path d="M2.5 8h11M10.8 5a2.8 2.3 0 00-2.8-1.8c-1.6 0-2.8.8-2.8 2.1M5 11a3 2.4 0 003 2c1.7 0 3-.9 3-2.3" />,
  color: <path d="M4 12l4-9 4 9M5.5 9h5" />,
  undo: <path d="M4.5 6.5h6a3 3 0 010 6H8M6.5 4L4 6.5 6.5 9" />,
  export: <path d="M8 10V2.5M5 5.5l3-3 3 3M3 9.5V13.5h10V9.5" />,
  import: <path d="M8 2.5V10M5 7l3 3 3-3M3 9.5V13.5h10V9.5" />,
  fullWidth: <path d="M2 8h12M4.5 5.5L2 8l2.5 2.5M11.5 5.5L14 8l-2.5 2.5" />,
  font: <path d="M2.5 13l3.5-9 3.5 9M3.8 10h4.4M11 8.2a1.8 1.8 0 113.2 1.1V13M14.2 11.2c-1.8-.3-3.2.2-3.2 1.1 0 .8 1.4 1 3.2.4" />,
  edit: <path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z" />,
  compose: <path d="M10.5 3l2.5 2.5L6 12.5H3.5V10z" />,
  globe: <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM2 8h12M8 2c1.7 1.8 2.5 3.8 2.5 6S9.7 12.2 8 14C6.3 12.2 5.5 10.2 5.5 8S6.3 3.8 8 2z" />,
  folder: <path d="M2 4h4l1.5 1.5H14V13H2z" />,
  inbox: <path d="M2.5 9l1.8-6h7.4l1.8 6V13h-11zM2.5 9h3l1 1.5h3l1-1.5h3" />,
  sparkle: <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2" />,
  shuffle: <path d="M2 4.5h2.5L10 11.5h4M2 11.5h2.5L6.5 9M9.5 7l.5-.6c.4-.5.9-.9 1.5-.9H14M12.5 3.5L14 5l-1.5 1.5M12.5 10L14 11.5 12.5 13" />,
  upload: <path d="M8 10.5V3M5 6l3-3 3 3M3 13h10" />,
  reposition: <path d="M8 2v12M2 8h12M5.5 4.5L8 2l2.5 2.5M5.5 11.5L8 14l2.5-2.5M4.5 5.5L2 8l2.5 2.5M11.5 5.5L14 8l-2.5 2.5" />,
  enter: <path d="M13 3.5v4a2 2 0 01-2 2H3.5M6 7l-2.5 2.5L6 12" />,
  wrap: <path d="M2.5 4h11M2.5 8h9a2 2 0 010 4H8.5M10 10.5L8.5 12l1.5 1.5M2.5 12H6" />,
  reply: <path d="M6.5 4L3 7.5 6.5 11M3 7.5h6.5a3.5 3.5 0 013.5 3.5v1" />,
  resolve: <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM5.3 8.2l1.9 1.9 3.6-3.8" />,
  synced: <path d="M3.5 7.5A4.5 4.5 0 0112 5.8M12.5 8.5A4.5 4.5 0 014 10.2M12 2.8v3h-3M4 13.2v-3h3" />,
  turn: <path d="M3 6h8.5L9 3.5M13 10H4.5L7 12.5" />,
  alignLeft: <path d="M2.5 4h11M2.5 8h7M2.5 12h9" />,
  chart: <path d="M2.5 13.5h11M4.5 11V7.5M7.5 11V4M10.5 11V6M13 11V9" />,
  share: <path d="M8 10V2.5M5.2 5.2L8 2.5l2.8 2.7M4.5 7H3.5v6.5h9V7h-1" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, style, className, strokeWidth = 1.35 }: { name: IconName | string; size?: number; style?: CSSProperties; className?: string; strokeWidth?: number }) {
  const support = useSymbolSupport();
  if (support === "checking") return <span className={className ? `n-icon ${className}` : "n-icon"} style={{ display: "inline-block", width: size, height: size, flex: "none", ...style }} aria-hidden="true" />;
  const drawnOnly = !(name in SYMBOLS) && name in paths;
  const symbol = drawnOnly ? null : symbolStyle(name, size, undefined, style);
  if (symbol) return <span className={className ? `n-icon n-symbol ${className}` : "n-icon n-symbol"} style={symbol} data-symbol={name} aria-hidden="true" />;
  return (
    <svg
      className={className ? `n-icon ${className}` : "n-icon"}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name] ?? paths.page}
    </svg>
  );
}

export function PageIcon({ icon, size = 16, fallback = "page", resolveFile }: { icon: string; size?: number; fallback?: IconName; resolveFile?: (ref: string) => string | null }) {
  if (!icon) return <Icon name={fallback} size={size} className="n-page-icon-fallback" />;
  if (icon.startsWith("file:")) {
    const url = resolveFile?.(icon);
    return url ? <img className="n-page-icon-img" src={url} width={size} height={size} alt="" /> : <Icon name={fallback} size={size} />;
  }
  return (
    <span className="n-emoji" style={{ fontSize: Math.round(size * 0.95), width: size, height: size, lineHeight: `${size}px` }}>
      {icon}
    </span>
  );
}
