export const READER_SIZES = [16, 18, 20, 23, 26] as const;
export const READER_SIZE_NAMES = ["small", "medium", "large", "larger", "largest"] as const;
export const READER_FONTS = ["serif", "sans"] as const;

export const READER_FONT_STACKS = {
  serif: `ui-serif, "New York", Charter, "Iowan Old Style", Georgia, serif`,
  sans: `-apple-system, BlinkMacSystemFont, system-ui, "Helvetica Neue", sans-serif`,
  mono: `ui-monospace, "SF Mono", Menlo, monospace`,
};

const LIGHT = {
  ground: "#FFFFFF",
  ink: "#1F1F1F",
  quiet: "#8A8A8E",
  aside: "#545458",
  rule: "#E6E6E6",
  code: "#F4F4F5",
  wash: "rgba(0, 0, 0, 0.06)",
  bar: "rgba(255, 255, 255, 0.92)",
  picture: "none",
};

const DARK = {
  ground: "#1C1C1E",
  ink: "#E2E2E4",
  quiet: "#8E8E93",
  aside: "#ABABB0",
  rule: "#3A3A3C",
  code: "#2C2C2E",
  wash: "rgba(255, 255, 255, 0.08)",
  bar: "rgba(44, 44, 46, 0.92)",
  picture: "brightness(0.92)",
};

const roles = (palette: typeof LIGHT) =>
  `--ground:${palette.ground};--ink:${palette.ink};--quiet:${palette.quiet};--aside:${palette.aside};--rule:${palette.rule};--code:${palette.code};--wash:${palette.wash};--bar:${palette.bar};--picture:${palette.picture};`;

const BAR_FADE = "0.15s";

export const READER_GROUND = { light: LIGHT.ground, dark: DARK.ground } as const;

export const READER_SHEET = [
  ":host{all:initial !important;display:block !important;position:fixed !important;inset:0 !important;width:auto !important;height:auto !important;",
  "max-width:none !important;max-height:none !important;margin:0 !important;padding:0 !important;border:0 !important;overflow:hidden !important;",
  "z-index:2147483647 !important;background:none !important;contain:strict !important;visibility:visible !important;opacity:1 !important;}",
  `.scroller{position:absolute;inset:0;overflow-x:hidden;overflow-y:auto;outline:none;background:var(--ground);color:var(--ink);color-scheme:light;${roles(LIGHT)}`,
  "-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;}",
  `.scroller[data-theme=dark]{color-scheme:dark;${roles(DARK)}}`,
  `.column{box-sizing:content-box;max-width:65ch;margin:0 auto;padding:72px 28px 160px;font-family:var(--font);font-size:var(--size);line-height:1.65;overflow-wrap:break-word;}`,
  `.masthead{margin:0 0 2.2em;}`,
  `.source{font:500 12px/1.4 ${READER_FONT_STACKS.sans};color:var(--quiet);text-transform:uppercase;letter-spacing:.06em;margin:0 0 14px;}`,
  `.headline{font-family:var(--font);font-size:1.8em;font-weight:700;line-height:1.18;letter-spacing:-0.01em;margin:0 0 12px;}`,
  `.credit{font:400 14px/1.5 ${READER_FONT_STACKS.sans};color:var(--aside);margin:0;}`,
  ".body p{margin:0 0 1.2em;}",
  ".body h1,.body h2,.body h3,.body h4,.body h5,.body h6{font-family:var(--font);line-height:1.3;margin:1.8em 0 .6em;}",
  ".body h1{font-size:1.45em;}.body h2{font-size:1.3em;}.body h3{font-size:1.15em;}.body h4,.body h5,.body h6{font-size:1em;}",
  ".body a{color:inherit;text-decoration:underline;text-decoration-color:var(--quiet);text-underline-offset:3px;}",
  ".body a:hover{text-decoration-color:var(--ink);}",
  ".body img,.body video,.body iframe,.body svg{max-width:100%;}",
  ".body img,.body video{height:auto;display:block;margin:1.5em auto;border-radius:6px;filter:var(--picture);}",
  ".body iframe{display:block;width:100%;aspect-ratio:16/9;height:auto;border:0;margin:1.5em 0;}",
  ".body figure{margin:1.8em 0;}",
  ".body figure img,.body figure video{margin:0 auto;}",
  `.body figcaption{font:400 13px/1.5 ${READER_FONT_STACKS.sans};color:var(--quiet);margin-top:.6em;}`,
  ".body blockquote{margin:1.5em 0;padding:0 0 0 1.1em;border-left:3px solid var(--rule);color:var(--aside);}",
  ".body ul,.body ol{margin:0 0 1.2em;padding-left:1.4em;}",
  ".body ul{list-style:disc outside;}.body ol{list-style:decimal outside;}.body li{margin:.3em 0;}",
  ".body li>ul,.body li>ol{margin-bottom:0;}",
  `.body pre,.body code,.body kbd,.body samp{font-family:${READER_FONT_STACKS.mono};font-size:.82em;}`,
  ".body pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow:auto;line-height:1.5;}",
  ".body :not(pre)>code{background:var(--code);padding:.1em .35em;border-radius:4px;}",
  ".body hr{border:0;border-top:1px solid var(--rule);margin:2.4em 0;}",
  `.body table{border-collapse:collapse;display:block;overflow-x:auto;max-width:100%;font:400 15px/1.5 ${READER_FONT_STACKS.sans};margin:0 0 1.2em;}`,
  ".body th,.body td{border-bottom:1px solid var(--rule);padding:8px 12px 8px 0;text-align:left;vertical-align:top;}",
  ".body th{font-weight:600;}",
  ".body sup,.body sub{line-height:0;}",
  ".body details{margin:0 0 1.2em;}.body summary{cursor:pointer;}",
  `.bar{position:absolute;top:12px;right:18px;z-index:1;display:flex;gap:2px;padding:3px;border-radius:999px;background:var(--bar);border:1px solid var(--rule);`,
  `opacity:.55;transition:opacity ${BAR_FADE} ease;font:500 12px/1 ${READER_FONT_STACKS.sans};${roles(LIGHT)}color-scheme:light;}`,
  `.bar[data-theme=dark]{${roles(DARK)}color-scheme:dark;}`,
  ".bar:hover,.bar:focus-within{opacity:1;}",
  ".bar button{all:unset;box-sizing:border-box;min-width:28px;height:24px;padding:0 7px;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;color:var(--aside);cursor:default;}",
  ".bar button:hover{background:var(--wash);color:var(--ink);}",
  ".bar button:disabled{opacity:.35;background:none;}",
  ".bar button:focus-visible{outline:2px solid var(--quiet);outline-offset:-2px;}",
  ".bar .small{font-size:11px;}.bar .large{font-size:15px;}",
  `.bar .serif{font-family:${READER_FONT_STACKS.serif};font-size:14px;}.bar .sans{font-family:${READER_FONT_STACKS.sans};font-size:13px;}`,
].join("");
