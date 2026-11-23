import { useEffect } from "react";
import { showMenu } from "../../../state/app/system";
import { useSettings } from "../../../state/browser/hooks";
import { backupLine, restoreLine, updateLine, updateTitle } from "../../../state/vaults/backupCopy";
import { deleteICloudBackup, restoreFromICloud, resumeICloudBackup, setICloudSync, updateFromICloud, useVaultSync, watchVaultBackup } from "../../../state/vaults/sync";
import { Box, Button, Toggle } from "../../ui";
import { Row } from "../Form";

const RESTORE_TITLES = ["Restore", "Restoring…"] as const;
const UPDATE_TITLES = ["Update", "Updating…"] as const;

async function iCloudMenu() {
  const choice = await showMenu([{ id: "delete", title: "Delete iCloud Backup…", symbol: "trash" }]);
  if (choice === "delete") await deleteICloudBackup();
}

export function VaultICloudRows() {
  const on = useSettings((s) => s.vaultICloudSync);
  const backup = useVaultSync((s) => s.backup);
  const restoring = useVaultSync((s) => s.restoring);
  const note = useVaultSync((s) => s.restoreNote);
  useEffect(() => (on ? watchVaultBackup() : undefined), [on]);
  const live = on && backup?.state !== "off" && backup?.state !== "deleted";
  const restorable = live ? (backup?.restorable ?? 0) : 0;
  const updatable = live ? (backup?.updatable ?? 0) : 0;
  return (
    <>
      <Row title="Sync with iCloud" description={on ? backupLine(backup, Date.now()) : undefined}>
        <Box row gap="s" center>
          {live ? <Button variant="icon" icon="ellipsis.circle" size="l" tooltip="More" onPress={() => void iCloudMenu()} /> : null}
          <Toggle value={on} accessibilityLabel="Sync with iCloud" onChange={setICloudSync} />
        </Box>
      </Row>
      {on && backup?.state === "deleted" ? (
        <Row title="iCloud backup deleted" description="Another Mac deleted the backup. This Mac stopped syncing.">
          <Button title="Turn On Again" onPress={() => void resumeICloudBackup()} />
        </Row>
      ) : null}
      {restorable > 0 || (live && note) ? (
        <Row title="iCloud backup" description={restorable > 0 && !restoring ? restoreLine(restorable) : (note ?? undefined)}>
          {restorable > 0 ? (
            <Button title={restoring ? RESTORE_TITLES[1] : RESTORE_TITLES[0]} reserve={RESTORE_TITLES} disabled={restoring} onPress={() => void restoreFromICloud()} />
          ) : null}
        </Row>
      ) : null}
      {updatable > 0 ? (
        <Row title={updateTitle(updatable)} description={updateLine(updatable)}>
          <Button title={restoring ? UPDATE_TITLES[1] : UPDATE_TITLES[0]} reserve={UPDATE_TITLES} disabled={restoring} onPress={() => void updateFromICloud()} />
        </Row>
      ) : null}
    </>
  );
}
