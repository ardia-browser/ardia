import { afterFirstWindow } from "../../lib/afterFirstWindow";
import { isTestInstance, recoveredStart, syncTurnOnRequested } from "../../platform/launchConfig";
import { folderInfo, turnOnSync, useSync } from "./engine";

const say = (line: string) => console.info(`[sync] test: ${line}`);

async function turnOn() {
  const { status } = useSync.getState();
  if (status !== "off") return say(`left as it was, status ${status}`);
  const info = await folderInfo();
  if (!info) return say("couldn't turn on: no sync folder");
  const turned = await turnOnSync(info.path);
  say("error" in turned ? `couldn't turn on: ${turned.error}` : "turned on");
}

export function traceSyncForTest() {
  if (!isTestInstance()) return;
  say(`recoveredStart ${recoveredStart()}, status ${useSync.getState().status}`);
  useSync.subscribe((s, prev) => {
    if (s.status !== prev.status) say(`status ${s.status}`);
  });
  if (syncTurnOnRequested()) afterFirstWindow(() => void turnOn().catch((error: unknown) => say(`couldn't turn on: ${String(error)}`)));
}
