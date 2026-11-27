import type { ViewType } from "../database";
import { allNodes } from "./build";
import { CREATIVE } from "./catalog/creative";
import { PERSONAL } from "./catalog/personal";
import { PLANNING } from "./catalog/planning";
import { SCHOOL } from "./catalog/school";
import { WORK } from "./catalog/work";
import { WORK_PRODUCT } from "./catalog/workProduct";
import { WORK_TEAM } from "./catalog/workTeam";
import type { TemplateCategory, TemplateSpec, TemplateSummary } from "./types";

export { instantiateTemplate, dateCell, allNodes, SAMPLE_PEOPLE, PERSON_ME, samplePersonId, TemplateError, type TemplateTarget, type InstantiateOptions, type Instantiated } from "./build";
export type { TemplateCategory, TemplateSpec, TemplateSummary, NodeSpec, PageSpec, DatabaseSpec, PropSpec, ViewSpec, RowSpec } from "./types";

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; name: string; icon: string; blurb: string }[] = [
  { id: "personal", name: "Personal", icon: "🏡", blurb: "Habits, money, trips and the things you love" },
  { id: "work", name: "Work", icon: "💼", blurb: "Projects, meetings, teams and launches" },
  { id: "school", name: "School", icon: "🎓", blurb: "Classes, assignments, research and revision" },
  { id: "creative", name: "Writing & creative", icon: "✍️", blurb: "Drafts, stories, videos and podcasts" },
  { id: "planning", name: "Planning & methods", icon: "🧭", blurb: "Systems for thinking and planning" },
];

export const TEMPLATES: readonly TemplateSpec[] = [...PERSONAL, ...WORK, ...WORK_TEAM, ...WORK_PRODUCT, ...SCHOOL, ...CREATIVE, ...PLANNING];

export const TEMPLATE_IDS: readonly string[] = TEMPLATES.map((t) => t.id);

const byId = new Map(TEMPLATES.map((t) => [t.id, t]));

export function templateById(id: string): TemplateSpec | null {
  return byId.get(id) ?? null;
}

export function summarize(template: TemplateSpec): TemplateSummary {
  const nodes = allNodes(template);
  const views = new Set<ViewType>();
  let databases = 0;
  for (const node of nodes) if (node.kind === "database") {
    databases++;
    for (const view of node.views) views.add(view.type);
  }
  return {
    id: template.id,
    title: template.title,
    description: template.description,
    category: template.category,
    icon: template.root.icon ?? "",
    cover: template.root.cover ?? "",
    kind: template.root.kind,
    tags: template.tags ?? [],
    pages: nodes.length - databases,
    databases,
    views: [...views],
  };
}

export const TEMPLATE_SUMMARIES: readonly TemplateSummary[] = TEMPLATES.map(summarize);

const fold = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function searchTemplates(query: string, category?: TemplateCategory | null): TemplateSummary[] {
  const words = fold(query).split(/[^a-z0-9]+/).filter(Boolean);
  const pool = category ? TEMPLATE_SUMMARIES.filter((t) => t.category === category) : TEMPLATE_SUMMARIES;
  if (!words.length) return pool.slice();
  const scored: { t: TemplateSummary; score: number }[] = [];
  for (const t of pool) {
    const title = fold(t.title);
    const tags = fold(t.tags.join(" "));
    const rest = fold(`${t.description} ${TEMPLATE_CATEGORIES.find((c) => c.id === t.category)?.name ?? ""} ${t.views.join(" ")}`);
    let score = 0;
    for (const word of words) {
      const inTitle = title.split(/[^a-z0-9]+/).some((w) => w.startsWith(word));
      const inTags = tags.split(/[^a-z0-9]+/).some((w) => w.startsWith(word));
      const inRest = rest.includes(word);
      if (!inTitle && !inTags && !inRest) {
        score = 0;
        break;
      }
      score += inTitle ? 10 : inTags ? 5 : 1;
    }
    if (score > 0) scored.push({ t, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.t.title.localeCompare(b.t.title)).map((x) => x.t);
}
