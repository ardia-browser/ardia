import { useState } from "react";
import { exportProfileBookmarks } from "../../../state/bookmarks/exportHtml";
import { profileIdForSpace } from "../../../state/profiles/current";
import { spaceOfWindow } from "../../../state/bookmarks/bookmarkGroups";
import { settingsBrowserWindow } from "../../../state/settings/settingsWindows";
import { Button } from "../../ui";
import { Row } from "../Form";

export function ExportBookmarksRow({ profileId }: { profileId: string }) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setStatus("");
    try {
      const path = await exportProfileBookmarks(profileId);
      if (path) {
        const parts = path.split(/[\\/]/);
        setStatus(`Saved “${parts.at(-1) ?? path}” to “${parts.at(-2) ?? ""}”.`);
      }
    } catch (error) {
      setStatus(`Couldn't export: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row anchor="profiles.exportBookmarks" description={status || undefined}>
      <Button title="Export…" disabled={busy} onPress={() => void run()} />
    </Row>
  );
}
