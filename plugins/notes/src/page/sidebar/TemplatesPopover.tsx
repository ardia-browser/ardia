import { allPages, displayTitle, isArchivedDeep } from "../../shared/model";
import { useApp } from "../app/context";
import { useTreesVersion } from "../app/hooks";

export function useTemplates() {
  const app = useApp();
  useTreesVersion(app.trees);
  const out: { workspace: string; id: string; title: string; icon: string }[] = [];
  for (const [workspace, tree] of app.trees) for (const p of allPages(tree)) if (p.isTemplate && !isArchivedDeep(tree, p.id)) out.push({ workspace, id: p.id, title: displayTitle(p), icon: p.icon });
  return out;
}
