import { useState } from "react";
import { childrenOf } from "../../shared/model";
import type { WorkspaceInfo } from "../../shared/protocol";
import { useApp } from "../app/context";
import { Icon } from "../ui/icons";
import { Popover } from "../ui/Popover";
import { toast } from "../ui/toast";

export function WorkspaceTile({ workspace, size = 20 }: { workspace: Pick<WorkspaceInfo, "name" | "icon" | "shared">; size?: number }) {
  return (
    <span className={`n-ws-tile${workspace.shared ? " is-shared" : ""}`} style={{ width: size, height: size, fontSize: workspace.icon ? size * 0.75 : size * 0.55 }} aria-hidden="true">
      {workspace.icon || (workspace.name.trim()[0] ?? "N").toUpperCase()}
    </span>
  );
}

export function NameForm({ title, placeholder, action, onSubmit, onCancel, note }: { title: string; placeholder: string; action: string; onSubmit: (name: string) => void; onCancel: () => void; note?: string }) {
  const [name, setName] = useState("");
  return (
    <form
      className="n-name-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit(name.trim());
      }}
    >
      <div className="n-name-form-title">{title}</div>
      {note ? <div className="n-muted">{note}</div> : null}
      <input className="n-input" autoFocus placeholder={placeholder} value={name} onChange={(e) => setName(e.target.value)} aria-label={placeholder} data-testid="workspace-name" />
      <div className="n-row-buttons">
        <button type="button" className="n-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="n-button is-primary" disabled={!name.trim()}>
          {action}
        </button>
      </div>
    </form>
  );
}

export function WorkspaceMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const app = useApp();
  const [mode, setMode] = useState<"list" | "create-shared" | "create-private">("list");
  const active = app.workspaces.find((w) => w.id === app.activeWorkspace);
  const switchTo = (w: WorkspaceInfo) => {
    app.setActiveWorkspace(w.id);
    const tree = app.trees.get(w.id);
    const first = tree ? childrenOf(tree, "").find((p) => !p.isTemplate) : null;
    if (first) app.openPage(first.id, { workspace: w.id });
    else app.navigate("/home");
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={300} label="Workspaces">
      {mode === "list" ? (
        <div className="n-menu" data-testid="workspace-menu">
          <div className="n-menu-heading">{app.me.name || "You"}</div>
          {app.workspaces.filter((w) => !w.pageShare).map((w) => (
            <button key={w.id} type="button" className="n-menu-item" data-testid="workspace-item" onClick={() => switchTo(w)}>
              <span className="n-menu-icon">
                <WorkspaceTile workspace={w} />
              </span>
              <span className="n-menu-label">
                {w.name}
                <span className="n-menu-detail">{w.shared ? (w.state === "ready" ? "Shared · iCloud Drive" : w.state === "downloading" ? `Downloading ${w.waiting} files…` : w.state === "missing" ? "Folder missing" : "Loading…") : "Private · on this Mac"}</span>
              </span>
              {w.id === app.activeWorkspace ? <Icon name="check" className="n-menu-check" /> : null}
            </button>
          ))}
          <div className="n-menu-sep" />
          <button type="button" className="n-menu-item" data-testid="ws-create-shared" onClick={() => setMode("create-shared")}>
            <span className="n-menu-icon">
              <Icon name="people" />
            </span>
            <span className="n-menu-label">Create shared workspace…</span>
          </button>
          <button
            type="button"
            className="n-menu-item"
            data-testid="ws-join"
            onClick={async () => {
              onClose();
              const joined = await app.client.call("joinSharedWorkspace", {});
              if (joined) {
                app.setActiveWorkspace(joined.id);
                toast(`Joined ${joined.name}`);
              }
            }}
          >
            <span className="n-menu-icon">
              <Icon name="folder" />
            </span>
            <span className="n-menu-label">Join shared workspace…</span>
          </button>
          {active?.shared ? (
            <button
              type="button"
              className="n-menu-item"
              data-testid="ws-share"
              onClick={async () => {
                onClose();
                const { ok } = await app.client.call("shareWorkspace", { workspace: active.id });
                if (ok) toast("Opened sharing for this workspace");
              }}
            >
              <span className="n-menu-icon">
                <Icon name="share" />
              </span>
              <span className="n-menu-label">Share workspace…</span>
            </button>
          ) : null}
          <button type="button" className="n-menu-item" onClick={() => setMode("create-private")}>
            <span className="n-menu-icon">
              <Icon name="plus" />
            </span>
            <span className="n-menu-label">New private workspace…</span>
          </button>
          <div className="n-menu-sep" />
          <button
            type="button"
            className="n-menu-item"
            onClick={() => {
              onClose();
              app.navigate("/settings");
            }}
          >
            <span className="n-menu-icon">
              <Icon name="settings" />
            </span>
            <span className="n-menu-label">Settings</span>
          </button>
        </div>
      ) : (
        <NameForm
          title={mode === "create-shared" ? "Create a shared workspace" : "Create a private workspace"}
          note={mode === "create-shared" ? "It lives in iCloud Drive › Ardia Shared. Share the folder with people to work on it together." : "It stays on this Mac."}
          placeholder="Workspace name"
          action="Create"
          onCancel={() => setMode("list")}
          onSubmit={async (name) => {
            onClose();
            const created = mode === "create-shared" ? await app.client.call("createSharedWorkspace", { name }) : await app.client.call("createWorkspace", { name });
            if (created) {
              app.setActiveWorkspace(created.id);
              toast(`Created ${created.name}`);
            }
          }}
        />
      )}
    </Popover>
  );
}
