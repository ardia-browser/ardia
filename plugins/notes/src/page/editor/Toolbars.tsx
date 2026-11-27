import { FormattingToolbarExtension, SuggestionMenu } from "@blocknote/core/extensions";
import { useActiveStyles, useBlockNoteEditor, useExtension, useSelectedBlocks, type LinkToolbarProps } from "@blocknote/react";
import { useState } from "react";
import { NodeSelection, TextSelection } from "prosemirror-state";
import { Icon, type IconName } from "../ui/icons";
import { Menu, type MenuEntry } from "../ui/Menu";
import { Popover } from "../ui/Popover";
import { colorLabel, kindOfBlock, NOTION_COLORS } from "./blockTypes";
import { turnIntoEntries } from "./BlockMenu";
import { useNotesEnv } from "./env";
import type { NotesEditor } from "./schema";
import { exitRef, MOTION } from "../ui/motion";

const toolbarExit = exitRef<HTMLDivElement>("is-leaving", MOTION.exit);

export const toolbarEvents = { onComment: () => {} };

function ToolButton({ icon, label, active, onClick, testId, children }: { icon?: IconName; label: string; active?: boolean; onClick: (el: HTMLElement) => void; testId?: string; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      className={`n-tb-button${active ? " is-on" : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => onClick(e.currentTarget)}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

function LinkPrompt({ anchor, initial, onSubmit, onClose }: { anchor: HTMLElement; initial: string; onSubmit: (url: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState(initial);
  return (
    <Popover anchor={anchor} onClose={onClose} width={320}>
      <form
        className="n-linkprompt"
        onSubmit={(e) => {
          e.preventDefault();
          const value = url.trim();
          if (value) onSubmit(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`);
          onClose();
        }}
      >
        <div className="n-field">
          <Icon name="link" size={14} />
          <input autoFocus placeholder="Paste link or search pages" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Link" />
        </div>
      </form>
    </Popover>
  );
}

export function NotesFormattingToolbar() {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const env = useNotesEnv();
  const styles = useActiveStyles(editor) as Record<string, unknown>;
  const blocks = useSelectedBlocks(editor) as unknown as { id: string; type: string; props: Record<string, any>; content: any; children: any[] }[];
  const toolbar = useExtension(FormattingToolbarExtension);
  const suggestions = useExtension(SuggestionMenu);
  const [open, setOpen] = useState<{ kind: "turn" | "color" | "link"; el: HTMLElement } | null>(null);
  const first = blocks[0];
  const kind = first ? kindOfBlock(first) : undefined;
  if (!first || editor.prosemirrorState.selection instanceof NodeSelection || blocks.some((b) => b.type === "codeBlock" || b.type === "equation")) return null;
  const toggle = (style: string) => editor.toggleStyles({ [style]: true } as never);
  const colorEntries: MenuEntry[] = [
    { kind: "heading", label: "Text color" },
    ...NOTION_COLORS.map((c): MenuEntry => ({ id: `ft-text-${c}`, label: c === "default" ? "Default text" : `${colorLabel(c)} text`, icon: <span className={`n-color-chip n-swatch-${c}`}>A</span>, checked: (styles.textColor ?? "default") === c, onSelect: () => (c === "default" ? editor.removeStyles({ textColor: "" } as never) : editor.addStyles({ textColor: c } as never)) })),
    { kind: "heading", label: "Background color" },
    ...NOTION_COLORS.map((c): MenuEntry => ({ id: `ft-bg-${c}`, label: c === "default" ? "Default background" : `${colorLabel(c)} background`, icon: <span className={`n-color-chip n-swatch-${c}-bg`}>A</span>, checked: (styles.backgroundColor ?? "default") === c, onSelect: () => (c === "default" ? editor.removeStyles({ backgroundColor: "" } as never) : editor.addStyles({ backgroundColor: c } as never)) })),
  ];
  void toolbar;
  return (
    <div ref={toolbarExit} className="n-toolbar" data-testid="formatting-toolbar" onMouseDown={(e) => e.preventDefault()}>
      <ToolButton label="Turn into" onClick={(el) => setOpen({ kind: "turn", el })} testId="tb-turn">
        <span className="n-tb-text">{kind?.title ?? "Text"}</span>
        <Icon name="chevronDown" size={12} />
      </ToolButton>
      <span className="n-tb-sep" />
      <ToolButton icon="link" label="Link (⌘K)" active={!!editor.getSelectedLinkUrl()} onClick={(el) => setOpen({ kind: "link", el })} testId="tb-link" />
      <ToolButton icon="comment" label="Comment (⌘⇧M)" onClick={() => toolbarEvents.onComment()} testId="tb-comment" />
      <span className="n-tb-sep" />
      <ToolButton icon="bold" label="Bold (⌘B)" active={!!styles.bold} onClick={() => toggle("bold")} testId="tb-bold" />
      <ToolButton icon="italic" label="Italic (⌘I)" active={!!styles.italic} onClick={() => toggle("italic")} testId="tb-italic" />
      <ToolButton icon="underline" label="Underline (⌘U)" active={!!styles.underline} onClick={() => toggle("underline")} testId="tb-underline" />
      <ToolButton icon="strike" label="Strike-through (⌘⇧S)" active={!!styles.strike} onClick={() => toggle("strike")} testId="tb-strike" />
      <ToolButton icon="code" label="Mark as code (⌘E)" active={!!styles.code} onClick={() => toggle("code")} testId="tb-code" />
      <ToolButton
        icon="equation"
        label="Create equation (⌘⇧E)"
        onClick={() => {
          const text = editor.getSelectedText();
          editor.insertInlineContent([{ type: "inlineEquation", content: text || "x" }] as never);
        }}
        testId="tb-equation"
      />
      <span className="n-tb-sep" />
      <ToolButton label="Text color" onClick={(el) => setOpen({ kind: "color", el })} testId="tb-color">
        <span className={`n-tb-color n-swatch-${String(styles.textColor ?? "default")}`}>A</span>
        <Icon name="chevronDown" size={12} />
      </ToolButton>
      <ToolButton
        icon="at"
        label="Mention"
        onClick={() => {
          const view = editor.prosemirrorView;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, view.state.selection.to)));
          suggestions.openSuggestionMenu("@");
        }}
        testId="tb-mention"
      />
      {open?.kind === "turn" ? <Menu anchor={open.el} onClose={() => setOpen(null)} entries={turnIntoEntries(editor, env, blocks)} width={240} /> : null}
      {open?.kind === "color" ? <Menu anchor={open.el} onClose={() => setOpen(null)} entries={colorEntries} width={220} /> : null}
      {open?.kind === "link" ? <LinkPrompt anchor={open.el} initial={editor.getSelectedLinkUrl() ?? ""} onSubmit={(url) => editor.createLink(url)} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

export function NotesLinkToolbar(props: LinkToolbarProps) {
  const editor = useBlockNoteEditor() as unknown as NotesEditor;
  const env = useNotesEnv();
  const [editing, setEditing] = useState<HTMLElement | null>(null);
  return (
    <div ref={toolbarExit} className="n-toolbar n-linkbar" onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className="n-linkbar-url" title={props.url} onClick={() => env.openUrl(props.url)}>
        <Icon name="globe" size={13} />
        <span>{props.url}</span>
      </button>
      <span className="n-tb-sep" />
      <ToolButton icon="edit" label="Edit link" onClick={(el) => setEditing(el)} />
      <ToolButton icon="copy" label="Copy link" onClick={() => void navigator.clipboard?.writeText(props.url).catch(() => {})} />
      <ToolButton icon="x" label="Remove link" onClick={() => editor.deleteLink(props.range.from)} />
      {editing ? (
        <LinkPrompt
          anchor={editing}
          initial={props.url}
          onSubmit={(url) => editor.editLink(url, props.text, props.range.from)}
          onClose={() => {
            setEditing(null);
            props.setToolbarOpen?.(false);
          }}
        />
      ) : null}
    </div>
  );
}
