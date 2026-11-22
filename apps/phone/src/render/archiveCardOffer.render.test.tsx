import { act } from "react-test-renderer";
import { dismissArchiveCard, hideArchiveCard, hideArchiveCardSoon, offerArchiveCard, useArchiveCard } from "../state/browse/archiveCard";
import { currentPreferences, setPreference } from "../state/settings/store";

const MANY = 40;

beforeEach(() => {
  jest.useFakeTimers();
  setPreference("archiveCardShown", false);
  act(() => useArchiveCard.setState({ showing: false }));
});

afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  setPreference("archiveCardShown", false);
  jest.useRealTimers();
});

const offer = () => {
  act(() => offerArchiveCard(MANY));
  act(() => jest.advanceTimersByTime(200));
  return useArchiveCard.getState().showing;
};

test("on both phones the Archive capsule comes back on every deck open until it is dismissed or answered, as main's hasShownArchiveCard is set only then", () => {
  expect(offer()).toBe(true);
  act(() => void hideArchiveCard());
  expect(currentPreferences().archiveCardShown).toBe(false);
  expect(offer()).toBe(true);
  act(() => void dismissArchiveCard());
  expect(currentPreferences().archiveCardShown).toBe(true);
  expect(offer()).toBe(false);
});

test("picking an interval also retires the capsule, and a dismissal with nothing showing retires nothing", () => {
  act(() => void dismissArchiveCard());
  expect(currentPreferences().archiveCardShown).toBe(false);
  expect(offer()).toBe(true);
  act(() => hideArchiveCardSoon());
  act(() => jest.advanceTimersByTime(700));
  expect(useArchiveCard.getState().showing).toBe(false);
  expect(offer()).toBe(false);
});
