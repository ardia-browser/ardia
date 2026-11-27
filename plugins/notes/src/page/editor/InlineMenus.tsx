import type { SuggestionMenuProps } from "@blocknote/react";
import { loadFrimousseData, searchEmojis } from "@blocknote/core/emoji-data";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { allPages, ancestorsOf, displayTitle, isArchivedDeep } from "../../shared/model";
import type { PresenceEntry } from "../../shared/protocol";
import { Icon, PageIcon, type IconName } from "../ui/icons";
import type { NotesEnv } from "./env";
import { fuzzyScore, todayIso } from "./SlashMenu";
import type { NotesEditor } from "./schema";
import { exitRef, MOTION, retireOtherMenus, useFlip } from "../ui/motion";

const menuExit = exitRef<HTMLDivElement>("is-leaving");

export type InlineItem = {
  key: string;
  title: string;
  group: string;
  icon?: IconName;
  emoji?: string;
  pageIcon?: string;
  avatar?: { color: string; initial: string };
  detail?: string;
  onItemClick: () => void;
};

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function parseDate(query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  if ("today".startsWith(q) || q === "now") return todayIso();
  if ("tomorrow".startsWith(q)) return todayIso(1);
  if ("yesterday".startsWith(q)) return todayIso(-1);
  const day = DAY_NAMES.findIndex((d) => d.startsWith(q.replace(/^next\s+/, "")) && q.replace(/^next\s+/, "").length >= 3);
  if (day >= 0) {
    const now = new Date();
    let offset = (day - now.getDay() + 7) % 7 || 7;
    if (q.startsWith("next")) offset += 7;
    return todayIso(offset);
  }
  const parsed = new Date(query);
  if (!Number.isNaN(parsed.getTime()) && /\d/.test(query)) return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
  return null;
}

function pageItems(editor: NotesEditor, env: NotesEnv, query: string, limit: number): InlineItem[] {
  const pages = allPages(env.tree).filter((p) => !isArchivedDeep(env.tree, p.id) && p.id !== env.page);
  const scored = pages
    .map((p) => ({ p, score: query ? fuzzyScore(query, { title: displayTitle(p) }) : 1 + p.updatedAt / 1e15 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map(({ p }) => ({
    key: `page-${p.id}`,
    title: displayTitle(p),
    group: "Link to page",
    pageIcon: p.icon || "",
    detail: ancestorsOf(env.tree, p.id).map((a) => displayTitle(a)).join(" / "),
    onItemClick: () => editor.insertInlineContent([{ type: "mention", props: { kind: "page", pageId: p.id } }, " "] as never),
  }));
}

function newPageItem(editor: NotesEditor, env: NotesEnv, query: string): InlineItem {
  return {
    key: "new-page",
    title: query ? `New “${query}” sub-page` : "New sub-page",
    group: "Link to page",
    icon: "plus",
    onItemClick: () => {
      void env.createChildPage({ title: query }).then((id) => editor.insertInlineContent([{ type: "mention", props: { kind: "page", pageId: id } }, " "] as never));
    },
  };
}

export function mentionItems(editor: NotesEditor, env: NotesEnv, presence: PresenceEntry[], query: string): InlineItem[] {
  const out: InlineItem[] = [];
  const me = env.client.me();
  const people = new Map<string, { name: string; color: string }>();
  people.set(me.deviceId, { name: me.name || "You", color: me.color });
  for (const entry of presence) if (entry.name) people.set(entry.deviceId, { name: entry.name, color: entry.color });
  for (const [id, person] of people) {
    if (query && fuzzyScore(query, { title: person.name }) <= 0) continue;
    out.push({
      key: `person-${id}`,
      title: person.name,
      group: "People",
      avatar: { color: person.color, initial: (person.name[0] ?? "?").toUpperCase() },
      onItemClick: () => editor.insertInlineContent([{ type: "mention", props: { kind: "user", name: person.name, color: person.color } }, " "] as never),
    });
  }
  const date = parseDate(query);
  const dates: [string, string][] = date ? [[date, query]] : query ? [] : [[todayIso(), "Today"], [todayIso(1), "Tomorrow"]];
  for (const [iso, label] of dates)
    out.push({
      key: `date-${iso}-${label}`,
      title: label[0]!.toUpperCase() + label.slice(1),
      detail: new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
      group: "Date",
      icon: "date",
      onItemClick: () => editor.insertInlineContent([{ type: "mention", props: { kind: "date", date: iso } }, " "] as never),
    });
  out.push(...pageItems(editor, env, query, 6));
  if (query) out.push(newPageItem(editor, env, query));
  return out;
}

export function linkItems(editor: NotesEditor, env: NotesEnv, query: string): InlineItem[] {
  return [...pageItems(editor, env, query, 8), newPageItem(editor, env, query)];
}

let emojiData: ReturnType<typeof loadFrimousseData> | null = null;

export function prefetchEmoji() {
  if (emojiData) return;
  const loading = loadFrimousseData("en");
  emojiData = loading;
  loading.catch(() => {
    if (emojiData === loading) emojiData = null;
  });
}

export async function emojiItems(editor: NotesEditor, query: string): Promise<InlineItem[]> {
  emojiData ??= loadFrimousseData("en");
  const data = await emojiData;
  return searchEmojis(data.emojis, query)
    .slice(0, 30)
    .map((e) => ({ key: e.emoji, title: `:${e.label.toLowerCase().replace(/\s+/g, "_")}:`, emoji: e.emoji, group: "Emoji", onItemClick: () => editor.insertInlineContent(e.emoji) }));
}

export function InlineMenu(props: SuggestionMenuProps<InlineItem>) {
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
  let last = "";
  return (
    <div className="n-popover n-slash n-inline-menu" ref={setRef} role="listbox" data-testid="inline-menu">
      <div className="n-menu-scroll">
        {!props.items.length ? <div className="n-menu-empty">{props.loadingState === "loaded" ? "No results" : "Searching…"}</div> : null}
        {props.items.map((item, index) => {
          const header = item.group !== last ? item.group : null;
          last = item.group;
          return (
            <div key={item.key} data-flip={item.key}>
              {header ? <div className="n-menu-heading">{header}</div> : null}
              <button
                type="button"
                role="option"
                aria-selected={index === props.selectedIndex}
                className={`n-menu-item${index === props.selectedIndex ? " is-active" : ""}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => props.onItemClick?.(item)}
              >
                <span className="n-menu-icon">
                  {item.avatar ? (
                    <span className="n-avatar is-small" style={{ background: item.avatar.color }}>
                      {item.avatar.initial}
                    </span>
                  ) : item.emoji ? (
                    <span className="n-emoji">{item.emoji}</span>
                  ) : item.pageIcon !== undefined ? (
                    <PageIcon icon={item.pageIcon} />
                  ) : (
                    <Icon name={item.icon ?? "page"} />
                  )}
                </span>
                <span className="n-menu-label">
                  {item.title}
                  {item.detail ? <span className="n-menu-detail">{item.detail}</span> : null}
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
