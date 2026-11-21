import { reportPageCommits } from "../../platform/tabs";
import { forgetAllPageDocuments } from "./pageBarDocuments";
import { pageBarsWanted, setPageBarsWanted } from "./pageBarGate";
import { activeManifest, activeNames, currentPlugins, usePlugins, type PluginsStore } from "./store";

let watching = false;

const wantsCommits = (s: Pick<PluginsStore, "listings" | "records" | "order">) => activeNames(s).some((name) => activeManifest(s, name)?.pageBar);

function apply() {
  const want = wantsCommits(currentPlugins());
  if (want === pageBarsWanted()) return;
  setPageBarsWanted(want);
  if (!want) forgetAllPageDocuments();
  void reportPageCommits("pageBars", want).catch(() => {});
}

export function watchPageBarCommits() {
  if (watching) return;
  watching = true;
  usePlugins.subscribe(apply);
  apply();
}
