import { reportPageCommits } from "../../platform/tabs";
import { forgetAllPageDocuments, replayPageDocuments } from "./pageBarDocuments";
import { pageBarsWanted } from "./chrome";
import { usePlugins } from "./store";

let watching = false;
let reporting = false;

function apply() {
  const want = pageBarsWanted();
  if (want === reporting) return;
  reporting = want;
  if (!want) forgetAllPageDocuments();
  void reportPageCommits("pageBars", want).catch(() => {});
  if (want) replayPageDocuments();
}

export function watchPageBarCommits() {
  if (watching) return;
  watching = true;
  usePlugins.subscribe(apply);
  apply();
}
