import { useEffect, useState, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { ArdiaHost } from "./host";
import { reportHostError } from "./host";
import { DownloadsPopoverRoute } from "./popoverDownloads";
import { popoverChannel, type PopoverBoot, type PopoverChannel, type PopoverProps } from "./popoverSurface";

export const POPOVER_SURFACE_CLASS = "ardia-popover-surface";

export type PopoverRouteProps = { props: PopoverProps; send(message: unknown): void; close(): void };

type ListRow = { id: string; title: string; detail?: string; enabled?: boolean };

const rowsOf = (props: PopoverProps): ListRow[] =>
  (Array.isArray(props.items) ? props.items : []).flatMap((row): ListRow[] => {
    const item = row as Partial<ListRow> | null;
    if (!item || typeof item.id !== "string" || typeof item.title !== "string") return [];
    return [{ id: item.id, title: item.title, detail: typeof item.detail === "string" ? item.detail : undefined, enabled: item.enabled !== false }];
  });

function ListPopover({ props, send, close }: PopoverRouteProps) {
  const rows = rowsOf(props);
  const heading = typeof props.title === "string" ? props.title : null;
  return (
    <div className="ardia-popover-list" role="menu" aria-label={heading ?? undefined}>
      {heading ? <div className="ardia-popover-heading">{heading}</div> : null}
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          role="menuitem"
          className="ardia-popover-row"
          disabled={!row.enabled}
          onClick={() => {
            send({ type: "pick", id: row.id });
            close();
          }}
        >
          <span className="ardia-popover-row-title">{row.title}</span>
          {row.detail ? <span className="ardia-popover-row-detail">{row.detail}</span> : null}
        </button>
      ))}
    </div>
  );
}

export const POPOVER_ROUTES: Readonly<Record<string, ComponentType<PopoverRouteProps>>> = { list: ListPopover, downloads: DownloadsPopoverRoute };

export function PopoverRoot({ boot, channel, routes = POPOVER_ROUTES }: { boot: PopoverBoot; channel: PopoverChannel; routes?: Readonly<Record<string, ComponentType<PopoverRouteProps>>> }) {
  const [props, setProps] = useState(boot.props);
  const Route = Object.hasOwn(routes, boot.route) ? routes[boot.route] : undefined;
  useEffect(() => {
    const stop = channel.onProps(setProps);
    channel.props().then((latest) => latest && setProps(latest), reportHostError);
    return stop;
  }, [channel]);
  useEffect(() => {
    if (!Route) void channel.close().catch(reportHostError);
  }, [Route, channel]);
  if (!Route) return null;
  return (
    <Route
      props={props}
      send={(message) => void channel.send(message).catch(reportHostError)}
      close={() => void channel.close().catch(reportHostError)}
    />
  );
}

export function startPopover(host: ArdiaHost, boot: PopoverBoot) {
  document.documentElement.classList.add(POPOVER_SURFACE_CLASS);
  const root = document.getElementById("root");
  if (!root) throw new Error("The popover surface has no root");
  root.dataset.ardiaPopover = boot.route;
  createRoot(root).render(<PopoverRoot boot={boot} channel={popoverChannel(host, boot)} />);
}
