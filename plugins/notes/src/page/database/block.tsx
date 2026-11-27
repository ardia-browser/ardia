import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import { treeDocId } from "../../shared/protocol";
import { createPage, type PageMeta } from "../../shared/model";
import { VIEW_TYPES, initLinkedDatabase, readSchema, type ViewType } from "../../shared/database";
import type { NotesClient } from "../client/types";
import { useOptionalNotesEnv } from "../editor/env";
import { DatabasePage } from "./DatabasePage";
import { databasesIn, rowStore, useDoc, useRowStore } from "./data";
import { Icon } from "./icons";
import { Menu, MenuItem, MenuLabel } from "./ui";
import { registerCss } from "./styles";
import { pageDocId } from "../../shared/protocol";

export type DatabaseHostValue = {
  client?: NotesClient;
  workspace?: WorkspaceId;
  onOpenRow?: (row: PageId, mode: "peek" | "full") => void;
  renderBody?: (row: PageMeta) => ReactNode;
};

export const DatabaseHostContext = createContext<DatabaseHostValue | null>(null);
export const DatabaseHost = DatabaseHostContext.Provider;

const blockDbId = (blockId: string) => {
  const hex = blockId.replace(/[^0-9a-f]/gi, "").toLowerCase();
  return (hex + "000000000000").slice(0, 12);
};

function DatabaseBlockView({ block, editor }: { block: { id: string; props: { workspace: string; database: string; view: string } }; editor: { updateBlock: (b: unknown, update: unknown) => void; isEditable: boolean } }) {
  const env = useOptionalNotesEnv();
  const host = use(DatabaseHostContext);
  const client = host?.client ?? env?.client;
  const workspace = block.props.workspace || host?.workspace || env?.workspace || "";
  const [linking, setLinking] = useState(false);
  if (!client || !workspace) return <div className="db-root db-block-missing">Database unavailable</div>;
  const setProps = (props: Partial<typeof block.props>) => editor.updateBlock(block, { props });
  const onOpenRow = (row: PageId, mode: "peek" | "full") => {
    host?.onOpenRow?.(row, mode);
    if (mode === "full" && !host?.onOpenRow) env?.openPage(row);
  };
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="db-block" contentEditable={false} suppressContentEditableWarning onKeyDown={stop} onKeyUp={stop} onPaste={stop} onCopy={stop} onCut={stop} onBeforeInput={stop} data-testid="db-block">
      {block.props.database ? (
        <DatabasePage
          client={client}
          workspace={workspace}
          page={block.props.database}
          view={block.props.view || null}
          inline
          onView={(view) => setProps({ view })}
          onOpenRow={onOpenRow}
          {...(host?.renderBody ? { renderBody: host.renderBody } : {})}
        />
      ) : linking || block.props.view === "link" ? (
        <LinkPicker client={client} workspace={workspace} parent={env?.page ?? ""} blockId={block.id} onLinked={(database) => setProps({ database, view: "" })} />
      ) : (
        <AutoCreate client={client} workspace={workspace} parent={env?.page ?? ""} blockId={block.id} type={VIEW_TYPES.some((t) => t.type === block.props.view) ? (block.props.view as ViewType) : "table"} onCreated={(database) => setProps({ database })} onLink={() => setLinking(true)} />
      )}
    </div>
  );
}

function AutoCreate({ client, workspace, parent, blockId, type, onCreated, onLink }: { client: NotesClient; workspace: WorkspaceId; parent: PageId; blockId: string; type: ViewType; onCreated: (id: PageId) => void; onLink: () => void }) {
  const tree = useDoc(client, workspace, treeDocId);
  const done = useRef(false);
  useEffect(() => {
    if (!tree.doc || !tree.synced || done.current) return;
    done.current = true;
    const id = blockDbId(blockId);
    if (!rowStore(tree.doc).pages.has(id)) createPage(tree.doc, { id, parent, kind: "database", title: "", props: { initialView: type, inline: true }, by: client.me().deviceId });
    onCreated(id);
  }, [tree.doc, tree.synced]);
  return (
    <div className="db-root db-block-placeholder">
      <Icon name="database" size={16} /> Creating database…
      <button type="button" className="db-link-btn" onClick={onLink}>
        Link existing instead
      </button>
    </div>
  );
}

function LinkPicker({ client, workspace, parent, blockId, onLinked }: { client: NotesClient; workspace: WorkspaceId; parent: PageId; blockId: string; onLinked: (id: PageId) => void }) {
  const tree = useDoc(client, workspace, treeDocId);
  const { store } = useRowStore(tree.doc);
  const [q, setQ] = useState("");
  const list = useMemo(() => (store ? databasesIn(store).filter((d) => (d.title || "Untitled").toLowerCase().includes(q.toLowerCase())) : []), [store, q]);
  const link = async (source: PageId) => {
    if (!tree.doc) return;
    const id = createLinkedDatabaseIn(tree.doc, client, workspace, parent, source, blockDbId(blockId));
    onLinked(await id);
  };
  return (
    <div className="db-root db-link-picker" data-testid="db-link-picker">
      <Menu autoFocus={false}>
        <MenuLabel>Link to a database</MenuLabel>
        <div className="db-menu-pad">
          <input className="db-input" autoFocus placeholder="Search for a database…" value={q} onChange={(e) => setQ(e.target.value)} data-testid="db-link-search" />
        </div>
        {list.map((d) => (
          <MenuItem key={d.id} icon={d.icon && !d.icon.startsWith("file:") ? <span>{d.icon}</span> : "database"} label={d.title || "Untitled"} testId="db-link-option" onSelect={() => void link(d.id)} />
        ))}
        {!list.length && <div className="db-empty-note">No databases yet</div>}
      </Menu>
    </div>
  );
}

async function createLinkedDatabaseIn(tree: import("yjs").Doc, client: NotesClient, workspace: WorkspaceId, parent: PageId, source: PageId, id?: PageId): Promise<PageId> {
  const page = createPage(tree, { ...(id ? { id } : {}), parent, kind: "database", title: "", props: { linkedSource: source, inline: true }, by: client.me().deviceId });
  const open = client.open(workspace, pageDocId(page));
  const sourceDoc = client.open(workspace, pageDocId(source));
  await Promise.all([open.synced, sourceDoc.synced]);
  initLinkedDatabase(open.doc, source, "table", readSchema(sourceDoc.doc));
  setTimeout(() => {
    open.release();
    sourceDoc.release();
  }, 2000);
  return page;
}

export async function createLinkedDatabase(client: NotesClient, workspace: WorkspaceId, parent: PageId, source: PageId): Promise<PageId> {
  const tree = client.open(workspace, treeDocId);
  await tree.synced;
  try {
    return await createLinkedDatabaseIn(tree.doc, client, workspace, parent, source);
  } finally {
    setTimeout(() => tree.release(), 2000);
  }
}

export async function createDatabase(client: NotesClient, workspace: WorkspaceId, parent: PageId | "", options: { view?: ViewType; title?: string; inline?: boolean } = {}): Promise<PageId> {
  const tree = client.open(workspace, treeDocId);
  await tree.synced;
  try {
    return createPage(tree.doc, { parent, kind: "database", title: options.title ?? "", props: { initialView: options.view ?? "table", inline: options.inline === true }, by: client.me().deviceId });
  } finally {
    setTimeout(() => tree.release(), 2000);
  }
}

export const databaseBlockSpec = createReactBlockSpec(
  {
    type: "database",
    propSchema: {
      workspace: { default: "" },
      database: { default: "" },
      view: { default: "" },
    },
    content: "none",
  },
  {
    render: (p) => <DatabaseBlockView block={p.block as never} editor={p.editor as never} />,
  },
);

registerCss(
  "block",
  `
.db-block { width: 100%; padding: 4px 0 8px; user-select: text; }
.db-block-placeholder, .db-block-missing { display: flex; align-items: center; gap: 8px; height: 40px; color: var(--n-text-3); font-size: var(--n-t-body, 13px); }
.db-link-picker { max-width: 360px; border-radius: var(--n-r-panel, 12px); background: var(--n-glass); -webkit-backdrop-filter: var(--n-glass-filter); backdrop-filter: var(--n-glass-filter); box-shadow: var(--n-glass-edge), var(--n-shadow); }
`,
);
