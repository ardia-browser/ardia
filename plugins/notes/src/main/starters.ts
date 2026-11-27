import type * as Y from "yjs";
import type { StarterId } from "../shared/importSources";
import { createPage } from "../shared/model";
import { GETTING_STARTED, writeBlocks } from "./welcome";

export function applyStarter(tree: Y.Doc, starter: StarterId, by: string, open: (pageId: string) => Y.Doc, now = Date.now()): string {
  const first = createPage(tree, { parent: "", kind: "page", title: "Getting Started", icon: "👋", by, now });
  writeBlocks(open(first), GETTING_STARTED);
  if (starter === "blank") return first;
  return first;
}
