import { useState } from "react";
import { exportBookmarks } from "../../../state/bookmarks/exportHtml";
import { Button } from "../../ui";
import { Row } from "../Form";
import { t } from "../../../lib/uiLanguage";


export function ExportBookmarksRow({ profileId }: { profileId: string }) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setStatus("");
    try {
      const path = await exportBookmarks(profileId);
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
      <Button title={t(`Export…`)} disabled={busy} onPress={() => void run()} />
    </Row>
  );
}
