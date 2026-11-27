import { createReactBlockSpec, createReactInlineContentSpec, useEditorChange } from "@blocknote/react";
import { defaultProps, type BlockNoteEditor } from "@blocknote/core";
import { useState } from "react";
import { ancestorsOf, displayTitle, isArchivedDeep } from "../../../shared/model";
import { useAllPages, usePageMeta, useTreeVersion } from "../../app/hooks";
import { Icon, PageIcon } from "../../ui/icons";
import { Popover } from "../../ui/Popover";
import { flashElement } from "../../ui/flash";
import { EmojiPicker } from "../../ui/EmojiPicker";
import { useOptionalNotesEnv } from "../env";
import { useFileIcon } from "../../app/files";

function PageLink({ pageId, variant }: { pageId: string; variant: "subpage" | "link" }) {
  const env = useOptionalNotesEnv();
  const page = usePageMeta(env?.tree, pageId);
  const version = useTreeVersion(env?.tree);
  const resolveIcon = useFileIcon(env?.client ?? null, env?.workspace ?? "");
  void version;
  const gone = !page || (env ? isArchivedDeep(env.tree, pageId) : false);
  return (
    <div
      className={`n-pageblock${gone ? " is-gone" : ""}`}
      contentEditable={false}
      role="link"
      data-page-id={pageId}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        if (!page || !env) return;
        env.openPage(pageId, { newTab: e.metaKey });
      }}
    >
      <span className="n-pageblock-icon">
        <PageIcon icon={page?.icon ?? ""} size={18} fallback={page?.kind === "database" ? "database" : "page"} resolveFile={resolveIcon} />
        {variant === "link" ? <Icon name="arrowUpRight" size={10} className="n-pageblock-arrow" strokeWidth={2} /> : null}
      </span>
      <span className="n-pageblock-title">{page ? displayTitle(page) : "Page not found"}</span>
      {gone && page ? <span className="n-pageblock-note">In Trash</span> : null}
    </div>
  );
}

export const subpageBlock = createReactBlockSpec(
  { type: "subpage", propSchema: { pageId: { default: "" } }, content: "none" },
  {
    meta: { selectable: true },
    render: ({ block }) => <PageLink pageId={block.props.pageId} variant="subpage" />,
    toExternalHTML: ({ block }) => <a href={`ardia://notes/${block.props.pageId}`}>{block.props.pageId}</a>,
  },
);

export const linkToPageBlock = createReactBlockSpec(
  { type: "linkToPage", propSchema: { pageId: { default: "" } }, content: "none" },
  {
    meta: { selectable: true },
    render: ({ block, editor }) => (block.props.pageId ? <PageLink pageId={block.props.pageId} variant="link" /> : <PagePickerBlock onPick={(id) => editor.updateBlock(block, { props: { pageId: id } })} />),
    toExternalHTML: ({ block }) => <a href={`ardia://notes/${block.props.pageId}`}>{block.props.pageId}</a>,
  },
);

function PagePickerBlock({ onPick }: { onPick: (id: string) => void }) {
  const env = useOptionalNotesEnv();
  const pages = useAllPages(env?.tree).filter((p) => env && !isArchivedDeep(env.tree, p.id) && p.id !== env.page);
  const [query, setQuery] = useState("");
  const shown = pages.filter((p) => displayTitle(p).toLowerCase().includes(query.toLowerCase())).slice(0, 8);
  return (
    <div className="n-pagepicker" contentEditable={false}>
      <input placeholder="Search for a page to link…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      {shown.map((p) => (
        <button key={p.id} type="button" className="n-menu-item" onClick={() => onPick(p.id)}>
          <span className="n-menu-icon">
            <PageIcon icon={p.icon} />
          </span>
          <span className="n-menu-label">{displayTitle(p)}</span>
        </button>
      ))}
    </div>
  );
}

function hostOf(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function UrlCard({ url, kind, onSet }: { url: string; kind: "bookmark" | "embed"; onSet: (url: string) => void }) {
  const env = useOptionalNotesEnv();
  const [draft, setDraft] = useState("");
  if (!url) {
    return (
      <form
        className="n-urlprompt"
        contentEditable={false}
        onSubmit={(e) => {
          e.preventDefault();
          const value = draft.trim();
          if (value) onSet(/^[a-z]+:/i.test(value) ? value : `https://${value}`);
        }}
      >
        <Icon name={kind === "bookmark" ? "bookmark" : "embed"} />
        <input autoFocus placeholder={kind === "bookmark" ? "Paste in https://…" : "Paste in a link to embed"} value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="n-button is-primary">
          {kind === "bookmark" ? "Create bookmark" : "Embed link"}
        </button>
      </form>
    );
  }
  return (
    <div
      className={`n-urlcard is-${kind}`}
      contentEditable={false}
      role="link"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => env?.openUrl(url)}
    >
      <div className="n-urlcard-text">
        <div className="n-urlcard-title">{kind === "embed" ? `Embedded page · ${hostOf(url)}` : hostOf(url)}</div>
        <div className="n-urlcard-desc">{kind === "embed" ? "Embeds open in a browser tab — Notes pages stay offline." : "Bookmark"}</div>
        <div className="n-urlcard-url">
          <Icon name="globe" size={12} />
          {url}
        </div>
      </div>
      <div className="n-urlcard-thumb">
        <Icon name={kind === "embed" ? "embed" : "link"} size={22} />
      </div>
    </div>
  );
}

export const bookmarkBlock = createReactBlockSpec(
  { type: "bookmark", propSchema: { url: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => <UrlCard url={block.props.url} kind="bookmark" onSet={(url) => editor.updateBlock(block, { props: { url } })} />,
    toExternalHTML: ({ block }) => <a href={block.props.url}>{block.props.url}</a>,
  },
);

export const embedBlock = createReactBlockSpec(
  { type: "embed", propSchema: { url: { default: "" } }, content: "none" },
  {
    render: ({ block, editor }) => <UrlCard url={block.props.url} kind="embed" onSet={(url) => editor.updateBlock(block, { props: { url } })} />,
    toExternalHTML: ({ block }) => <a href={block.props.url}>{block.props.url}</a>,
  },
);

type HeadingEntry = { id: string; level: number; text: string };

function headingsOf(editor: BlockNoteEditor<any, any, any>): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  const walk = (blocks: any[]) => {
    for (const block of blocks) {
      if (block.type === "heading") {
        const text = (block.content ?? []).map((c: any) => (typeof c.text === "string" ? c.text : (c.content ?? []).map((t: any) => t.text ?? "").join(""))).join("");
        if (text.trim()) out.push({ id: block.id, level: block.props.level, text });
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(editor.document);
  return out;
}

function TableOfContents({ editor }: { editor: BlockNoteEditor<any, any, any> }) {
  const [headings, setHeadings] = useState(() => headingsOf(editor));
  useEditorChange(() => setHeadings(headingsOf(editor)), editor);
  if (!headings.length) return <div className="n-toc is-empty" contentEditable={false}>Add headings to create a table of contents.</div>;
  const min = Math.min(...headings.map((h) => h.level));
  return (
    <div className="n-toc" contentEditable={false}>
      {headings.map((h) => (
        <button
          key={h.id}
          type="button"
          className="n-toc-row"
          style={{ paddingLeft: 2 + (h.level - min) * 24 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = document.querySelector(`.n-editor .bn-block-outer[data-id="${h.id}"]`);
            if (el) flashElement(el, 1200);
          }}
        >
          {h.text}
        </button>
      ))}
    </div>
  );
}

export const tocBlock = createReactBlockSpec(
  { type: "toc", propSchema: { textColor: defaultProps.textColor }, content: "none" },
  { render: ({ editor }) => <TableOfContents editor={editor} /> },
);

function Breadcrumb() {
  const env = useOptionalNotesEnv();
  const version = useTreeVersion(env?.tree);
  void version;
  const page = usePageMeta(env?.tree, env?.page);
  if (!env || !page) return null;
  const trail = [...ancestorsOf(env.tree, page.id), page];
  return (
    <div className="n-breadcrumb-block" contentEditable={false}>
      {trail.map((p, i) => (
        <span key={p.id} className="n-crumb-wrap">
          {i ? <span className="n-crumb-sep">/</span> : null}
          <button type="button" className="n-crumb" onMouseDown={(e) => e.preventDefault()} onClick={() => env.openPage(p.id)}>
            <PageIcon icon={p.icon} size={14} />
            {displayTitle(p)}
          </button>
        </span>
      ))}
    </div>
  );
}

export const breadcrumbBlock = createReactBlockSpec({ type: "breadcrumb", propSchema: {}, content: "none" }, { render: () => <Breadcrumb /> });

function CalloutIcon({ icon, onChange }: { icon: string; onChange: (icon: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const env = useOptionalNotesEnv();
  const resolveFile = useFileIcon(env?.client ?? null, env?.workspace ?? "");
  return (
    <>
      <button type="button" className="n-callout-icon" contentEditable={false} onMouseDown={(e) => e.preventDefault()} onClick={(e) => setAnchor(e.currentTarget)}>
        {icon.startsWith("file:") ? <PageIcon icon={icon} size={18} resolveFile={resolveFile} /> : icon || "💡"}
      </button>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} width={408}>
          <EmojiPicker
            onPick={(emoji) => {
              onChange(emoji);
              setAnchor(null);
            }}
            onRemove={() => {
              onChange("💡");
              setAnchor(null);
            }}
          />
        </Popover>
      ) : null}
    </>
  );
}

export const calloutBlock = createReactBlockSpec(
  { type: "callout", propSchema: { textColor: defaultProps.textColor, backgroundColor: defaultProps.backgroundColor, icon: { default: "💡" } }, content: "inline" },
  {
    render: ({ block, editor, contentRef }) => (
      <div className="n-callout">
        <CalloutIcon icon={block.props.icon} onChange={(icon) => editor.updateBlock(block, { props: { icon } })} />
        <div className="n-callout-text" ref={contentRef} />
      </div>
    ),
    toExternalHTML: ({ block, contentRef }) => (
      <aside>
        <span>{block.props.icon}</span> <span ref={contentRef} />
      </aside>
    ),
  },
);

export const columnListBlock = createReactBlockSpec(
  { type: "columnList", propSchema: {}, content: "none", layoutOnly: true, children: { allow: ["column"], min: 2 } },
  { renderFrame: ({ slotRef }) => <div className="n-columns" ref={slotRef} /> },
);

export const columnBlock = createReactBlockSpec(
  { type: "column", propSchema: { width: { default: 1 } }, content: "none", layoutOnly: true, placeable: "namedOnly", children: { allow: "blocks", exclude: ["columnList"] } },
  { renderFrame: ({ block, slotRef }) => <div className="n-column" style={{ flexGrow: block.props.width }} ref={slotRef} /> },
);

function personInitial(name: string) {
  return (name.trim()[0] ?? "?").toUpperCase();
}

function formatMentionDate(iso: string) {
  const date = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(date.getTime())) return iso;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function MentionView({ kind, pageId, name, color, date }: { kind: string; pageId: string; name: string; color: string; date: string }) {
  const env = useOptionalNotesEnv();
  const page = usePageMeta(env?.tree, kind === "page" ? pageId : null);
  const resolveIcon = useFileIcon(env?.client ?? null, env?.workspace ?? "");
  if (kind === "page") {
    return (
      <span
        className="n-mention is-page"
        data-page-id={pageId}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => page && env?.openPage(pageId, { newTab: e.metaKey })}
      >
        <PageIcon icon={page?.icon ?? ""} size={15} resolveFile={resolveIcon} />
        <span className="n-mention-title">{page ? displayTitle(page) : "Untitled"}</span>
      </span>
    );
  }
  if (kind === "user") {
    return (
      <span className="n-mention is-user">
        <span className="n-mention-at">@</span>
        {name}
        <span className="n-avatar-dot" style={{ background: color || "var(--n-accent)" }} aria-hidden="true">
          {personInitial(name)}
        </span>
      </span>
    );
  }
  return (
    <span className="n-mention is-date">
      <span className="n-mention-at">@</span>
      {formatMentionDate(date)}
    </span>
  );
}

export const mentionInline = createReactInlineContentSpec(
  {
    type: "mention",
    propSchema: { kind: { default: "page", values: ["page", "user", "date"] }, pageId: { default: "" }, name: { default: "" }, color: { default: "" }, date: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent }) => <MentionView {...inlineContent.props} />,
    toExternalHTML: ({ inlineContent }) => <span>{inlineContent.props.kind === "page" ? `@${inlineContent.props.pageId}` : inlineContent.props.kind === "user" ? `@${inlineContent.props.name}` : `@${inlineContent.props.date}`}</span>,
  },
);
