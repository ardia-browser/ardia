import type { IconName } from "../ui/icons";

export type BlockKind = {
  key: string;
  title: string;
  icon: IconName;
  aliases: string[];
  hint?: string;
  type: string;
  props?: Record<string, unknown>;
  turnInto: boolean;
  description: string;
};

export const TEXT_KINDS: BlockKind[] = [
  { key: "text", title: "Text", icon: "text", aliases: ["paragraph", "plain", "p"], type: "paragraph", turnInto: true, description: "Just start writing with plain text." },
  { key: "h1", title: "Heading 1", icon: "h1", aliases: ["h1", "title", "big", "#"], hint: "#", type: "heading", props: { level: 1, isToggleable: false }, turnInto: true, description: "Big section heading." },
  { key: "h2", title: "Heading 2", icon: "h2", aliases: ["h2", "subtitle", "medium", "##"], hint: "##", type: "heading", props: { level: 2, isToggleable: false }, turnInto: true, description: "Medium section heading." },
  { key: "h3", title: "Heading 3", icon: "h3", aliases: ["h3", "small", "###"], hint: "###", type: "heading", props: { level: 3, isToggleable: false }, turnInto: true, description: "Small section heading." },
  { key: "bullet", title: "Bulleted list", icon: "bulleted", aliases: ["ul", "unordered", "bullet", "list", "-"], hint: "-", type: "bulletListItem", turnInto: true, description: "Create a simple bulleted list." },
  { key: "numbered", title: "Numbered list", icon: "numbered", aliases: ["ol", "ordered", "numbers", "1."], hint: "1.", type: "numberedListItem", turnInto: true, description: "Create a list with numbering." },
  { key: "todo", title: "To-do list", icon: "todo", aliases: ["todo", "checkbox", "task", "check", "[]"], hint: "[]", type: "checkListItem", turnInto: true, description: "Track tasks with a to-do list." },
  { key: "toggle", title: "Toggle list", icon: "toggleList", aliases: ["toggle", "collapse", "details", ">"], hint: ">", type: "toggleListItem", turnInto: true, description: "Toggles can hide and show content inside." },
  { key: "quote", title: "Quote", icon: "quote", aliases: ["blockquote", "citation", '"'], hint: '"', type: "quote", turnInto: true, description: "Capture a quote." },
  { key: "callout", title: "Callout", icon: "callout", aliases: ["note", "info", "tip", "warning", "aside"], type: "callout", turnInto: true, description: "Make writing stand out." },
  { key: "th1", title: "Toggle heading 1", icon: "h1", aliases: ["toggle h1", "collapsible heading"], hint: "# >", type: "heading", props: { level: 1, isToggleable: true }, turnInto: true, description: "Hide content inside a large heading." },
  { key: "th2", title: "Toggle heading 2", icon: "h2", aliases: ["toggle h2"], hint: "## >", type: "heading", props: { level: 2, isToggleable: true }, turnInto: true, description: "Hide content inside a medium heading." },
  { key: "th3", title: "Toggle heading 3", icon: "h3", aliases: ["toggle h3"], hint: "### >", type: "heading", props: { level: 3, isToggleable: true }, turnInto: true, description: "Hide content inside a small heading." },
  { key: "code", title: "Code", icon: "code", aliases: ["snippet", "pre", "```", "programming"], hint: "```", type: "codeBlock", turnInto: true, description: "Capture a code snippet." },
];

export const kindOfBlock = (block: { type: string; props: Record<string, unknown> }): BlockKind | undefined =>
  TEXT_KINDS.find((k) => {
    if (k.type !== block.type) return false;
    if (k.type !== "heading") return true;
    return k.props?.level === block.props.level && Boolean(k.props?.isToggleable) === Boolean(block.props.isToggleable);
  });

export const NOTION_COLORS = ["default", "gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type NotionColor = (typeof NOTION_COLORS)[number];
export const colorLabel = (c: string) => c[0]!.toUpperCase() + c.slice(1);
