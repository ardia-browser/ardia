import { createContext, jsx, type Renderable } from "./element";
import { useContext } from "./hooks";
import { errorNode, mountSurface, type HandlerTable, type SurfaceHandle } from "./reconciler";
import { HOST_METHODS, type PluginNode, type SurfaceMessage, type SurfaceMountMessage, type SurfaceKind } from "./protocol";
import type { Rpc } from "./rpc";
import type { Registry, ViewComponent, ViewProps } from "./types";

export type SurfaceInfo = {
  surfaceId: string;
  viewId: string;
  kind: SurfaceKind;
  context: Record<string, unknown>;
  close(): Promise<void>;
};

const SurfaceContext = createContext<SurfaceInfo | null>(null);

export function useSurface(): SurfaceInfo {
  const surface = useContext(SurfaceContext);
  if (!surface) throw new Error("useSurface only works inside a view the host mounted.");
  return surface;
}

function MissingView({ viewId }: ViewProps): Renderable {
  return jsx("EmptyState", {
    icon: "questionmark.square.dashed",
    title: "No view to show",
    description: `This plugin hasn't registered a view called ${viewId}.`,
    tone: "warning",
  });
}

type RootProps = { view: ViewComponent; surface: SurfaceInfo };

function SurfaceRoot({ view, surface }: RootProps): Renderable {
  const props: ViewProps = { surfaceId: surface.surfaceId, viewId: surface.viewId, kind: surface.kind, context: surface.context };
  return jsx(SurfaceContext.Provider, { value: surface, children: jsx(view, props) });
}

type SurfaceHost = {
  handle(message: SurfaceMessage): void;
  count(): number;
  tree(surfaceId: string): unknown;
  closeAll(): void;
};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

type MountedSurface = { handle: SurfaceHandle<RootProps>; handler(handlerId: string): ((...args: unknown[]) => unknown) | undefined };

const NO_HANDLERS: HandlerTable = new Map();

export function createSurfaceHost(rpc: Rpc, registry: Registry, report: (error: unknown) => void): SurfaceHost {
  const mounted = new Map<string, MountedSurface>();

  function unmount(surfaceId: string) {
    const entry = mounted.get(surfaceId);
    if (!entry) return;
    mounted.delete(surfaceId);
    entry.handle.unmount();
  }

  function mount(message: SurfaceMountMessage) {
    unmount(message.surfaceId);
    const surface: SurfaceInfo = {
      surfaceId: message.surfaceId,
      viewId: message.viewId,
      kind: message.kind,
      context: message.context ?? {},
      close: () => rpc.request(HOST_METHODS.surfaceClose, { surfaceId: message.surfaceId }).then(() => undefined),
    };
    const view = registry.views.get(message.viewId) ?? MissingView;
    let generation = 0;
    let acceptedGeneration = 0;
    let latest: HandlerTable = NO_HANDLERS;
    let shown: HandlerTable = NO_HANDLERS;
    const isCurrent = () => mounted.get(message.surfaceId)?.handle === handle;
    const sendTree = (tree: PluginNode, sent: number, handlers: HandlerTable) =>
      rpc.request(HOST_METHODS.surfaceRender, { surfaceId: message.surfaceId, tree }).then(() => {
        if (sent < acceptedGeneration) return;
        acceptedGeneration = sent;
        shown = handlers;
      });
    const commit = (tree: PluginNode, handlers: HandlerTable) => {
      const sent = ++generation;
      latest = handlers;
      sendTree(tree, sent, handlers).catch((error) => {
        report(error);
        if (sent !== generation || !isCurrent()) return;
        latest = NO_HANDLERS;
        sendTree(errorNode(error), sent, NO_HANDLERS).catch(report);
      });
    };
    const handle = mountSurface<RootProps>(SurfaceRoot, { view, surface }, commit, { onError: report });
    mounted.set(message.surfaceId, { handle, handler: (handlerId) => shown.get(handlerId) ?? latest.get(handlerId) });
  }

  function dispatch(surfaceId: string, handlerId: string, args: unknown[]) {
    const entry = mounted.get(surfaceId);
    if (!entry) return report(new Error(`An event arrived for ${surfaceId}, which isn't mounted.`));
    try {
      const handler = entry.handler(handlerId);
      if (!handler) throw new Error(`There's no handler ${handlerId}; the view re-rendered without it.`);
      const result = handler(...(Array.isArray(args) ? args : []));
      if (isThenable(result)) result.then(undefined, report);
    } catch (error) {
      report(error);
    }
  }

  return {
    handle(message) {
      if (message.surface === "mount") mount(message);
      else if (message.surface === "unmount") unmount(message.surfaceId);
      else dispatch(message.surfaceId, message.handlerId, message.args);
    },
    count: () => mounted.size,
    tree: (surfaceId) => mounted.get(surfaceId)?.handle.tree ?? null,
    closeAll() {
      for (const id of [...mounted.keys()]) unmount(id);
    },
  };
}
