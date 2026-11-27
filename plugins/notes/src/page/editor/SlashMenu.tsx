import { insertOrUpdateBlockForSlashMenu } from "@blocknote/core";
import { SourceBlockWithPreviewExtension, SuggestionMenu as SuggestionMenuExtension } from "@blocknote/core/extensions";
import type { SuggestionMenuProps } from "@blocknote/react";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Icon, type IconName } from "../ui/icons";
import { NOTION_COLORS, TEXT_KINDS, colorLabel } from "./blockTypes";
import type { NotesEnv } from "./env";
import { turnInto } from "./ops";
import { fadeBlockIn } from "./blockMotion";
import type { NotesEditor } from "./schema";
import { exitRef, MOTION, retireOtherMenus, useFlip } from "../ui/motion";

const menuExit = exitRef<HTMLDivElement>("is-leaving");

export type SlashItem = {
  key: string;
  title: string;
  aliases: string[];
  group: string;
  icon: IconName;
  hint?: string;
  description?: string;
  swatch?: string;
  onItemClick: () => void;
};

const GROUPS = ["Basic blocks", "Media", "Database", "Advanced blocks", "Inline", "Embeds", "Turn into", "Colors"];

export function fuzzyScore(query: string, item: { title: string; aliases?: string[] }): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const fields = [item.title.toLowerCase(), ...(item.aliases ?? []).map((a) => a.toLowerCase())];
  let best = 0;
  for (const [i, field] of fields.entries()) {
    const weight = i === 0 ? 1 : 0.8;
    if (field === q) best = Math.max(best, 100 * weight);
    else if (field.startsWith(q)) best = Math.max(best, 80 * weight);
    else if (field.split(/[\s\-–]+/).some((w) => w.startsWith(q))) best = Math.max(best, 60 * weight);
    else if (field.includes(q)) best = Math.max(best, 40 * weight);
    else {
      let at = 0;
      for (const ch of q.replace(/\s+/g, "")) {
        at = field.indexOf(ch, at);
        if (at < 0) break;
        at++;
      }
      if (at > 0) best = Math.max(best, 10 * weight);
    }
  }
  return best;
}

function openSuggestion(editor: NotesEditor, trigger: string) {
  setTimeout(() => editor.getExtension(SuggestionMenuExtension)?.openSuggestionMenu(trigger), 0);
}

export function openSourcePopup(editor: NotesEditor, id: string) {
  const ext = editor.getExtension(SourceBlockWithPreviewExtension);
  if (!ext) return;
  ext.store.setState((state) => ({ ...state, popupOpen: id, selected: id }));
  editor.setTextCursorPosition(id, "end");
  editor.focus();
}

export function todayIso(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function buildSlashItems(editor: NotesEditor, env: NotesEnv): SlashItem[] {
  const current = () => editor.getTextCursorPosition().block;
  const put = (block: Record<string, unknown>) => {
    const inserted = insertOrUpdateBlockForSlashMenu(editor, block as never);
    fadeBlockIn(editor, inserted.id);
    return inserted;
  };
  const items: SlashItem[] = [];
  const kindItem = (key: string, group = "Basic blocks"): SlashItem | null => {
    const kind = TEXT_KINDS.find((k) => k.key === key);
    if (!kind) return null;
    return {
      key: kind.key,
      title: kind.title,
      aliases: kind.aliases,
      group,
      icon: kind.icon,
      hint: kind.hint,
      description: kind.description,
      onItemClick: () => {
        const block = put({ type: kind.type, props: kind.props ?? {} });
        if (kind.type !== "codeBlock") editor.setTextCursorPosition(block, "end");
      },
    };
  };
  const push = (item: SlashItem | null) => item && items.push(item);

  push(kindItem("text"));
  push({
    key: "page",
    title: "Page",
    aliases: ["subpage", "new page", "doc"],
    group: "Basic blocks",
    icon: "page",
    description: "Embed a sub-page inside this page.",
    onItemClick: () => {
      void env.createChildPage().then((id) => {
        put({ type: "subpage", props: { pageId: id } });
        env.openPage(id);
      });
    },
  });
  push(kindItem("todo"));
  push(kindItem("h1"));
  push(kindItem("h2"));
  push(kindItem("h3"));
  push({
    key: "table",
    title: "Table",
    aliases: ["simple table", "grid", "spreadsheet"],
    group: "Basic blocks",
    icon: "table",
    description: "Add a simple table to this page.",
    onItemClick: () =>
      put({
        type: "table",
        content: { type: "tableContent", headerRows: 1, rows: [{ cells: ["", "", ""] }, { cells: ["", "", ""] }, { cells: ["", "", ""] }] },
      }),
  });
  push(kindItem("bullet"));
  push(kindItem("numbered"));
  push(kindItem("toggle"));
  push(kindItem("quote"));
  push({ key: "divider", title: "Divider", aliases: ["hr", "line", "separator", "---"], group: "Basic blocks", icon: "divider", hint: "---", description: "Visually divide blocks.", onItemClick: () => {
    const block = put({ type: "divider" });
    const next = editor.getNextBlock(block);
    if (next) editor.setTextCursorPosition(next, "start");
    else editor.setTextCursorPosition(editor.insertBlocks([{ type: "paragraph" }], block, "after")[0]!, "start");
  } });
  push({ key: "linkToPage", title: "Link to page", aliases: ["link page", "page link", "reference"], group: "Basic blocks", icon: "arrowUpRight", description: "Link to an existing page.", onItemClick: () => put({ type: "linkToPage" }) });
  push(kindItem("callout"));
  push(kindItem("th1"));
  push(kindItem("th2"));
  push(kindItem("th3"));

  const media: [string, string, IconName, string[], string][] = [
    ["image", "Image", "image", ["picture", "photo", "img"], "Upload or embed an image."],
    ["video", "Video", "video", ["movie", "clip"], "Upload or embed a video."],
    ["audio", "Audio", "audio", ["sound", "music", "mp3"], "Upload or embed audio."],
  ];
  for (const [type, title, icon, aliases, description] of media) push({ key: type, title, aliases, group: "Media", icon, description, onItemClick: () => put({ type }) });
  push({ ...kindItem("code", "Media")!, key: "code" });
  push({ key: "file", title: "File", aliases: ["attachment", "upload", "pdf"], group: "Media", icon: "file", description: "Upload or link to a file.", onItemClick: () => put({ type: "file" }) });
  push({ key: "bookmark", title: "Web bookmark", aliases: ["link", "url", "bookmark"], group: "Media", icon: "bookmark", description: "Save a link as a visual bookmark.", onItemClick: () => put({ type: "bookmark" }) });

  const inlineDatabase = (view: string) => () => {
    const block = put({ type: "database", props: { workspace: env.workspace, database: "", view } });
    const next = editor.getNextBlock(block.id);
    if (next && next.type === "paragraph") editor.setTextCursorPosition(next.id, "start");
    else {
      const [inserted] = editor.insertBlocks([{ type: "paragraph" }] as never, block.id, "after");
      if (inserted) editor.setTextCursorPosition(inserted, "start");
    }
  };
  const views: [string, string, IconName, string[]][] = [
    ["table", "Table view", "table", ["database table", "spreadsheet"]],
    ["board", "Board view", "board", ["kanban"]],
    ["gallery", "Gallery view", "gallery", ["cards", "grid"]],
    ["list", "List view", "list", []],
    ["calendar", "Calendar view", "calendar", ["dates", "schedule"]],
    ["timeline", "Timeline view", "timeline", ["gantt", "roadmap"]],
    ["chart", "Chart view", "chart", ["graph", "bar chart", "pie"]],
  ];
  for (const [view, title, icon, aliases] of views) push({ key: `db-${view}`, title, aliases: [...aliases, "database"], group: "Database", icon, description: `Create a database with a ${view} view.`, onItemClick: inlineDatabase(view) });
  push({ key: "db-inline", title: "Database – Inline", aliases: ["database inline", "db"], group: "Database", icon: "database", description: "Add an inline database to this page.", onItemClick: inlineDatabase("table") });
  push({
    key: "db-full",
    title: "Database – Full page",
    aliases: ["database full page", "new database"],
    group: "Database",
    icon: "database",
    description: "Add a database as a sub-page.",
    onItemClick: () => {
      void env.createChildPage({ kind: "database", title: "", props: { initialView: "table", inline: false } }).then((id) => {
        put({ type: "subpage", props: { pageId: id } });
        env.openPage(id);
      });
    },
  });
  push({ key: "db-linked", title: "Linked view of database", aliases: ["linked database", "link database", "view of database"], group: "Database", icon: "arrowUpRight", description: "Show a view of an existing database.", onItemClick: inlineDatabase("link") });

  push({ key: "toc", title: "Table of contents", aliases: ["toc", "outline", "contents"], group: "Advanced blocks", icon: "toc", description: "Show an outline of this page.", onItemClick: () => put({ type: "toc" }) });
  push({ key: "equation", title: "Block equation", aliases: ["math", "latex", "tex", "formula", "$$"], group: "Advanced blocks", icon: "equation", hint: "$$", description: "Display a standalone math equation.", onItemClick: () => {
    const block = put({ type: "equation" });
    setTimeout(() => openSourcePopup(editor, block.id), 0);
  } });
  push({ key: "breadcrumb", title: "Breadcrumb", aliases: ["path", "location"], group: "Advanced blocks", icon: "breadcrumb", description: "Show where this page sits.", onItemClick: () => put({ type: "breadcrumb" }) });
  for (const n of [2, 3, 4, 5])
    push({
      key: `columns-${n}`,
      title: `${n} columns`,
      aliases: ["columns", "layout", "side by side", `${n} col`],
      group: "Advanced blocks",
      icon: "columns",
      description: `Create ${n} columns of blocks.`,
      onItemClick: () => {
        const block = put({ type: "columnList", children: Array.from({ length: n }, () => ({ type: "column", children: [{ type: "paragraph" }] })) });
        const first = (block as { children?: { children?: { id: string }[] }[] }).children?.[0]?.children?.[0];
        if (first) editor.setTextCursorPosition(first.id, "start");
      },
    });
  push({ key: "mermaid", title: "Mermaid diagram", aliases: ["diagram", "flowchart", "chart", "sequence"], group: "Advanced blocks", icon: "mermaid", description: "Draw a diagram from text.", onItemClick: () => put({ type: "codeBlock", props: { language: "mermaid", view: "split" }, content: "graph TD\n  A[Idea] --> B[Draft]\n  B --> C[Ship]" }) });

  push({ key: "mention-person", title: "Mention a person", aliases: ["@", "person", "user", "people"], group: "Inline", icon: "person", description: "Ping someone so they get notified.", onItemClick: () => openSuggestion(editor, "@") });
  push({ key: "mention-page", title: "Mention a page", aliases: ["@", "page link"], group: "Inline", icon: "arrowUpRight", description: "Link to a page inline.", onItemClick: () => openSuggestion(editor, "@") });
  push({ key: "date", title: "Date or reminder", aliases: ["today", "now", "time", "@today"], group: "Inline", icon: "date", description: "Insert today's date.", onItemClick: () => editor.insertInlineContent([{ type: "mention", props: { kind: "date", date: todayIso() } }, " "] as never) });
  push({ key: "inline-equation", title: "Inline equation", aliases: ["inline math", "$", "tex"], group: "Inline", icon: "equation", description: "Insert math inside text.", onItemClick: () => editor.insertInlineContent([{ type: "inlineEquation", content: "x^2" }, " "] as never) });
  push({ key: "emoji", title: "Emoji", aliases: ["emoji", "smiley", ":"], group: "Inline", icon: "smile", description: "Search for an emoji to place in text.", onItemClick: () => openSuggestion(editor, ":") });

  push({ key: "embed", title: "Embed", aliases: ["iframe", "embed link", "website"], group: "Embeds", icon: "embed", description: "Embed a link.", onItemClick: () => put({ type: "embed" }) });
  for (const service of ["Figma", "YouTube", "GitHub Gist", "Google Maps", "PDF"]) push({ key: `embed-${service}`, title: service, aliases: ["embed", service.toLowerCase()], group: "Embeds", icon: service === "PDF" ? "file" : "embed", description: `Embed a ${service} link.`, onItemClick: () => put({ type: service === "PDF" ? "file" : "embed" }) });

  for (const kind of TEXT_KINDS.filter((k) => k.turnInto))
    items.push({
      key: `turn-${kind.key}`,
      title: `Turn into ${kind.title.toLowerCase()}`,
      aliases: [`turn ${kind.title.toLowerCase()}`, `turninto ${kind.key}`],
      group: "Turn into",
      icon: kind.icon,
      onItemClick: () => turnInto(editor, [current()] as never, kind),
    });
  for (const color of NOTION_COLORS) {
    items.push({ key: `color-${color}`, title: color === "default" ? "Default" : colorLabel(color), aliases: [`${color} text`, "color", "colour"], group: "Colors", icon: "color", swatch: color, onItemClick: () => editor.updateBlock(current(), { props: { textColor: color } } as never) });
    if (color !== "default") items.push({ key: `bg-${color}`, title: `${colorLabel(color)} background`, aliases: [`${color} background`, "highlight", "background"], group: "Colors", icon: "color", swatch: `${color}-bg`, onItemClick: () => editor.updateBlock(current(), { props: { backgroundColor: color } } as never) });
  }
  return items;
}

export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.filter((i) => i.group !== "Turn into" && i.group !== "Colors");
  if (q.startsWith("turn")) {
    const rest = q.replace(/^turn\s*(into)?\s*/, "");
    return items.filter((i) => i.group === "Turn into" && (!rest || fuzzyScore(rest, { title: i.title.replace(/^turn into /i, ""), aliases: [] }) > 0));
  }
  const scored = items.map((item) => ({ item, score: fuzzyScore(q, item) })).filter((s) => s.score > 0 && s.item.group !== "Turn into");
  scored.sort((a, b) => b.score - a.score || GROUPS.indexOf(a.item.group) - GROUPS.indexOf(b.item.group));
  return scored.map((s) => s.item);
}

export function SlashMenu(props: SuggestionMenuProps<SlashItem>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const setRef = useCallback((el: HTMLDivElement | null) => {
    ref.current = el;
    if (el) retireOtherMenus(el);
    return el ? menuExit(el) : undefined;
  }, []);
  useFlip(ref, "[data-flip]", "data-flip", [props.items], { enter: true, enterShift: 0, duration: MOTION.fast, scroller: ".n-menu-scroll" });
  useLayoutEffect(() => {
    if (ref.current) retireOtherMenus(ref.current);
  }, [props.items]);
  useEffect(() => {
    ref.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }, [props.selectedIndex]);
  if (!props.items.length) {
    return (
      <div className="n-popover n-slash" ref={setRef} role="listbox">
        <div className="n-menu-empty">No results</div>
      </div>
    );
  }
  let lastGroup = "";
  return (
    <div className="n-popover n-slash" ref={setRef} role="listbox" data-testid="slash-menu">
      <div className="n-menu-scroll">
        {props.items.map((item, index) => {
          const header = item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <div key={item.key} data-flip={item.key}>
              {header ? <div className="n-menu-heading">{header}</div> : null}
              <button
                type="button"
                role="option"
                aria-selected={index === props.selectedIndex}
                data-testid={`slash-${item.key}`}
                className={`n-slash-item${index === props.selectedIndex ? " is-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onItemClick?.(item)}
              >
                <span className={`n-slash-icon${item.swatch ? ` n-swatch-${item.swatch}` : ""}`}>{item.swatch ? "A" : <Icon name={item.icon} size={18} />}</span>
                <span className="n-slash-text">
                  <span className="n-slash-title">{item.title}</span>
                </span>
                {item.hint ? <span className="n-menu-hint">{item.hint}</span> : null}
              </button>
            </div>
          );
        })}
      </div>
      <div className="n-slash-footer">
        <span>Type ‘/’ on the page</span>
        <span className="n-spacer" />
        <span>esc</span>
      </div>
    </div>
  );
}
