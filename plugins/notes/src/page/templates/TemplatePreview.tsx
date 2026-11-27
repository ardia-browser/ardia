import { useEffect, useMemo, useState } from "react";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import { templateById } from "../../shared/templates";
import { AppContext, useApp, type AppApi } from "../app/context";
import type { Route } from "../app/route";
import { PageBody } from "../view/PageBody";
import { PREVIEW_WORKSPACE, previewClient, sandboxFromPage, sandboxFromTemplate, type Sandbox } from "./sandbox";

export type PreviewSource = { kind: "builtin"; id: string } | { kind: "page"; workspace: WorkspaceId; page: PageId; row?: boolean };

export const previewKey = (source: PreviewSource) => (source.kind === "builtin" ? `builtin:${source.id}` : `${source.workspace}:${source.page}`);

function useSandbox(source: PreviewSource): Sandbox | null {
  const app = useApp();
  const [box, setBox] = useState<Sandbox | null>(null);
  const key = previewKey(source);
  useEffect(() => {
    let live = true;
    let made: Sandbox | null = null;
    setBox(null);
    if (source.kind === "builtin") {
      const spec = templateById(source.id);
      if (spec) {
        made = sandboxFromTemplate(spec, app.me);
        setBox(made);
      }
    } else {
      const tree = app.trees.get(source.workspace);
      if (tree)
        void sandboxFromPage(app.client, source.workspace, tree, source.page, { withParent: source.row }).then((b) => {
          if (live) setBox((made = b));
          else b.destroy();
        });
    }
    return () => {
      live = false;
      made?.destroy();
    };
  }, [key]);
  return box;
}

export function TemplatePreview({ source }: { source: PreviewSource }) {
  const box = useSandbox(source);
  if (!box) return <div className="n-gallery-preview-loading" aria-busy="true" data-testid="template-preview-loading" />;
  return <SandboxView key={previewKey(source)} box={box} />;
}

function SandboxView({ box }: { box: Sandbox }) {
  const app = useApp();
  const client = useMemo(() => previewClient(app.client, box), [app.client, box]);
  useEffect(() => () => client.dispose(), [client]);
  const [route, setRoute] = useState<Route>({ kind: "page", page: box.root, block: null, view: null, peek: null });
  const trees = useMemo(() => new Map([[PREVIEW_WORKSPACE, box.tree]]), [box]);
  const api: AppApi = {
    ...app,
    client,
    trees,
    presence: [],
    route,
    activeWorkspace: PREVIEW_WORKSPACE,
    workspaceOf: () => PREVIEW_WORKSPACE,
    treeOf: (id) => (id === PREVIEW_WORKSPACE ? box.tree : null),
    openPage: (page, options = {}) => {
      if (page !== box.root) return;
      setRoute({ kind: "page", page, block: null, view: options.view ?? null, peek: options.peek ?? null });
    },
    navigate: () => {},
    newPage: async () => null,
    duplicate: async () => null,
    move: async () => null,
    archive: async () => {},
    restore: async () => {},
    deleteForever: async () => {},
    favorites: [],
    isFavorite: () => false,
    toggleFavorite: () => {},
    copyLink: () => {},
    moveDialog: () => {},
  };
  return (
    <AppContext value={api}>
      <div className="n-gallery-preview-page" data-testid="template-preview" data-root={box.root}>
        <PageBody workspace={PREVIEW_WORKSPACE} page={box.root} embedded composingComment={false} setComposingComment={() => {}} />
      </div>
    </AppContext>
  );
}
