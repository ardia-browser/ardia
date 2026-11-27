import { templateById } from "../../shared/templates";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import type { NotesClient } from "../client/types";

export type TemplateBuildContext = { client: NotesClient; workspace: WorkspaceId };

export type OnboardingTemplate = {
  id: string;
  title: string;
  icon: string;
  blurb: string;
  builtin: boolean;
  build: (ctx: TemplateBuildContext) => Promise<PageId | null>;
};

const FEATURED_IDS = ["journal", "task-list", "reading-list", "project-tracker"];

const BLURBS: Record<string, string> = {
  journal: "A dated entry for every day, with a calendar to look back on.",
  "task-list": "Not started, in progress, done. Drag cards as things move.",
  "reading-list": "Books, articles and podcasts, from want-to-read to finished.",
  "project-tracker": "Projects with owners, dates and a timeline of what’s next.",
};

const fromCatalog = (id: string): OnboardingTemplate | null => {
  const spec = templateById(id);
  if (!spec) return null;
  return {
    id,
    title: spec.title,
    icon: spec.root.icon ?? "📄",
    blurb: BLURBS[id] ?? spec.description,
    builtin: true,
    build: async ({ client, workspace }) => (await client.call("useTemplate", { workspace, template: id, parent: "" })).page,
  };
};

export const BLANK_TEMPLATE: OnboardingTemplate = { id: "blank", title: "Blank", icon: "📄", blurb: "Just Getting Started, and room for your first thought.", builtin: false, build: async () => null };

export const FEATURED_TEMPLATES: OnboardingTemplate[] = [...FEATURED_IDS.map(fromCatalog).filter((t): t is OnboardingTemplate => !!t), BLANK_TEMPLATE];
