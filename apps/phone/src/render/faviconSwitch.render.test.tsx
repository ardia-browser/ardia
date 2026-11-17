import { useLayoutEffect } from "react";
import { act, create } from "react-test-renderer";
import { Favicon } from "../components/ui";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

let root: ReturnType<typeof create> | null = null;
const commits: string[][] = [];

const shownIcons = () =>
  root ? root.root.findAll((node) => typeof node.type === "string" && typeof node.props.source?.uri === "string").map((node) => node.props.source.uri as string) : [];

function Commit() {
  useLayoutEffect(() => {
    commits.push(shownIcons());
  });
  return null;
}

const card = (site: string) => (
  <>
    <Favicon iconUrl={`https://${site}/favicon.ico`} pageUrl={`https://${site}/`} size={32} />
    <Commit />
  </>
);

test("when a card's page changes, no committed frame shows the old site's icon before the new one is chosen", () => {
  act(() => {
    root = create(card("example.com"));
  });
  expect(shownIcons().some((uri) => uri.includes("example.com"))).toBe(true);
  commits.length = 0;
  act(() => root!.update(card("kernel.org")));
  expect(commits.length).toBeGreaterThanOrEqual(1);
  expect(commits.every((icons) => !icons.some((uri) => uri.includes("example.com")))).toBe(true);
  expect(shownIcons().some((uri) => uri.includes("kernel.org"))).toBe(true);
  act(() => root!.unmount());
});
