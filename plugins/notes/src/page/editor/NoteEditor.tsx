import "@blocknote/mantine/style.css";
import { CommentsExtension, DefaultThreadStoreAuth, type ThreadStore } from "@blocknote/core/comments";
import { SyntaxHighlightingExtension } from "@blocknote/core/extensions";
import { en } from "@blocknote/core/locales";
import { withCollaboration, YjsThreadStore } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { FilePanelController, FormattingToolbarController, LinkToolbarController, SideMenuController, SuggestionMenuController, useCreateBlockNote, useExtensionState } from "@blocknote/react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { blocksOf, commentsOf } from "../../shared/model";
import type { Me, PresenceEntry } from "../../shared/protocol";
import { commentBody } from "../comments/Comments";
import { Composer } from "../comments/Comments";
import { Popover } from "../ui/Popover";
import { toast } from "../ui/toast";
import type { NotesEnv } from "./env";
import { NotesEnvContext } from "./env";
import { createNotesHighlighter } from "./highlighter";
import { emojiItems, InlineMenu, prefetchEmoji, linkItems, mentionItems, type InlineItem } from "./InlineMenus";
import { blockLink, selectBlocks } from "./ops";
import { schema, type NotesEditor } from "./schema";
import { installBlockMotion } from "./blockMotion";
import { installTitleKeys, notionShortcuts, shortcutEvents } from "./shortcuts";
import { NotesSideMenu, sideMenuEvents, sideMenuFloating } from "./SideMenu";
import { buildSlashItems, filterSlashItems, SlashMenu, type SlashItem } from "./SlashMenu";
import { NotesFormattingToolbar, NotesLinkToolbar, toolbarEvents } from "./Toolbars";
import { installColumnDrop } from "./columnDrop";
import { NotesFilePanel } from "./FilePanel";

const fast = { useTransitionStylesProps: { duration: { open: 120, close: 90 } } };
const menuMotion = { useTransitionStylesProps: { duration: { open: 120, close: 0 } } };

const dictionary = {
  ...en,
  placeholders: {
    ...en.placeholders,
    default: "Press ‘/’ for commands",
    emptyDocument: "Press ‘/’ for commands",
    heading: "Heading",
    bulletListItem: "List",
    numberedListItem: "List",
    checkListItem: "To-do",
    toggleListItem: "Toggle",
    quote: "Empty quote",
    callout: "Type something…",
  },
  toggle_blocks: { ...en.toggle_blocks, add_block_button: "Empty toggle. Click or drop blocks inside." },
};

export type EditorHandle = { editor: NotesEditor; threadStore: ThreadStore };

export const NoteEditor = memo(NoteEditorView, (a, b) => a.env === b.env && a.doc === b.doc && a.awareness === b.awareness && a.me === b.me && a.presence === b.presence && a.readOnly === b.readOnly);

function NoteEditorView({
  env,
  doc,
  awareness,
  me,
  presence,
  readOnly,
  onReady,
  onOpenThread,
}: {
  env: NotesEnv;
  doc: Y.Doc;
  awareness: Awareness;
  me: Me;
  presence: PresenceEntry[];
  readOnly: boolean;
  onReady: (handle: EditorHandle | null) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const threadStore = useMemo(() => new YjsThreadStore(me.deviceId, commentsOf(doc) as Y.Map<any>, new DefaultThreadStoreAuth(me.deviceId, "editor")), [doc, me.deviceId]);
  const editor = useCreateBlockNote(
    withCollaboration({
      schema,
      dictionary,
      animations: !matchMedia("(prefers-reduced-motion: reduce)").matches,
      tables: { headers: true, cellBackgroundColor: true, cellTextColor: true, splitCells: true },
      uploadFile: async (file: File) => env.client.upload(env.workspace, file, file.name),
      resolveFileUrl: async (url: string) => (url.startsWith("file:") ? env.client.fileUrl(env.workspace, url) : url),
      extensions: [
        notionShortcuts(),
        SyntaxHighlightingExtension({ createHighlighter: createNotesHighlighter as never }),
        CommentsExtension({
          threadStore,
          resolveUsers: async (ids: string[]) => ids.map((id) => ({ id, username: id === me.deviceId ? me.name : (presence.find((p) => p.deviceId === id)?.name ?? "Someone"), avatarUrl: "" })),
        }),
      ],
      collaboration: { fragment: blocksOf(doc), user: { name: me.name || "You", color: me.color }, provider: { awareness }, showCursorLabels: "activity" },
    }),
    [doc, threadStore],
  ) as unknown as NotesEditor;

  const envRef = useRef(env);
  envRef.current = env;
  const presenceRef = useRef(presence);
  presenceRef.current = presence;
  const slashItems = useMemo(() => buildSlashItems(editor, env), [editor, env]);

  useEffect(() => {
    editor.isEditable = !readOnly;
  }, [editor, readOnly]);

  useEffect(() => {
    const cursor = editor.getExtension("yCursor") as { updateUser?: (u: { name: string; color: string }) => void } | undefined;
    cursor?.updateUser?.({ name: me.name || "You", color: me.color });
  }, [editor, me.name, me.color]);

  useEffect(() => {
    onReady({ editor, threadStore });
    return () => onReady(null);
  }, [editor, threadStore]);

  useEffect(() => installColumnDrop(editor), [editor]);
  useEffect(() => {
    const timer = setTimeout(prefetchEmoji, 1500);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    const timer = setInterval(() => {
      let connected = false;
      try {
        connected = !!editor.prosemirrorView?.dom?.isConnected;
      } catch {}
      if (!connected) return;
      clearInterval(timer);
      const titleKeys = installTitleKeys(editor);
      const blockMotion = installBlockMotion(editor);
      cleanup = () => {
        titleKeys();
        blockMotion();
      };
    }, 50);
    return () => {
      clearInterval(timer);
      cleanup?.();
    };
  }, [editor]);

  const comments = editor.getExtension(CommentsExtension);
  const startComment = () => {
    if (!comments) return;
    if (editor.prosemirrorState.selection.empty) {
      const block = editor.getTextCursorPosition().block;
      editor.setTextCursorPosition(block, "start");
      const view = editor.prosemirrorView;
      const { $from } = view.state.selection;
      const start = $from.start();
      const end = $from.end();
      if (end > start) {
        void import("prosemirror-state").then(({ TextSelection }) => {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, start, end)));
          comments.startPendingComment();
        });
        return;
      }
    }
    comments.startPendingComment();
  };

  useEffect(() => {
    toolbarEvents.onComment = startComment;
    shortcutEvents.onComment = startComment;
    sideMenuEvents.onComment = (blocks) => {
      if (!blocks[0]) return;
      editor.setSelection(blocks[0].id, blocks.at(-1)!.id);
      startComment();
    };
    shortcutEvents.onCopyBlockLink = (id) => {
      void navigator.clipboard?.writeText(blockLink(envRef.current.tree, envRef.current.page, id)).catch(() => {});
      toast("Copied link to block");
    };
  });

  const selectedThread = useExtensionState(CommentsExtension, { editor, selector: (s) => s.selectedThreadId });
  useEffect(() => {
    if (selectedThread) onOpenThread(selectedThread);
  }, [selectedThread]);

  return (
    <NotesEnvContext value={env}>
      <BlockNoteView
        editor={editor as never}
        editable={!readOnly}
        theme={notesTheme}
        formattingToolbar={false}
        slashMenu={false}
        sideMenu={false}
        linkToolbar={false}
        emojiPicker={false}
        comments={false}
        filePanel={false}
        className="n-editor"
        data-testid="editor"
      >
        <SuggestionMenuController floatingUIOptions={menuMotion} triggerCharacter="/" getItems={async (query: string) => filterSlashItems(slashItems, query)} suggestionMenuComponent={SlashMenu} onItemClick={(item: SlashItem) => item.onItemClick()} />
        <SuggestionMenuController
          floatingUIOptions={menuMotion}
          triggerCharacter="@"
          getItems={async (query: string) => mentionItems(editor, envRef.current, presenceRef.current, query)}
          suggestionMenuComponent={InlineMenu}
          onItemClick={(item: InlineItem) => item.onItemClick()}
        />
        <SuggestionMenuController floatingUIOptions={menuMotion} triggerCharacter="[[" getItems={async (query: string) => linkItems(editor, envRef.current, query)} suggestionMenuComponent={InlineMenu} onItemClick={(item: InlineItem) => item.onItemClick()} />
        <SuggestionMenuController floatingUIOptions={menuMotion} triggerCharacter=":" minQueryLength={2} getItems={async (query: string) => emojiItems(editor, query)} suggestionMenuComponent={InlineMenu} onItemClick={(item: InlineItem) => item.onItemClick()} />
        <SideMenuController sideMenu={NotesSideMenu} floatingUIOptions={sideMenuFloating} />
        <FormattingToolbarController formattingToolbar={NotesFormattingToolbar} floatingUIOptions={fast} />
        <LinkToolbarController linkToolbar={NotesLinkToolbar} floatingUIOptions={fast} />
        <FilePanelController filePanel={NotesFilePanel} floatingUIOptions={fast} />
        <PendingComment editor={editor} me={me} />
      </BlockNoteView>
    </NotesEnvContext>
  );
}

function PendingComment({ editor, me }: { editor: NotesEditor; me: Me }) {
  const pending = useExtensionState(CommentsExtension, { editor, selector: (s) => s.pendingComment });
  const comments = editor.getExtension(CommentsExtension);
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (pending) setRect(editor.getSelectionBoundingBox() ?? null);
    else setRect(null);
  }, [pending]);
  if (!pending || !rect || !comments) return null;
  const quote = editor.getSelectedText();
  return (
    <Popover anchor={rect} placement="bottom-start" offset={8} width={360} onClose={() => comments.stopPendingComment()}>
      <div className="n-floating-composer">
        <Composer
          me={me}
          autoFocus
          placeholder="Add a comment…"
          onCancel={() => comments.stopPendingComment()}
          onSubmit={(text) => {
            void comments.createThread({ initialComment: { body: commentBody(text), metadata: { name: me.name, color: me.color } }, metadata: { quote } }).then(() => comments.stopPendingComment());
          }}
        />
      </div>
    </Popover>
  );
}

export const notesTheme = {
  colors: {
    editor: { text: "var(--n-text)", background: "transparent" },
    menu: { text: "var(--n-text)", background: "var(--n-panel-solid)" },
    tooltip: { text: "var(--n-tooltip-text)", background: "var(--n-tooltip)" },
    hovered: { text: "var(--n-text)", background: "var(--n-hover)" },
    selected: { text: "var(--n-on-accent)", background: "var(--n-form-accent)" },
    disabled: { text: "var(--n-text-3)", background: "transparent" },
    shadow: "transparent",
    border: "var(--n-panel-border)",
    sideMenu: "var(--n-text-3)",
    highlights: {
      gray: { text: "var(--n-gray)", background: "var(--n-gray-bg)" },
      brown: { text: "var(--n-brown)", background: "var(--n-brown-bg)" },
      red: { text: "var(--n-red)", background: "var(--n-red-bg)" },
      orange: { text: "var(--n-orange)", background: "var(--n-orange-bg)" },
      yellow: { text: "var(--n-yellow)", background: "var(--n-yellow-bg)" },
      green: { text: "var(--n-green)", background: "var(--n-green-bg)" },
      blue: { text: "var(--n-blue)", background: "var(--n-blue-bg)" },
      purple: { text: "var(--n-purple)", background: "var(--n-purple-bg)" },
      pink: { text: "var(--n-pink)", background: "var(--n-pink-bg)" },
    },
  },
  borderRadius: 6,
  fontFamily: "var(--n-page-font)",
};

export { selectBlocks };
