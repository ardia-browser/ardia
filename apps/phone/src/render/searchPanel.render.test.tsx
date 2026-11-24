import { act } from "react-test-renderer";
import { SearchTray } from "../components/search/SearchTray";
import { DesignProvider } from "../components/ui";
import * as browse from "../state/browse/store";
import { history } from "../state/history/store";
import { feedSources, presentSearch, useSearch } from "../state/search/store";
import { OFF_STATUS, useSync } from "../state/sync/store";
import { renderSurface, textOf, unmount, withTabs } from "../../test/render/harness";

type Offer = { query: string; completion: string } | null;

jest.mock("@ardia/phone-native", () => {
  const actual = jest.requireActual("@ardia/phone-native");
  const { forwardRef, useImperativeHandle, createElement } = jest.requireActual("react");
  const { View } = jest.requireActual("react-native");
  const CompletingField = forwardRef(function CompletingField(props: Record<string, unknown>, ref: unknown) {
    useImperativeHandle(ref, () => ({ focus: () => undefined, blur: () => undefined, setText: () => undefined }));
    return createElement(View, { ...props, testID: "completingField" });
  });
  return { ...actual, CompletingField, completingFieldIsNative: () => true };
});

class MainEditor {
  typed = "";
  suffix = "";
  suppressed = false;

  get display() {
    return this.typed + this.suffix;
  }

  receive(offer: Offer) {
    if (!offer) return;
    const completion = offer.completion || null;
    if (this.suppressed || !this.typed) this.suffix = "";
    else if (completion && this.typed.toLowerCase().startsWith(offer.query.toLowerCase()) && completion.toLowerCase().startsWith(this.typed.toLowerCase())) this.suffix = completion.slice(this.typed.length);
    else if (offer.query === this.typed) this.suffix = "";
  }

  insert(char: string): "consumed" | "insertTyped" {
    this.suppressed = false;
    if (!this.suffix) return "insertTyped";
    if (this.suffix.toLowerCase().startsWith(char.toLowerCase())) {
      this.typed += char;
      this.suffix = this.suffix.slice(char.length);
      return "consumed";
    }
    this.suffix = "";
    return "insertTyped";
  }

  deleteBackward(): "consumed" | "insertTyped" {
    this.suppressed = true;
    if (!this.suffix) return "insertTyped";
    this.suffix = "";
    return "consumed";
  }
}

let historyRevision = 1000;
let rows: { url: string; title: string; favicon: string | null; visits: number; lastVisit: number }[] = [];
let submit: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  rows = [];
  historyRevision += 1;
  jest.spyOn(history(), "summary").mockImplementation(() => rows);
  jest.spyOn(history(), "revision").mockImplementation(() => historyRevision);
  submit = jest.spyOn(browse, "submitSearch").mockImplementation(() => true);
  withTabs(2);
  act(() => {
    browse.useBrowse.setState({ surface: "start" });
    useSync.setState((state) => ({ ...state, status: OFF_STATUS, view: { devices: [], profiles: [], search: null, syncedAt: null, selectedProfileId: null, receivers: [] } as never }));
  });
});

afterEach(() => {
  act(() => browse.cancelSearch());
  act(() => jest.runOnlyPendingTimers());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function typingField(root: ReturnType<typeof renderSurface>) {
  const field = () => root.root.findAll((node) => node.props.testID === "completingField" && typeof node.props.onTypedChange === "function")[0]!;
  const editor = new MainEditor();
  const push = () => {
    act(() => field().props.onTypedChange(editor.typed));
    act(() => jest.advanceTimersByTime(16));
    editor.receive(field().props.offer as Offer);
  };
  return {
    editor,
    field,
    type(text: string) {
      for (const char of text) {
        if (editor.insert(char) === "insertTyped") editor.typed += char;
        push();
      }
    },
    deleteBackward() {
      if (editor.deleteBackward() === "insertTyped") editor.typed = editor.typed.slice(0, -1);
      push();
    },
    offerAgain() {
      editor.receive(field().props.offer as Offer);
    },
    pressReturn() {
      act(() => field().props.onSubmit(editor.display));
    },
  };
}

const visited = (url: string, title: string, visits = 12) => ({ url, title, favicon: null, visits, lastVisit: Date.now() - 60_000 });

test("typing app one key at a time completes inline to apple.com, the next matching key eats the completion, and Return opens what the field shows", () => {
  rows = [visited("https://www.apple.com/", "Apple")];
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  const field = typingField(root);
  field.type("a");
  field.type("p");
  field.type("p");
  expect(field.editor.typed).toBe("app");
  expect(field.editor.display).toBe("apple.com");
  expect(field.field().props.offer).toEqual({ query: "app", completion: "apple.com" });
  field.type("l");
  expect(field.editor.typed).toBe("appl");
  expect(field.editor.suffix).toBe("e.com");
  field.pressReturn();
  expect(submit).toHaveBeenCalledWith("apple.com");
  unmount(root);
});

test("Delete drops the completion and keeps what was typed, the completion stays away while deleting, and the next typed key brings it back", () => {
  rows = [visited("https://www.apple.com/", "Apple")];
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  const field = typingField(root);
  field.type("appl");
  expect(field.editor.display).toBe("apple.com");
  field.deleteBackward();
  expect(field.editor.display).toBe("appl");
  expect(useSearch.getState().text).toBe("appl");
  field.offerAgain();
  expect(field.editor.display).toBe("appl");
  field.deleteBackward();
  expect(field.editor.display).toBe("app");
  field.pressReturn();
  expect(submit).toHaveBeenLastCalledWith("app");
  field.type("l");
  expect(field.editor.display).toBe("apple.com");
  unmount(root);
});

test("a key that leaves the completion drops it and Return opens just the typed text", () => {
  rows = [visited("https://www.apple.com/", "Apple")];
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  const field = typingField(root);
  field.type("app");
  expect(field.editor.suffix).toBe("le.com");
  field.type("x");
  expect(field.editor.display).toBe("appx");
  field.pressReturn();
  expect(submit).toHaveBeenLastCalledWith("appx");
  unmount(root);
});

test("an answer for text the field has since typed past stays on offer, as main's editor takes it while it still fits", () => {
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  const field = typingField(root);
  field.type("goo");
  act(() => useSearch.setState({ completion: "ogle.com", completedFor: "go" }));
  expect(field.field().props.offer).toEqual({ query: "go", completion: "google.com" });
  field.offerAgain();
  expect(field.editor.display).toBe("google.com");
  act(() => useSearch.setState({ completion: "", completedFor: "goo" }));
  field.offerAgain();
  expect(field.editor.display).toBe("goo");
  unmount(root);
});

test("in the redesign a row is Arc's one line: a 20-point favicon or a 19-point glyph, the title, and Switch to Tab after it for an open tab, with no switch arrow", () => {
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  const field = typingField(root);
  field.type("site 1");
  const symbols = root.root.findAll((node) => (node.type as { name?: string })?.name === "Symbol");
  const favicons = root.root.findAll((node) => (node.type as { type?: { name?: string } })?.type?.name === "Favicon" || (node.type as { name?: string })?.name === "Favicon");
  expect(textOf(root)).toContain("Site 1");
  expect(textOf(root)).toContain("Switch to Tab");
  const query = symbols.find((node) => node.props.name === "magnifyingglass")!;
  expect(symbols.some((node) => node.props.name === "arrowRightCircle")).toBe(false);
  expect(query.props.size).toBe(19);
  expect(favicons[0]!.props.size).toBe(20);
  unmount(root);
});

test("the classic design keeps Compose's row: the switch arrow, a 19-point search glyph and a 20-point favicon", () => {
  presentSearch("start", "");
  const root = renderSurface(
    <DesignProvider design="original">
      <SearchTray />
    </DesignProvider>,
  );
  typingField(root).type("site 1");
  const symbols = root.root.findAll((node) => (node.type as { name?: string })?.name === "Symbol");
  const favicons = root.root.findAll((node) => (node.type as { type?: { name?: string } })?.type?.name === "Favicon" || (node.type as { name?: string })?.name === "Favicon");
  expect(symbols.some((node) => node.props.name === "arrowRightCircle")).toBe(true);
  expect(symbols.find((node) => node.props.name === "magnifyingglass")!.props.size).toBe(19);
  expect(favicons[0]!.props.size).toBe(20);
  unmount(root);
});

test("the empty panel lists recent searches, then the Mac's tabs with the laptop after their title, and no open tabs", () => {
  rows = [visited("https://www.google.com/search?q=swift+concurrency", "swift concurrency - Google Search", 1)];
  presentSearch("start", "");
  const root = renderSurface(<SearchTray />);
  expect(textOf(root)).toContain("swift concurrency");
  expect(textOf(root)).not.toContain("SwiftUI");
  act(() => {
    useSync.setState((state) => ({
      ...state,
      revision: state.revision + 1,
      status: { ...OFF_STATUS, isEnabled: true, phase: "updated" },
      view: {
        devices: [{ id: "mac", name: "MacBook Pro", kind: "mac", lastSeen: 1, isCurrent: false, canReceiveTabs: true }],
        profiles: [
          {
            syncId: "work",
            name: "Work",
            color: null,
            icon: null,
            isDefault: true,
            theme: null,
            deviceTabs: [{ deviceId: "mac", deviceName: "MacBook Pro", kind: "mac", tabs: [{ url: "https://developer.apple.com/swiftui/", title: "SwiftUI | Apple Developer Documentation" }] }],
            pinned: { tiles: [], sections: [] },
            bookmarks: [],
            history: [],
            sendTargets: null,
          },
        ],
        search: null,
        syncedAt: 1,
        selectedProfileId: "work",
        shownProfileId: "work",
        receivers: [],
      } as never,
    }));
    feedSources();
  });
  const shown = useSearch.getState().rows;
  expect(shown.map((row) => row.title)).toEqual(["swift concurrency", "SwiftUI | Apple Developer Documentation"]);
  expect(shown.some((row) => row.kind === "page" && row.switchesTab)).toBe(false);
  expect(textOf(root)).not.toContain("developer.apple.com");
  expect(textOf(root)).not.toContain("Switch to Tab");
  expect(root.root.findAll((node) => (node.type as { name?: string })?.name === "Symbol" && node.props.name === "laptop").length).toBe(1);
  unmount(root);
});
