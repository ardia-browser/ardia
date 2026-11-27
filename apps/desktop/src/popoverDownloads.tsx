import type { DownloadsAction, DownloadsRow } from "./nativeDownloads";
import type { PopoverProps } from "./popoverSurface";

type RouteProps = { props: PopoverProps; send(message: unknown): void; close(): void };

const ACTION_TITLES: Record<Exclude<DownloadsAction, "open">, string> = {
  reveal: "Show",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel",
  keep: "Keep",
  discard: "Discard",
};

const textOf = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);

function rowsOf(props: PopoverProps): DownloadsRow[] {
  return (Array.isArray(props.rows) ? props.rows : []).flatMap((raw): DownloadsRow[] => {
    const row = raw as Partial<DownloadsRow> | null;
    if (!row || typeof row.id !== "string") return [];
    const actions = (Array.isArray(row.actions) ? row.actions : []).filter((action): action is DownloadsAction => action === "open" || action in ACTION_TITLES);
    const progress = typeof row.progress === "number" && Number.isFinite(row.progress) ? Math.min(1, Math.max(0, row.progress)) : null;
    return [{ id: row.id, title: textOf(row.title, "Preparing…"), status: textOf(row.status), warning: row.warning === true, missing: row.missing === true, progress, paused: row.paused === true, actions }];
  });
}

export function DownloadsPopoverRoute({ props, send }: RouteProps) {
  const rows = rowsOf(props);
  const reveal = textOf(props.revealTitle, "Show");
  return (
    <div className="ardia-popover-downloads" data-ardia-dark={props.dark === true ? "true" : "false"}>
      <div className="ardia-popover-downloads-header">
        <span>RECENT DOWNLOADS</span>
        {props.clearable === true ? (
          <button type="button" className="ardia-popover-text-button" onClick={() => send({ type: "clear" })}>
            Clear
          </button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <div className="ardia-popover-downloads-empty">No downloads yet</div>
      ) : (
        <div className="ardia-popover-downloads-list" role="list">
          {rows.map((row) => (
            <div key={row.id} role="listitem" className="ardia-popover-download" data-missing={row.missing ? "true" : "false"}>
              <button
                type="button"
                className="ardia-popover-download-main"
                disabled={!row.actions.includes("open")}
                onClick={() => send({ type: "action", action: "open", id: row.id })}
              >
                <span className="ardia-popover-download-title">{row.title}</span>
                {row.progress !== null ? (
                  <span className="ardia-popover-download-track" data-paused={row.paused ? "true" : "false"}>
                    <span style={{ width: `${row.progress * 100}%` }} />
                  </span>
                ) : null}
                <span className="ardia-popover-download-status" data-warning={row.warning ? "true" : "false"}>{row.status}</span>
              </button>
              {row.actions.filter((action) => action !== "open").map((action) => (
                <button
                  key={action}
                  type="button"
                  className="ardia-popover-text-button"
                  title={action === "reveal" ? reveal : ACTION_TITLES[action as Exclude<DownloadsAction, "open">]}
                  onClick={() => send({ type: "action", action, id: row.id })}
                >
                  {ACTION_TITLES[action as Exclude<DownloadsAction, "open">]}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="ardia-popover-separator" />
      <button type="button" className="ardia-popover-row" onClick={() => send({ type: "viewAll" })}>
        View all downloads
      </button>
    </div>
  );
}
