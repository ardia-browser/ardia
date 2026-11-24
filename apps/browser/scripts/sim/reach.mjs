import { firstDifference, pinnedAreaShape } from "./rules.mjs";
import { pinKeysOf } from "./world.mjs";

export const REQUIRED_REACH = [
  "person removed a pin",
  "sync brought a change",
  "reload with pins",
  "relaunch with pins",
  "window closed holding pins",
  "shared window closed into another",
  "reopen restored an entry",
];

const pinCount = (world, s) => [...pinKeysOf(world, s).values()].reduce((n, keys) => n + keys.size, 0);

export function reachOf(world, step, outcome) {
  const hits = [step.kind];
  if (outcome.removes || outcome.removesProfile) hits.push("person removed a pin");
  if (outcome.syncPair && firstDifference(pinnedAreaShape(outcome.before), pinnedAreaShape(outcome.syncPair[0]))) hits.push("sync brought a change");
  if (outcome.roundTrip && pinCount(world, outcome.roundTrip[0])) hits.push("reload with pins");
  if (outcome.relaunch && pinCount(world, outcome.relaunch[0])) hits.push("relaunch with pins");
  if (step.kind === "closeWindow") {
    const gone = Object.keys(outcome.before.windows).filter((id) => !outcome.after.windows[id]);
    const { inPinnedContainer } = world.modules.model;
    if (gone.some((id) => outcome.before.windows[id].tabIds.some((t) => inPinnedContainer(outcome.before, t)))) hits.push("window closed holding pins");
    if (outcome.before.settings.shareTabsAcrossWindows && gone.length && Object.keys(outcome.after.windows).length) hits.push("shared window closed into another");
  }
  if (outcome.reopened) {
    const left = new Set([...outcome.after.closedTabs, ...outcome.after.closedWindows].map((c) => c.id));
    if ([...outcome.reopened.tabs, ...outcome.reopened.windows].some((c) => !left.has(c.id))) hits.push("reopen restored an entry");
  }
  return hits;
}
