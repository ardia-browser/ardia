import { ActionSheetIOS, Alert, Platform, type AlertButton } from "react-native";
import { act } from "react-test-renderer";
import { PageRequestHost } from "../components/browsing/PageRequests";
import * as actions from "../state/page/actions";
import type { Request } from "../state/page/pagePrompts";
import { usePages } from "../state/pages/store";
import { renderSurface, unmount } from "../../test/render/harness";

const onIos = Platform.OS === "ios" ? test : test.skip;
const onAndroid = Platform.OS === "android" ? test : test.skip;

const base = { id: "r1", host: "example.com", title: "example.com", message: "Hello" };

const ask = (request: Request) => act(() => usePages.setState({ requests: { p1: request as never } }));

let answered: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  answered = jest.spyOn(actions, "answerRequest").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => usePages.setState({ requests: {} }));
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const press = (buttons: AlertButton[] | undefined, text: string, value?: unknown) => act(() => (buttons!.find((button) => button.text === text)!.onPress as (value?: unknown) => void)(value));

onIos("on iPhone a page's alert is the system's own alert, as main's is: its OK answers the page and nothing of ours is drawn", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  ask({ ...base, kind: "alert", text: "Hello" });
  const root = renderSurface(<PageRequestHost tabId="p1" />);
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "button")).toHaveLength(0);
  expect(alert).toHaveBeenCalledTimes(1);
  const [title, message, buttons] = alert.mock.calls[0]!;
  expect([title, message, buttons!.map((button) => button.text)]).toEqual(["example.com", "Hello", ["OK"]]);
  press(buttons, "OK");
  expect(answered).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "r1" }), { type: "accept" });
  unmount(root);
});

onIos("on iPhone a confirm offers Cancel as the system's cancel button, and a prompt and a sign-in use the system's text and login fields", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  const prompt = jest.spyOn(Alert, "prompt").mockImplementation(() => undefined);
  ask({ ...base, kind: "confirm", text: "Sure?" });
  let root = renderSurface(<PageRequestHost tabId="p1" />);
  const confirmButtons = alert.mock.calls[0]![2]!;
  expect(confirmButtons.map((button) => [button.text, button.style])).toEqual([["Cancel", "cancel"], ["OK", undefined]]);
  press(confirmButtons, "Cancel");
  expect(answered).toHaveBeenLastCalledWith("p1", expect.objectContaining({ id: "r1" }), { type: "dismiss" });
  unmount(root);
  ask({ ...base, id: "r2", kind: "prompt", text: "Name?", defaultText: "Ada" });
  root = renderSurface(<PageRequestHost tabId="p1" />);
  expect(prompt.mock.calls[0]![3]).toBe("plain-text");
  expect(prompt.mock.calls[0]![4]).toBe("Ada");
  press(prompt.mock.calls[0]![2] as AlertButton[], "OK", "Grace");
  expect(answered).toHaveBeenLastCalledWith("p1", expect.objectContaining({ id: "r2" }), { type: "text", text: "Grace" });
  unmount(root);
  ask({ ...base, id: "r3", kind: "httpAuthentication", realm: null, isProxy: false, failedBefore: false, isSecure: true });
  root = renderSurface(<PageRequestHost tabId="p1" />);
  expect(prompt.mock.calls[1]![3]).toBe("login-password");
  press(prompt.mock.calls[1]![2] as AlertButton[], "Sign In", { login: "ada", password: "secret" });
  expect(answered).toHaveBeenLastCalledWith("p1", expect.objectContaining({ id: "r3" }), { type: "credential", user: "ada", password: "secret" });
  unmount(root);
});

onIos("on iPhone a file input that offers the camera asks in the system's action sheet", () => {
  const sheet = jest.spyOn(ActionSheetIOS, "showActionSheetWithOptions").mockImplementation(() => undefined);
  ask({ ...base, kind: "fileChooser", offersPhoto: true, offersVideo: false, capturesDirectly: false, allowsMultiple: false } as Request);
  const root = renderSurface(<PageRequestHost tabId="p1" />);
  const [options, done] = sheet.mock.calls[0]!;
  expect(options.options).toEqual(["Take Photo", "Choose File", "Cancel"]);
  expect(options.cancelButtonIndex).toBe(2);
  act(() => done(0));
  expect(answered).toHaveBeenLastCalledWith("p1", expect.objectContaining({ id: "r1" }), { type: "takePhoto" });
  unmount(root);
});

onAndroid("on Android a page's alert stays the drawn dialog", () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  ask({ ...base, kind: "alert", text: "Hello" });
  const root = renderSurface(<PageRequestHost tabId="p1" />);
  expect(alert).not.toHaveBeenCalled();
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "button").length).toBeGreaterThan(0);
  unmount(root);
});
