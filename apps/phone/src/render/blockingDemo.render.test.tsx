import { act } from "react-test-renderer";
import { BlockingScreen } from "../components/onboarding/BlockingScreen";
import { BlockingDemo, demoScale } from "../components/onboarding/StepPhones";
import { phoneFrame } from "../components/onboarding/onboardingTokens";
import { blockingDemo } from "../components/onboarding/blockingDemoTokens";
import * as settingsActions from "../state/settings/actions";
import { useBlocking } from "../state/settings/actions";
import { renderSurface, unmount } from "../../test/render/harness";

const mockMotion = { reduced: false };
jest.mock("../state/app/systemLook", () => ({ ...jest.requireActual("../state/app/systemLook"), useReduceMotion: () => mockMotion.reduced }));

const withBlocking = (ads: boolean, trackers: boolean, cookieBanners: boolean) =>
  useBlocking.setState({ busy: false, state: { isEnabled: true, blocksAds: ads, blocksTrackers: trackers, hidesCookieBanners: cookieBanners, exemptHosts: [], lists: [] } as never });

const categories = () => {
  const state = useBlocking.getState().state!;
  return { ads: state.blocksAds, trackers: state.blocksTrackers, cookieBanners: state.hidesCookieBanners };
};

let writes: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  mockMotion.reduced = false;
  withBlocking(true, true, true);
  writes = jest.spyOn(settingsActions, "setBlockingCategory").mockImplementation(() => undefined);
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

type Root = ReturnType<typeof renderSurface>;

const articles = (root: Root, name: "CollapsingArticle" | "FadingArticle") => root.root.findAll((node) => (node.type as { name?: string })?.name === name);

const adsShown = (root: Root) => {
  const article = [...articles(root, "CollapsingArticle"), ...articles(root, "FadingArticle")];
  expect(article).toHaveLength(1);
  return article[0]!.props.adsShown as boolean;
};

const wait = (ms: number) => act(() => jest.advanceTimersByTime(ms));

const layout = (root: Root, testID: string, width: number, height: number) =>
  act(() => root.root.findAll((node) => typeof node.type === "string" && node.props.testID === testID)[0]!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }));

test("the whole demo is decorative: hidden from VoiceOver and TalkBack, with no switch to reach", () => {
  const root = renderSurface(<BlockingDemo />, { flushTimers: false });
  const demo = root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "blockingDemo");
  expect(demo).toHaveLength(1);
  expect(demo[0]!.props).toMatchObject({ accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" });
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.accessibilityRole === "switch")).toHaveLength(0);
  unmount(root);
});

test("without the shared stage the demo draws its own phone, sized to fit its space, around the article", () => {
  const root = renderSurface(<BlockingDemo />, { flushTimers: false });
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "phoneFrame")).toHaveLength(0);
  layout(root, "blockingDemo", 300, phoneFrame.height * 0.8);
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "phoneFrame")).toHaveLength(1);
  expect(adsShown(root)).toBe(true);
  expect(root.root.findAll((node) => typeof node.type === "string" && node.props.testID === "phoneSlot")).toHaveLength(0);
  unmount(root);
});

test("the blocking phone fits its space and never grows past its drawn size or below half", () => {
  expect(demoScale(2000, 2000)).toBe(blockingDemo.maxScale);
  expect(demoScale(10, 10)).toBe(blockingDemo.minScale);
  expect(demoScale(2000, phoneFrame.height * 0.7)).toBeCloseTo(0.7);
});

test("it starts cluttered, blocks the ads after the cluttered hold, shows them again after the clean hold, and keeps looping by itself", () => {
  const root = renderSurface(<BlockingScreen />, { flushTimers: false });
  expect(adsShown(root)).toBe(true);
  wait(blockingDemo.clutteredMs - 1);
  expect(adsShown(root)).toBe(true);
  wait(1);
  expect(adsShown(root)).toBe(false);
  wait(blockingDemo.cleanMs - 1);
  expect(adsShown(root)).toBe(false);
  wait(1);
  expect(adsShown(root)).toBe(true);
  wait(blockingDemo.clutteredMs);
  expect(adsShown(root)).toBe(false);
  unmount(root);
});

test("looping never writes the blocking settings, and a user's partly-off blocking is left as it was", () => {
  withBlocking(true, false, true);
  const root = renderSurface(<BlockingScreen />, { flushTimers: false });
  for (let loop = 0; loop < 3; loop++) wait(blockingDemo.clutteredMs + blockingDemo.cleanMs);
  expect(writes).not.toHaveBeenCalled();
  expect(categories()).toEqual({ ads: true, trackers: false, cookieBanners: true });
  unmount(root);
});

test("with Reduce Motion the page cross-fades between cluttered and clean on the same holds instead of collapsing the ads", () => {
  mockMotion.reduced = true;
  const root = renderSurface(<BlockingScreen />, { flushTimers: false });
  expect(articles(root, "CollapsingArticle")).toHaveLength(0);
  expect(articles(root, "FadingArticle")).toHaveLength(1);
  expect(adsShown(root)).toBe(true);
  wait(blockingDemo.clutteredMs);
  expect(adsShown(root)).toBe(false);
  wait(blockingDemo.cleanMs);
  expect(adsShown(root)).toBe(true);
  expect(writes).not.toHaveBeenCalled();
  unmount(root);
});
