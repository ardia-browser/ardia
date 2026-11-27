import { createExtension, type BlockNoteEditor } from "@blocknote/core";
import { SuggestionMenu } from "@blocknote/core/extensions";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { EditorState } from "prosemirror-state";
import { TEXT_KINDS } from "./blockTypes";
import { withBlockMotion } from "./blockMotion";
import { duplicateBlocks, selectBlocks, selectedBlockIds, turnInto } from "./ops";

type AnyEditor = BlockNoteEditor<any, any, any>;

export const shortcutEvents = { onComment: () => {}, onCopyBlockLink: (_id: string) => {} };

const kindByDigit: Record<string, string> = { "0": "text", "1": "h1", "2": "h2", "3": "h3", "4": "todo", "5": "bullet", "6": "numbered", "7": "toggle", "8": "code" };

function selectedBlocks(editor: AnyEditor) {
  return selectedBlockIds(editor)
    .map((id) => editor.getBlock(id))
    .filter((b): b is NonNullable<typeof b> => !!b);
}

const EMBEDDED_WIDGETS = ".db-block";
const WIDGET_FIELDS = "input, textarea, select, label, [contenteditable='true']";

function widgetOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(EMBEDDED_WIDGETS) : null;
}

function withinWidget(target: EventTarget | null, widget: HTMLElement, selector: string): boolean {
  const hit = target instanceof Element ? target.closest(selector) : null;
  return !!hit && widget.contains(hit);
}

function pickedBlockContents(state: EditorState): { from: number; to: number }[] {
  const { from, to, $from, $to } = state.selection;
  if (from === to) return [];
  const container = (pos: typeof $from) => {
    for (let d = pos.depth; d > 0; d--) if (pos.node(d).type.name === "blockContainer") return pos.before(d);
    return -1;
  };
  if (container($from) === container($to) && container($from) !== -1) return [];
  const picked: { from: number; to: number }[] = [];
  state.doc.nodesBetween(from, to, (node, pos, parent) => {
    if (parent?.type.name === "blockContainer" && node.type.isInGroup?.("blockContent")) {
      picked.push({ from: pos, to: pos + node.nodeSize });
      return false;
    }
    return true;
  });
  return picked;
}

function blockRangeSelection() {
  return new Plugin({
    key: new PluginKey("notes-block-range-selection"),
    props: {
      decorations(state) {
        const picked = pickedBlockContents(state);
        if (!picked.length) return null;
        return DecorationSet.create(state.doc, picked.map((r) => Decoration.node(r.from, r.to, { class: "n-block-picked" })));
      },
      attributes(state): Record<string, string> {
        return pickedBlockContents(state).length ? { class: "n-range-picked" } : {};
      },
    },
  });
}

function embeddedWidgetEvents() {
  let pointerInWidget = false;
  const ownDrag = (view: EditorView, event: Event) => !view.dragging && !!widgetOf(event.target);
  return new Plugin({
    key: new PluginKey("notes-embedded-widget-events"),
    filterTransaction: (tr) => !(pointerInWidget && tr.selectionSet && !tr.docChanged),
    props: {
      handleDOMEvents: {
        mousedown: (view, event) => {
          const widget = widgetOf(event.target);
          pointerInWidget = !!widget;
          if (!widget) return false;
          if (!withinWidget(event.target, widget, WIDGET_FIELDS)) {
            event.preventDefault();
            const active = document.activeElement;
            if (active instanceof HTMLElement && (active === view.dom || !widget.contains(active) || active.matches(WIDGET_FIELDS))) active.blur();
          }
          return true;
        },
        keydown: () => {
          pointerInWidget = false;
          return false;
        },
        focusin: (_view, event) => {
          if (!widgetOf(event.target)) pointerInWidget = false;
          return false;
        },
        dragstart: (view, event) => {
          const widget = widgetOf(event.target);
          if (!widget || view.dragging) return false;
          if (!withinWidget(event.target, widget, "[draggable='true']")) event.preventDefault();
          return true;
        },
        dragenter: ownDrag,
        dragover: ownDrag,
        dragleave: ownDrag,
        drop: ownDrag,
        dragend: ownDrag,
      },
      handleClickOn: (_view, _pos, _node, _nodePos, event) => !!widgetOf(event.target),
      handleDoubleClickOn: (_view, _pos, _node, _nodePos, event) => !!widgetOf(event.target),
      handleTripleClickOn: (_view, _pos, _node, _nodePos, event) => !!widgetOf(event.target),
    },
  });
}

function inlineMarkRules() {
  return new Plugin({
    key: new PluginKey("notes-inline-rules"),
    props: {
      handleTextInput(view, from, to, text) {
        if (text !== "~" && text !== "$") return false;
        const $from = view.state.doc.resolve(from);
        if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
        const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 200), $from.parentOffset, undefined, "￼");
        const pattern = text === "~" ? /(?:^|[^~])~([^~\s](?:[^~]*[^~\s])?)$/ : /(?:^|[^$])\$([^$\s](?:[^$]*[^$\s])?)$/;
        const match = pattern.exec(before);
        if (!match) return false;
        const inner = match[1]!;
        const start = from - inner.length - 1;
        const { schema } = view.state;
        if (text === "~") {
          const strike = schema.marks.strike;
          if (!strike) return false;
          const tr = view.state.tr.delete(start, to).insert(start, schema.text(inner, [strike.create()]));
          tr.removeStoredMark(strike);
          view.dispatch(tr);
          return true;
        }
        const node = schema.nodes.inlineEquation;
        if (!node) return false;
        const tr = view.state.tr.replaceWith(start, to, node.create(null, schema.text(inner)));
        tr.setSelection(TextSelection.create(tr.doc, start + node.create(null, schema.text(inner)).nodeSize));
        view.dispatch(tr);
        return true;
      },
    },
  });
}

export function focusTitle(editor: AnyEditor) {
  const title = editor.domElement?.closest(".n-page")?.querySelector<HTMLElement>(".n-title[contenteditable='true']");
  if (!title) return false;
  title.focus();
  const range = document.createRange();
  range.selectNodeContents(title);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return true;
}

function toggleOpenState(id: string) {
  const button = document.querySelector<HTMLButtonElement>(`[data-id="${id}"] .bn-toggle-button`);
  button?.click();
  return !!button;
}

function dividerRule(editor: AnyEditor) {
  return new Plugin({
    key: new PluginKey("notes-divider-rule"),
    props: {
      handleTextInput(view, from, _to, text) {
        if (text !== "-") return false;
        const $from = view.state.doc.resolve(from);
        if ($from.parent.type.name !== "paragraph" || $from.parent.textContent !== "--" || $from.parentOffset !== 2) return false;
        const block = editor.getTextCursorPosition().block;
        editor.transact(() => {
          editor.updateBlock(block, { type: "divider", content: undefined } as never);
          const next = editor.getNextBlock(block.id) as { id: string; type: string; content?: unknown[] } | undefined;
          if (next && next.type === "paragraph" && !next.content?.length) editor.setTextCursorPosition(next.id, "start");
          else {
            const [inserted] = editor.insertBlocks([{ type: "paragraph" }] as never, block.id, "after");
            if (inserted) editor.setTextCursorPosition(inserted, "start");
          }
        });
        return true;
      },
    },
  });
}

export const dividerShortcuts = createExtension({ key: "divider-block-shortcuts" });

export const notionShortcuts = createExtension(({ editor }: { editor: AnyEditor }) => ({
  key: "notion-shortcuts",
  prosemirrorPlugins: [inlineMarkRules(), dividerRule(editor), embeddedWidgetEvents(), blockRangeSelection()],
  inputRules: [
    { find: /^>\s$/, replace: () => ({ type: "toggleListItem", props: {} }) },
    { find: /^\$\$\s$/, replace: () => ({ type: "equation", props: {} }) },
  ],
  keyboardShortcuts: {
    "Mod-d": ({ editor }) => {
      duplicateBlocks(editor, selectedBlocks(editor) as never);
      return true;
    },
    "Mod-Enter": ({ editor }) => {
      const block = editor.getTextCursorPosition().block as { id: string; type: string; props: Record<string, unknown> };
      if (block.type === "checkListItem") {
        editor.updateBlock(block, { props: { checked: !block.props.checked } } as never);
        return true;
      }
      if (block.type === "toggleListItem" || (block.type === "heading" && block.props.isToggleable)) return toggleOpenState(block.id);
      return false;
    },
    "Mod-Shift-ArrowUp": ({ editor }) => {
      withBlockMotion(editor, () => editor.moveBlocksUp());
      return true;
    },
    "Mod-Shift-ArrowDown": ({ editor }) => {
      withBlockMotion(editor, () => editor.moveBlocksDown());
      return true;
    },
    "Mod-Shift-m": () => {
      shortcutEvents.onComment();
      return true;
    },
    "Alt-Shift-l": ({ editor }) => {
      shortcutEvents.onCopyBlockLink(editor.getTextCursorPosition().block.id);
      return true;
    },
    Escape: ({ editor }) => {
      if (editor.getExtension(SuggestionMenu)?.shown()) return false;
      const view = editor.prosemirrorView;
      if (view.state.selection instanceof NodeSelection) {
        (document.activeElement as HTMLElement | null)?.blur();
        return true;
      }
      const ids = selectedBlockIds(editor);
      selectBlocks(editor, ids);
      return true;
    },
    ...Object.fromEntries(
      Object.entries(kindByDigit).map(([digit, key]) => [
        `Mod-Alt-${digit}`,
        ({ editor }: { editor: AnyEditor }) => {
          const kind = TEXT_KINDS.find((k) => k.key === key);
          if (!kind) return false;
          turnInto(editor, selectedBlocks(editor) as never, kind);
          return true;
        },
      ]),
    ),
  },
}));

export function installTitleKeys(editor: AnyEditor): () => void {
  const dom = editor.prosemirrorView.dom as HTMLElement;
  const onKey = (event: KeyboardEvent) => {
    const digit = /^Digit([0-8])$/.exec(event.code)?.[1];
    if (digit && event.altKey && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.isComposing) {
      const kind = TEXT_KINDS.find((k) => k.key === kindByDigit[digit]);
      if (!kind) return;
      event.preventDefault();
      event.stopPropagation();
      turnInto(editor, selectedBlocks(editor) as never, kind);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "Backspace") return;
    if (event.shiftKey || event.metaKey || event.altKey || event.ctrlKey || event.isComposing) return;
    const { block, prevBlock, parentBlock } = editor.getTextCursorPosition();
    const sel = editor.prosemirrorState.selection;
    if (prevBlock || parentBlock || !sel.empty || sel.$from.parentOffset !== 0) return;
    if (event.key === "Backspace") {
      if (block.type !== "paragraph") return;
      const empty = Array.isArray(block.content) && block.content.length === 0;
      if (!empty) return;
      if (editor.document.length > 1) editor.removeBlocks([block.id]);
    }
    if (focusTitle(editor)) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  dom.addEventListener("keydown", onKey, true);
  return () => dom.removeEventListener("keydown", onKey, true);
}
