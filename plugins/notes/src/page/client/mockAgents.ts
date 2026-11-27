import type { AgentDemoRun, AgentStatus, PageId, WorkspaceId } from "../../shared/protocol";

type DemoHooks = {
  createPage: (workspace: WorkspaceId, input: { parent: PageId | ""; kind: "page" | "database"; title: string; icon?: string }) => PageId;
  writePage: (workspace: WorkspaceId, page: PageId, blocks: Record<string, unknown>[]) => void;
};

const cmd = (tool: string, args: Record<string, unknown>) => `ardia plugins call notes ${tool} '${JSON.stringify(args)}'`;

export function createMockAgents(hooks: DemoHooks) {
  const params = new URLSearchParams(location.search);
  const status: AgentStatus = { known: !params.has("agentUnknown"), command: false, control: false };
  const runs = new Map<string, AgentDemoRun>();
  const stepMs = Number(params.get("agentDemoMs") ?? 2000) / 6;

  const intro: Record<string, unknown>[] = [{ type: "paragraph", content: "Written by an agent through the ardia command, while you watched." }];
  const plan: Record<string, unknown>[] = [
    ...intro,
    { type: "heading", props: { level: 2 }, content: "This week" },
    { type: "checkListItem", props: { checked: false }, content: "Draft the launch post" },
    { type: "checkListItem", props: { checked: false }, content: "Review the roadmap with the team" },
  ];
  const full: Record<string, unknown>[] = [...plan, { type: "heading", props: { level: 2 }, content: "Notes" }, { type: "paragraph", content: "Edits from agents save like yours and show up live in open pages." }];

  return {
    status: (): AgentStatus => ({ ...status }),
    openSettings(pane: "plugins" | "advanced") {
      setTimeout(() => {
        if (pane === "plugins") status.command = true;
        else status.control = true;
      }, 300);
      return { ok: true };
    },
    start(workspace: WorkspaceId): { job: string } {
      const id = Math.random().toString(16).slice(2, 14);
      let page: PageId | null = null;
      const script: { label: string; command: string; run: () => void }[] = [
        { label: "Look around", command: cmd("pages", { action: "tree" }), run: () => {} },
        { label: "Create a page", command: cmd("pages", { action: "create", title: "Agent demo" }), run: () => (page = hooks.createPage(workspace, { parent: "", kind: "page", title: "Agent demo", icon: "🤖" })) },
        { label: "Write an intro", command: cmd("content", { action: "set", page: "Agent demo", markdown: "Written by an agent…" }), run: () => page && hooks.writePage(workspace, page, intro) },
        { label: "Add a plan", command: cmd("content", { action: "append", page: "Agent demo", markdown: "## This week\n- [ ] …" }), run: () => page && hooks.writePage(workspace, page, plan) },
        { label: "Make a database", command: cmd("database", { action: "create", title: "Demo tasks", parent: "Agent demo" }), run: () => page && hooks.createPage(workspace, { parent: page, kind: "database", title: "Demo tasks", icon: "✅" }) },
        { label: "Finish the notes", command: cmd("content", { action: "append", page: "Agent demo", markdown: "## Notes\n…" }), run: () => page && hooks.writePage(workspace, page, full) },
      ];
      const run: AgentDemoRun = { id, state: "running", page: null, steps: script.map((s) => ({ label: s.label, command: s.command, done: false })) };
      runs.set(id, run);
      script.forEach((s, i) =>
        setTimeout(
          () => {
            s.run();
            const current = runs.get(id)!;
            const steps = current.steps.map((step, j) => (j === i ? { ...step, done: true } : step));
            runs.set(id, { ...current, page, steps, state: i === script.length - 1 ? "done" : "running" });
          },
          Math.round(stepMs * (i + 1)),
        ),
      );
      return { job: id };
    },
    demoStatus: (job: string): AgentDemoRun | null => runs.get(job) ?? null,
  };
}
