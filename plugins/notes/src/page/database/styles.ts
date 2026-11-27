const sheets = new Map<string, string>();
let styleEl: HTMLStyleElement | null = null;

function flush() {
  if (typeof document === "undefined") return;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "notes-database-css";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = [...sheets.values()].join("\n");
}

export function registerCss(id: string, css: string) {
  if (sheets.get(id) === css) return;
  sheets.set(id, css);
  flush();
}

const colors = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"];

const tagColors = [
  `.db-tag.c-default { background: var(--n-chip, rgba(127,127,127,.14)); color: var(--n-text, CanvasText); }`,
  ...colors.map((c) => `.db-tag.c-${c} { background: var(--n-${c}-bg); color: var(--n-${c}); } .db-status-dot.c-${c} { background: var(--n-${c}); } .db-swatch.c-${c} { background: var(--n-${c}-bg); box-shadow: inset 0 0 0 1px var(--n-${c}); } .b-${c} { background: var(--n-${c}); stroke: var(--n-${c}); } .db-group-tint.c-${c} { background: var(--n-${c}-bg); }`),
  `.db-status-dot.c-default { background: var(--n-text-3); } .db-swatch.c-default { background: var(--n-chip); box-shadow: inset 0 0 0 1px var(--n-divider); } .b-default { background: var(--n-text-2); stroke: var(--n-text-2); } .db-group-tint.c-default { background: var(--n-group); }`,
].join("\n");

registerCss(
  "base",
  `
.db-root { font-family: var(--n-font, -apple-system, system-ui, sans-serif); color: var(--n-text, CanvasText); font-size: var(--n-t-body, 13px); line-height: 1.4; -webkit-font-smoothing: antialiased; }
.db-root *, .db-root *::before, .db-root *::after { box-sizing: border-box; }
.db-root button { font: inherit; color: inherit; }
.db-icon { flex: none; display: block; }
body.db-dragging, body.db-dragging * { cursor: grabbing !important; user-select: none !important; }
body.db-resizing, body.db-resizing * { cursor: col-resize !important; user-select: none !important; }

.db-pop { position: fixed; z-index: 1000; background: var(--n-glass); -webkit-backdrop-filter: var(--n-glass-filter); backdrop-filter: var(--n-glass-filter); border-radius: var(--n-r-panel, 12px); box-shadow: var(--n-glass-edge), var(--n-shadow); overflow: auto; min-width: 180px; font-size: var(--n-t-body, 13px); overscroll-behavior: contain; }
.db-menu { padding: 6px; outline: none; display: flex; flex-direction: column; gap: 0; }
.db-menu-pad { padding: 4px 4px 6px; }
.db-item { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 10px; border-radius: var(--n-r-row, 6px); cursor: default; user-select: none; white-space: nowrap; color: var(--n-text); font-size: var(--n-t-body, 13px); }
.db-item.is-active { background: var(--n-hover); }
.db-item:active { background: var(--n-pressed); }
.db-item.is-danger.is-active { color: var(--n-destructive); }
.db-item.is-disabled { opacity: .45; }
.db-item-icon { display: inline-flex; width: 20px; justify-content: center; color: var(--n-icon); flex: none; }
.db-item-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
.db-item-right { color: var(--n-text-2); font-size: var(--n-t-small, 12px); display: inline-flex; align-items: center; gap: 4px; }
.db-item-check { color: var(--n-text); }
.db-item-chevron { color: var(--n-text-3); }
.db-sep { height: 0.5px; background: var(--n-divider); margin: 5px 10px; flex: none; }
.db-menu-label { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px 4px; font-size: var(--n-t-caption, 11px); color: var(--n-text-2); font-weight: var(--n-w-semibold, 600); }
.db-empty-note { padding: 6px 10px; color: var(--n-text-3); font-size: var(--n-t-body, 13px); }

.db-input { width: 100%; height: 28px; padding: 0 8px; border-radius: var(--n-r-tile, 8px); border: 0; box-shadow: inset 0 0 0 1px var(--n-field-border); background: var(--n-field); color: var(--n-text); font: inherit; font-size: var(--n-t-body, 13px); outline: none; }
.db-input:focus { box-shadow: inset 0 0 0 1px var(--n-form-accent), 0 0 0 3px color-mix(in srgb, var(--n-form-accent) 30%, transparent); }
.db-input::placeholder { color: var(--n-placeholder); }
select.db-input { padding-right: 4px; }

.db-btn { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 8px; border-radius: var(--n-r-control, 4px); border: none; background: transparent; cursor: default; font-size: var(--n-t-body, 13px); white-space: nowrap; color: var(--n-text-2); }
.db-btn:hover { background: var(--n-tool-hover); color: var(--n-text); }
.db-btn:active { background: var(--n-tool-pressed); }
.db-btn.is-primary { background: var(--n-go); color: var(--n-on-go); font-weight: var(--n-w-medium, 500); border-radius: var(--n-r-tile, 8px); padding: 0 12px; }
.db-btn.is-primary:hover { background: var(--n-go-hover); color: var(--n-on-go); }
.db-btn.is-danger { color: var(--n-destructive); }
.db-btn:disabled { opacity: .45; }
.db-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: var(--n-r-control, 4px); border: none; background: transparent; color: var(--n-icon); cursor: default; padding: 0; flex: none; }
.db-icon-btn:hover { background: var(--n-tool-hover); }
.db-icon-btn:active { background: var(--n-tool-pressed); }
.db-icon-btn.is-active { color: var(--n-text); background: var(--n-tool-pressed); }
.db-link-btn { display: inline-flex; align-items: center; gap: 3px; flex: none; white-space: nowrap; border: none; background: none; color: var(--n-text-2); font-size: var(--n-t-small, 12px); line-height: 1.3; padding: 2px 6px; border-radius: var(--n-r-control, 4px); cursor: default; }
.db-link-btn:hover { background: var(--n-tool-hover); }

.db-toggle { width: 32px; height: 18px; border-radius: 9px; border: none; padding: 0; background: var(--ardia-switch-off, var(--n-chip)); position: relative; flex: none; cursor: default; transition: background var(--n-base, 160ms) var(--n-ease-out); }
.db-toggle span { position: absolute; top: 1.5px; left: 1.5px; width: 15px; height: 15px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 0.5px var(--n-knob-border), 0 1px 2px rgba(0,0,0,.2); transition: transform var(--n-base, 160ms) var(--n-ease-out); }
.db-toggle.is-on { background: var(--n-form-accent); }
.db-toggle.is-on span { transform: translateX(14px); }
.db-seg { display: inline-flex; background: var(--n-control); box-shadow: inset 0 0 0 1px var(--n-control-border); border-radius: var(--n-r-control, 4px); padding: 1px; gap: 0; }
.db-seg button { border: none; background: transparent; border-radius: max(0px, calc(var(--n-r-control, 4px) - 1px)); height: 20px; padding: 0 8px; font-size: var(--n-t-small, 12px); cursor: default; color: var(--n-text); }
.db-seg button.is-on { background: var(--n-form-accent); color: var(--n-on-accent); }

.db-tag { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: var(--n-r-control, 4px); font-size: var(--n-t-small, 12px); font-weight: var(--n-w-medium, 500); line-height: 20px; white-space: nowrap; max-width: 100%; min-width: 0; flex: none; }
.db-tag-text { overflow: hidden; text-overflow: ellipsis; }
.db-tag-x { display: inline-flex; opacity: .6; margin-right: -2px; border-radius: 2px; }
.db-tag-x:hover { opacity: 1; }
.db-status-tag { border-radius: 10px; padding: 0 8px 0 7px; }
.db-status-tag .db-tag-text { display: inline-flex; align-items: center; gap: 5px; }
.db-status-dot { width: 8px; height: 8px; border-radius: 4px; flex: none; }
.db-swatch { width: 16px; height: 16px; border-radius: var(--n-r-control, 4px); display: inline-block; }
${tagColors}
.db-tags { display: flex; gap: 4px; overflow: hidden; align-items: center; min-width: 0; }
.db-tags.is-wrap { flex-wrap: wrap; }
.db-avatar { display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: #fff; font-weight: 600; flex: none; line-height: 1; }
.db-person { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.db-person-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.db-people { display: flex; gap: 8px; align-items: center; min-width: 0; overflow: hidden; }
.db-people.is-wrap { flex-wrap: wrap; }
.db-check { width: 14px; height: 14px; border-radius: var(--n-r-control, 4px); background: var(--n-control); box-shadow: inset 0 0 0 1px var(--n-text-3); display: inline-flex; align-items: center; justify-content: center; flex: none; color: var(--n-on-accent); }
.db-check.is-on { background: var(--n-form-accent); box-shadow: none; }
.db-link { text-decoration: underline; text-decoration-color: var(--n-text-3); text-underline-offset: 2px; }
.db-num { display: block; text-align: right; font-variant-numeric: tabular-nums; width: 100%; }
.db-num-left { font-variant-numeric: tabular-nums; }
.db-num-bar { display: flex; align-items: center; gap: 8px; width: 100%; }
.db-num-text { font-variant-numeric: tabular-nums; flex: none; }
.db-bar { flex: 1; height: 4px; border-radius: 2px; background: var(--n-chip); overflow: hidden; min-width: 30px; }
.db-bar-fill { display: block; height: 100%; border-radius: 2px; }
.db-num-ring { display: inline-flex; align-items: center; gap: 6px; }
.db-ring-track { stroke: var(--n-chip); }
.db-ring-fill { background: none !important; }
.db-error { color: var(--n-destructive); font-size: 12px; }
.db-untitled { color: var(--n-text-3); }
.db-row-icon { line-height: 1; flex: none; }
.db-row-icon-img { border-radius: 3px; object-fit: cover; flex: none; }
.db-title-value { display: flex; align-items: center; gap: 6px; font-weight: 500; min-width: 0; }
.db-title-value > span:last-child { overflow: hidden; text-overflow: ellipsis; }
.db-cell-value.is-wrap .db-title-value > span:last-child, .db-title-value.is-wrap > span:last-child { white-space: normal; }
.db-files { display: flex; gap: 4px; align-items: center; overflow: hidden; }
.db-file-thumb { height: 22px; max-width: 60px; border-radius: 3px; object-fit: cover; }
.db-file-chip { font-size: var(--n-t-small, 12px); padding: 0 7px; border-radius: var(--n-r-control, 4px); background: var(--n-chip); white-space: nowrap; height: 20px; line-height: 20px; }
.db-relations { display: flex; gap: 8px; overflow: hidden; align-items: center; }
.db-relations.is-wrap { flex-wrap: wrap; }
.db-relation-chip { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; text-decoration: underline; text-decoration-color: var(--n-text-3); text-underline-offset: 2px; }
.db-relation-chip .db-icon { color: var(--n-icon); }

.db-text-editor { overflow: hidden; border-radius: var(--n-r-control, 4px); min-width: 0; }
.db-textarea { display: block; width: 100%; min-height: 33px; padding: 7px 8px; border: none; outline: none; resize: none; background: transparent; color: var(--n-text); font: inherit; font-size: var(--n-t-body, 13px); line-height: 1.4; }
.db-textarea.is-num { text-align: right; font-variant-numeric: tabular-nums; }
.db-open-link { display: flex; align-items: center; gap: 6px; width: 100%; height: 32px; border: none; border-top: 0.5px solid var(--n-divider); background: transparent; color: var(--n-text-2); padding: 0 10px; font-size: var(--n-t-body, 13px); cursor: default; }
.db-open-link:hover { background: var(--n-hover); }

.db-option-head { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; padding: 6px 10px; min-height: 36px; background: var(--n-raised); border-bottom: 0.5px solid var(--n-divider); }
.db-option-search { flex: 1; min-width: 60px; border: none; outline: none; background: transparent; font: inherit; font-size: var(--n-t-body, 13px); color: var(--n-text); height: 22px; }
.db-option-search::placeholder { color: var(--n-placeholder); }
.db-option-list { max-height: 320px; overflow: auto; }
.db-option-row { padding-left: 4px; }
.db-drag-handle { display: inline-flex; color: var(--n-text-3); width: 14px; justify-content: center; opacity: 0; }
.db-option-row.is-active .db-drag-handle { opacity: 1; }
.db-option-more { opacity: 0; width: 22px; height: 22px; }
.db-option-row.is-active .db-option-more { opacity: 1; }
.db-status-group { padding-top: 8px; }

.db-date-editor { display: flex; flex-direction: column; }
.db-date-inputs { padding: 8px 8px 4px; display: flex; flex-direction: column; gap: 6px; }
.db-date-field { display: flex; gap: 4px; }
.db-date-field.is-focus .db-input:first-child { border-color: var(--n-form-accent); }
.db-time { width: 82px; flex: none; }
.db-month-head { display: flex; align-items: center; gap: 2px; padding: 6px 8px 2px 12px; }
.db-month-title { flex: 1; font-weight: var(--n-w-semibold, 600); font-size: var(--n-t-body, 13px); }
.db-month { display: grid; grid-template-columns: repeat(7, 1fr); padding: 2px 8px 6px; gap: 1px; }
.db-month-wd { text-align: center; font-size: var(--n-t-caption, 11px); color: var(--n-text-3); height: 24px; line-height: 24px; }
.db-month-day { height: 28px; border: none; background: transparent; border-radius: var(--n-r-control, 4px); font-size: var(--n-t-body, 13px); cursor: default; color: var(--n-text); font-variant-numeric: tabular-nums; }
.db-month-day:hover { background: var(--n-tool-hover); }
.db-month-day.is-out { color: var(--n-text-3); }
.db-month-day.is-today { color: var(--n-destructive); font-weight: var(--n-w-semibold, 600); }
.db-month-day.is-range { background: color-mix(in srgb, var(--n-form-accent) 14%, transparent); border-radius: 0; }
.db-month-day.is-sel { background: var(--n-form-accent); color: var(--n-on-accent); border-radius: var(--n-r-control, 4px); }

.db-ghost { position: fixed; z-index: 2000; pointer-events: none; opacity: .92; transform: rotate(1.2deg); box-shadow: var(--n-glass-edge), var(--n-shadow-sheet); border-radius: var(--n-r-tile, 8px); background: var(--n-glass); -webkit-backdrop-filter: var(--n-glass-filter); backdrop-filter: var(--n-glass-filter); }
.db-drop-line { position: absolute; background: var(--n-form-accent); border-radius: 2px; pointer-events: none; z-index: 5; }
`,
);
