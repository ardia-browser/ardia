import { useState } from "react";
import { getPage, updatePage } from "../../shared/model";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import { useApp } from "../app/context";
import { useFileIcon } from "../app/files";
import { EmojiPicker } from "../ui/EmojiPicker";
import { PageIcon } from "../ui/icons";
import { Popover } from "../ui/Popover";

export function RenamePopover({ anchor, workspace, page, onClose }: { anchor: HTMLElement; workspace: WorkspaceId; page: PageId; onClose: () => void }) {
  const app = useApp();
  const tree = app.trees.get(workspace);
  const meta = tree ? getPage(tree, page) : null;
  const [title, setTitle] = useState(meta?.title ?? "");
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const resolveIcon = useFileIcon(app.client, workspace);
  if (!tree || !meta) return null;
  const save = (patch: { title?: string; icon?: string }) => updatePage(tree, page, patch, app.me.deviceId);
  return (
    <Popover anchor={anchor} onClose={onClose} width={Math.max(260, anchor.getBoundingClientRect().width)} placement="bottom-start" offset={2}>
      <form
        className="n-rename"
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <button type="button" className="n-rename-icon" aria-label="Change icon" onClick={(e) => setPicker(e.currentTarget)}>
          <PageIcon icon={meta.icon} size={18} resolveFile={resolveIcon} />
        </button>
        <input
          autoFocus
          aria-label="Page title"
          data-testid="rename-input"
          value={title}
          placeholder="Untitled"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setTitle(e.target.value);
            save({ title: e.target.value });
          }}
        />
      </form>
      {picker ? (
        <Popover anchor={picker} onClose={() => setPicker(null)} width={408}>
          <EmojiPicker
            onPick={(icon) => {
              save({ icon });
              setPicker(null);
            }}
            onRemove={() => {
              save({ icon: "" });
              setPicker(null);
            }}
          />
        </Popover>
      ) : null}
    </Popover>
  );
}
