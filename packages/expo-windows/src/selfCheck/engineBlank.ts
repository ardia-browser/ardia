import { engineAvailable, hostCall } from "../engine/host";
import { httpPagesPort } from "./engineBackForward";
import { expectEqual, expectTrue, type Check } from "./check";
import { firstWindow, heard, listed, until } from "./engineSleep";

const LOAD_MS = 20000;
const BLANK = "about:blank";

const port = engineAvailable() ? httpPagesPort() : null;
const download = `http://127.0.0.1:${port}/download.bin`;

async function withTab(name: string, url: string, run: (key: string) => Promise<void>) {
  const key = `self-check-blank-${name}`;
  const profile = `incognito-blank-check-${name}@`;
  const windowId = await firstWindow();
  try {
    await hostCall("tab.create", { key, url, profile }, windowId);
    await until(`the tab ${key} settles on its blank page`, LOAD_MS, () => listed(key), (tab) => tab?.url === BLANK && tab.loading === false);
    await run(key);
  } finally {
    await hostCall("tab.close", { key }).catch(() => null);
    await hostCall("profile.release", { profile }).catch(() => null);
  }
}

async function downloadFrom(key: string) {
  const started = heard("tab", (event) => event.key === key && event.name === "downloadNavigation", `a download from ${key}`);
  await hostCall("tab.call", { key, method: "loadUrl", url: download });
  const event = await started;
  expectEqual(event.data?.url, download, "the download navigation names the file's address");
  return event.data?.committedUrl;
}

const blankChecks: Check[] = [
  {
    name: "engine blank: a tab asked for about:blank lists it, and a download from it reports about:blank as the page it stays on",
    run: () =>
      withTab("asked", BLANK, async (key) => {
        expectEqual(await downloadFrom(key), BLANK, "the download's committedUrl is the about:blank the tab was asked for");
        const after = await until("the tab is back on its page after the download", LOAD_MS, () => listed(key), (tab) => tab?.loading === false);
        expectEqual(after?.url, BLANK, "the tab still lists about:blank");
      }),
  },
  {
    name: "engine blank: a tab opened with no address reports no page when a download leaves it",
    run: () =>
      withTab("opened", "", async (key) => {
        const committed = await downloadFrom(key);
        expectTrue(committed === "", `the download's committedUrl is empty for the blank the tab opened on (got ${JSON.stringify(committed)})`);
      }),
  },
];

export const checks: Check[] = port ? blankChecks : [];
