import { act } from "react-test-renderer";
import { iconRoles } from "../components/ui";
import { actionWords } from "../lib/sharedWords";
import { copyLink, trayRowActions } from "../state/browse/tabMenus";
import type { TrayRow } from "../state/search/omnibox";
import { dismissToast, useToasts } from "../state/toasts/store";
import { useTabs } from "../state/tabs/store";

const PAGE: TrayRow = { key: "page", kind: "page", title: "Example", detail: "example.com", url: "https://example.com/a?utm_source=x", favicon: null, tabId: null, switchesTab: false };

const CALC: TrayRow = { key: "calc", kind: "calc", title: "4", detail: "2 + 2", url: "", value: "4" };

afterEach(() => act(() => dismissToast()));

test("a result's menu says Copy Link with the link glyph and Share with no ellipsis, and a sum copies as plain text", () => {
  act(() => useTabs.setState({ incognito: false }));
  const actions = trayRowActions(PAGE);
  expect(actions.find((action) => action.label === actionWords.copyLink)?.icon).toBe(iconRoles.copyLink);
  expect(actions.find((action) => action.label.startsWith("Share"))).toMatchObject({ label: "Share", icon: iconRoles.share });
  expect(trayRowActions(CALC)).toEqual([expect.objectContaining({ label: actionWords.copyText, icon: iconRoles.copyText })]);
});

test("Copy Link says Copied Link Without Trackers with the link glyph only when it removed a tracker", () => {
  act(() => copyLink(PAGE.url));
  expect(useToasts.getState().toast).toMatchObject({ message: "Copied Link Without Trackers", icon: iconRoles.copyLink });
  act(() => dismissToast());
  act(() => copyLink("https://example.com/a"));
  expect(useToasts.getState().toast).toMatchObject({ message: "Copied Link", icon: iconRoles.copyLink });
});
