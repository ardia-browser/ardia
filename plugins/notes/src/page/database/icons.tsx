import type { CSSProperties, ReactNode } from "react";
import type { PropType, ViewType } from "../../shared/database";
import { symbolStyle, useSymbolSupport } from "../ui/symbols";

const paths: Record<string, ReactNode> = {
  plus: <path d="M8 3v10M3 8h10" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  form: <path d="M3.5 2.5h9v11h-9zM5.5 5.5h5M5.5 8h5M5.5 10.5h3" />,
  chevronDown: <path d="M4 6.5l4 4 4-4" />,
  chevronUp: <path d="M4 9.5l4-4 4 4" />,
  chevronRight: <path d="M6.5 4l4 4-4 4" />,
  chevronLeft: <path d="M9.5 4l-4 4 4 4" />,
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
  filter: <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />,
  sort: <path d="M5 3v10M2.5 10.5L5 13l2.5-2.5M11 13V3M8.5 5.5L11 3l2.5 2.5" />,
  arrowUp: <path d="M8 13V3M4 7l4-4 4 4" />,
  arrowDown: <path d="M8 3v10M4 9l4 4 4-4" />,
  arrowLeft: <path d="M13 8H3M7 4L3 8l4 4" />,
  arrowRight: <path d="M3 8h10M9 4l4 4-4 4" />,
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />,
  copy: <path d="M5.5 5.5h7.5V13H5.5zM3 10.5V3h7.5" />,
  eye: <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 100-4 2 2 0 000 4z" />,
  eyeOff: <path d="M2 2l12 12M6.6 6.6a2 2 0 002.8 2.8M4.2 4.7C2.5 5.9 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.4-.4 3.4-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5.9-1.4 1.9" />,
  expand: <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />,
  sidePeek: <path d="M2.5 3h11v10h-11zM9 3v10" />,
  centerPeek: <path d="M2.5 3h11v10h-11zM5 5.5h6v5H5z" />,
  fullPage: <path d="M2.5 3h11v10h-11z" />,
  settings: <path d="M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" />,
  lock: <path d="M4 7.5h8V14H4zM5.5 7.5V5.2a2.5 2.5 0 015 0v2.3" />,
  unlock: <path d="M4 7.5h8V14H4zM5.5 7.5V5.2a2.5 2.5 0 014.9-.7" />,
  link: <path d="M6.8 9.2a2.6 2.6 0 003.7 0l2-2a2.6 2.6 0 00-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 00-3.7 0l-2 2a2.6 2.6 0 003.7 3.7l.9-.9" />,
  template: <path d="M3 2.5h10v11H3zM3 6h10M6.5 6v7.5" />,
  layout: <path d="M2.5 2.5h11v11h-11zM2.5 6.5h11M6.5 6.5v7" />,
  group: <path d="M2.5 3h11M2.5 6h7M4.5 9h9M4.5 12h7" />,
  wrap: <path d="M2.5 4h11M2.5 8h9a2 2 0 010 4H8M9.5 10.5L8 12l1.5 1.5M2.5 12h3" />,
  freeze: <path d="M8 1.5v13M2.5 4.8l11 6.4M2.5 11.2l11-6.4" />,
  calc: <path d="M3 3h10v10H3zM5.5 6h5M8 10.5V8.3M6.8 9.4h2.4" />,
  image: <path d="M2.5 3h11v10h-11zM2.5 11l3.5-3.5 3 3 2-2 2.5 2.5M10.5 6.2a.9.9 0 100-1.8.9.9 0 000 1.8z" />,
  upload: <path d="M8 10V2.5M5 5.5l3-3 3 3M3 9.5V13.5h10V9.5" />,
  page: <path d="M4 2h5.5L12.5 5v9H4zM9.5 2v3h3M6 8h4.5M6 10.5h4.5" />,
  database: <path d="M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.8h11M6.5 3v10" />,
  info: <path d="M8 14A6 6 0 108 2a6 6 0 000 14zM8 7.2V11M8 5v.2" />,
  edit: <path d="M10.5 2.5l3 3L6 13H3v-3z" />,
  text: <path d="M3 4h10M3 8h10M3 12h6" />,
  title: <path d="M3 4h10M3 8h10M3 12h6" />,
  number: <path d="M6 2.5L5 13.5M11 2.5l-1 11M2.5 5.5h11M2 10.5h11" />,
  select: <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM5.5 7l2.5 2.5L10.5 7" />,
  multi_select: <path d="M2.5 4h7M2.5 8h7M2.5 12h7M12 4h1.5M12 8h1.5M12 12h1.5" />,
  status: (
    <>
      <path d="M8 14A6 6 0 108 2a6 6 0 000 12z" strokeDasharray="2.2 1.6" />
      <path d="M8 11a3 3 0 000-6z" fill="currentColor" stroke="none" />
    </>
  ),
  date: <path d="M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3" />,
  person: <path d="M8 8a2.8 2.8 0 100-5.6A2.8 2.8 0 008 8zM2.8 14c.5-2.8 2.6-4.3 5.2-4.3s4.7 1.5 5.2 4.3" />,
  files: <path d="M12.5 7.5l-4.8 4.8a2.8 2.8 0 01-4-4l5.2-5.2a1.9 1.9 0 012.7 2.7l-5.2 5.2a1 1 0 01-1.4-1.4L9.5 5" />,
  checkbox: <path d="M2.5 2.5h11v11h-11zM5 8l2 2 4-4.5" />,
  url: <path d="M6.8 9.2a2.6 2.6 0 003.7 0l2-2a2.6 2.6 0 00-3.7-3.7l-.9.9M9.2 6.8a2.6 2.6 0 00-3.7 0l-2 2a2.6 2.6 0 003.7 3.7l.9-.9" />,
  email: <path d="M2 3.5h12v9H2zM2 4l6 5 6-5" />,
  phone: <path d="M4.5 2h2l1 3-1.5 1a8 8 0 004 4l1-1.5 3 1v2a1.5 1.5 0 01-1.5 1.5A11.5 11.5 0 013 3.5 1.5 1.5 0 014.5 2z" />,
  formula: <path d="M11.5 3H6.5L5 13M3.5 7.5h5M9 9l3.5 4M12.5 9L9 13" />,
  relation: <path d="M5 11l6-6M6.5 5H11v4.5" />,
  rollup: <path d="M8 2l5.5 3L8 8 2.5 5zM2.5 8L8 11l5.5-3M2.5 11L8 14l5.5-3" />,
  created_time: <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM8 4.8V8l2.2 1.4" />,
  edited_time: <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM8 4.8V8l2.2 1.4" />,
  created_by: <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM8 8a2 2 0 100-4 2 2 0 000 4zM4.2 12.2c.8-1.6 2.2-2.4 3.8-2.4s3 .8 3.8 2.4" />,
  edited_by: <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM8 8a2 2 0 100-4 2 2 0 000 4zM4.2 12.2c.8-1.6 2.2-2.4 3.8-2.4s3 .8 3.8 2.4" />,
  id: <path d="M3 3.5h10v9H3zM5.5 6v4M8 6h1.5a2 2 0 010 4H8z" />,
  table: <path d="M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.8h11M6.5 3v10" />,
  board: <path d="M2.5 3h3v10h-3zM6.5 3h3v6.5h-3zM10.5 3h3v8h-3z" />,
  list: <path d="M5.5 4h8M5.5 8h8M5.5 12h8M2.5 4h.5M2.5 8h.5M2.5 12h.5" />,
  gallery: <path d="M2.5 2.5h4.5V7H2.5zM9 2.5h4.5V7H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z" />,
  calendar: <path d="M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3M5 9h1M7.5 9h1M10 9h1M5 11.3h1M7.5 11.3h1" />,
  timeline: <path d="M2.5 3.5h6M5 8h7M3.5 12.5h5.5" />,
  chart: <path d="M2.5 13.5h11M4 13V8.5M7 13V4.5M10 13V7M13 13V10" />,
  today: <path d="M2.5 3.5h11v10h-11zM2.5 6.5h11M8 8.5v3" />,
  zoom: <path d="M7 12a5 5 0 100-10 5 5 0 000 10zM10.6 10.6L14 14M5 7h4" />,
};

export function Icon({ name, size = 16, style, className, strokeWidth = 1.35 }: { name: string; size?: number; style?: CSSProperties; className?: string; strokeWidth?: number }) {
  const support = useSymbolSupport();
  if (support === "checking") return <span className={className ? `db-icon ${className}` : "db-icon"} style={{ display: "inline-block", width: size, height: size, flex: "none", ...style }} aria-hidden="true" />;
  const symbol = symbolStyle(name, size, undefined, style);
  if (symbol) return <span className={`db-icon n-symbol ${className ?? ""}`} style={symbol} data-symbol={name} aria-hidden="true" />;
  return (
    <svg className={`db-icon ${className ?? ""}`} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style} aria-hidden="true">
      {paths[name] ?? paths.page}
    </svg>
  );
}

export const TypeIcon = ({ type, size = 16, className }: { type: PropType; size?: number; className?: string }) => <Icon name={type} size={size} className={className} />;
export const ViewIcon = ({ type, size = 16 }: { type: ViewType; size?: number }) => <Icon name={type} size={size} />;
