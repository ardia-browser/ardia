import { useEffect, useRef, useState } from "react";
import { useApp } from "../app/context";
import { Icon } from "../ui/icons";
import { toast } from "../ui/toast";
import { MOTION, useFlip, useLeaveRef } from "../ui/motion";
import { SimpleTopbar } from "./MainView";
import { NameForm, WorkspaceTile } from "../sidebar/WorkspaceMenu";
import { openImportSheet } from "../import/importSheetStore";
import { replayOnboarding } from "../onboarding/state";

const COLORS = ["#C07A98", "#4691C3", "#7873AF", "#D37B8B", "#C1575C", "#D87249", "#E3AC38", "#3EB489", "#8E8E93"];

export function SettingsView() {
  const app = useApp();
  const [name, setName] = useState(app.me.name);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState<"shared" | "private" | null>(null);
  useEffect(() => setName(app.me.name), [app.me.name]);
  const spaces = useRef<HTMLElement>(null);
  useFlip(spaces, "[data-flip]", "data-flip", [app.workspaces.map((w) => w.id).join(), renaming, creating], { enter: true });
  const leave = useLeaveRef<HTMLDivElement>((el) => !app.workspaces.some((w) => w.id === el.dataset.flip), "is-row-leaving", MOTION.base);
  return (
    <div className="n-main-col is-entering">
      <SimpleTopbar title="Settings" icon="settings" />
      <div className="n-scroller">
        <div className="n-narrow n-settings" data-testid="settings">
          <h1 className="n-view-title">Settings</h1>
          <section className="n-group">
            <div className="n-group-title">Your profile</div>
            <div className="n-group-row">
              <div className="n-group-label">
                <div>Name</div>
                <div className="n-muted">Shown to people you share notes with.</div>
              </div>
              <input
                className="n-input"
                value={name}
                aria-label="Your name"
                data-testid="settings-name"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => name.trim() !== app.me.name && void app.client.call("setMe", { name: name.trim() })}
                onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
              />
            </div>
            <div className="n-group-row">
              <div className="n-group-label">
                <div>Colour</div>
                <div className="n-muted">Your cursor and avatar colour.</div>
              </div>
              <div className="n-swatches" role="radiogroup" aria-label="Colour">
                {COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={app.me.color.toLowerCase() === c.toLowerCase()} className="n-swatch" style={{ background: c }} onClick={() => void app.client.call("setMe", { color: c })} />
                ))}
              </div>
            </div>
          </section>
          <section className="n-group" ref={spaces}>
            <div className="n-group-title">Workspaces</div>
            {app.workspaces.map((w) => (
              <div key={w.id} ref={leave} data-flip={w.id} className="n-group-row" data-testid="settings-workspace">
                <div className="n-group-label is-inline">
                  <WorkspaceTile workspace={w} size={24} />
                  <div>
                    <div>{w.name}</div>
                    <div className="n-muted">{w.shared ? "Shared through iCloud Drive" : "Private, on this Mac"}</div>
                  </div>
                </div>
                <div className="n-row-buttons">
                  <button type="button" className="n-button is-small" onClick={() => setRenaming(w.id)}>
                    Rename
                  </button>
                  {w.shared ? (
                    <>
                      <button type="button" className="n-button is-small" onClick={() => void app.client.call("shareWorkspace", { workspace: w.id })}>
                        Share…
                      </button>
                      <button
                        type="button"
                        className="n-button is-small is-danger"
                        onClick={() => {
                          void app.client.call("leaveWorkspace", { workspace: w.id });
                          toast(`Left ${w.name}`);
                        }}
                      >
                        Leave
                      </button>
                    </>
                  ) : null}
                </div>
                {renaming === w.id ? (
                  <div className="n-inline-form">
                    <NameForm
                      title="Rename workspace"
                      placeholder={w.name}
                      action="Rename"
                      onCancel={() => setRenaming(null)}
                      onSubmit={(next) => {
                        setRenaming(null);
                        void app.client.call("renameWorkspace", { workspace: w.id, name: next });
                      }}
                    />
                  </div>
                ) : null}
              </div>
            ))}
            <div className="n-group-row" data-flip="actions">
              <div className="n-row-buttons">
                <button type="button" className="n-button" onClick={() => setCreating("shared")}>
                  <Icon name="people" size={14} /> Create shared workspace…
                </button>
                <button type="button" className="n-button" onClick={() => void app.client.call("joinSharedWorkspace", {})}>
                  <Icon name="folder" size={14} /> Join shared workspace…
                </button>
                <button type="button" className="n-button" onClick={() => setCreating("private")}>
                  <Icon name="plus" size={14} /> New private workspace…
                </button>
              </div>
            </div>
            {creating ? (
              <div className="n-group-row" data-flip="create">
                <NameForm
                  title={creating === "shared" ? "Create a shared workspace" : "Create a private workspace"}
                  placeholder="Workspace name"
                  action="Create"
                  onCancel={() => setCreating(null)}
                  onSubmit={(next) => {
                    setCreating(null);
                    void app.client.call(creating === "shared" ? "createSharedWorkspace" : "createWorkspace", { name: next });
                  }}
                />
              </div>
            ) : null}
          </section>
          <section className="n-group">
            <div className="n-group-title">Your notes</div>
            <div className="n-group-row">
              <div className="n-group-label">
                <div>Import</div>
                <div className="n-muted">From Notion, Obsidian, Evernote and Apple Notes.</div>
              </div>
              <button type="button" className="n-button" onClick={() => openImportSheet()} data-testid="settings-import">
                <Icon name="import" size={14} /> Import…
              </button>
            </div>
            <div className="n-group-row">
              <div className="n-group-label">
                <div>Welcome</div>
                <div className="n-muted">Go through setup and the short tour again.</div>
              </div>
              <button type="button" className="n-button" onClick={replayOnboarding} data-testid="settings-welcome">
                Show welcome again
              </button>
            </div>
          </section>
          <section className="n-group">
            <div className="n-group-title">Appearance</div>
            <div className="n-group-row">
              <div className="n-group-label">
                <div>Theme</div>
                <div className="n-muted">Notes follows Ardia’s theme, light or dark.</div>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
