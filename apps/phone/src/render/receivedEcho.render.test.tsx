import { act } from "react-test-renderer";
import { traceLab } from "../platform/lab";
import { sync } from "../platform/sync";
import { applyInbox } from "../state/sync/actions";
import { currentTabs } from "../state/tabs/store";
import { withTabs } from "../../test/render/harness";

const received = (key: string, fromDeviceId: string) => ({ key, url: `https://${key}.example/`, title: key, fromDevice: fromDeviceId === "phone-1" ? "This Phone" : "Mac", fromDeviceId, sentAt: 1, profileSyncId: "p" });

test("a tab this phone sent out and the inbox hands back is dropped as the phone's own, with its trace line; a Mac's tab still opens and is traced", async () => {
  withTabs(2);
  const traced: string[] = [];
  traceLab(true, (line) => traced.push(line));
  let delivered = false;
  const inbox = jest.spyOn(sync, "inbox").mockImplementation(async () => {
    if (delivered) return [];
    delivered = true;
    return [{ id: 1, received: [received("echo", "phone-1"), received("from-mac", "mac-1")], removals: [] }] as never;
  });
  const applied = jest.spyOn(sync, "inboxApplied").mockImplementation(async () => undefined);
  const own = jest.spyOn(sync, "deviceId").mockImplementation(() => "phone-1");
  const before = currentTabs().open.length;
  let opened = 0;
  await act(async () => {
    opened = await applyInbox();
  });
  traceLab(false);
  expect(opened).toBe(1);
  expect(currentTabs().open.length).toBe(before + 1);
  expect(currentTabs().open.some((tab) => tab.url === "https://echo.example/")).toBe(false);
  expect(traced.filter((line) => line.startsWith("PAGELAB tab dropped as the phone's own"))).toHaveLength(1);
  expect(traced.filter((line) => /PAGELAB tab opened .* origin received-from-mac/.test(line))).toHaveLength(1);
  for (const spy of [inbox, applied, own]) spy.mockRestore();
});
