import { randomHex } from "../shared/bytes";
import type { AgentDemoRun } from "../shared/protocol";

export type ToolHandlers = Record<string, (input: unknown) => Promise<unknown>>;

type Step = { label: string; tool: string; args: (ids: Record<string, string>) => Record<string, unknown>; keep?: string };

const idOf = (value: unknown): string => {
  const v = value as { page?: { id?: unknown }; database?: { id?: unknown } | string; id?: unknown } | null;
  const id = v?.page?.id ?? (typeof v?.database === "object" ? v.database?.id : v?.database) ?? v?.id;
  return typeof id === "string" ? id : "";
};

export const AGENT_DEMO_STEPS: Step[] = [
  { label: "Create a page", tool: "pages", keep: "page", args: () => ({ action: "create", title: "Launch plan", icon: "🚀" }) },
  { label: "Write an intro", tool: "content", args: (ids) => ({ action: "append", page: ids.page, markdown: "An agent is writing this page through the `ardia` command, one tool call at a time. No model runs here: this is a script of the same calls an agent makes." }) },
  { label: "Add goals", tool: "content", args: (ids) => ({ action: "append", page: ids.page, markdown: "## Goals\n\n- [x] Draft the plan\n- [ ] Ship the beta\n- [ ] Invite ten testers" }) },
  { label: "Add a callout", tool: "content", args: (ids) => ({ action: "append", page: ids.page, markdown: "> [!💡] Every edit here is saved like yours and shows up live in open pages." }) },
  { label: "Make a database", tool: "database", keep: "db", args: (ids) => ({ action: "create", parent: ids.page, inline: true, title: "Launch tasks", properties: [{ name: "Status", type: "status" }, { name: "Due", type: "date" }] }) },
  {
    label: "Add rows",
    tool: "rows",
    args: (ids) => ({
      action: "create",
      database: ids.db,
      rows: [
        { title: "Write release notes", properties: { Status: "In progress" } },
        { title: "Record the demo", properties: { Status: "Not started" } },
        { title: "Draft the plan", properties: { Status: "Done" } },
      ],
    }),
  },
  { label: "Show it as a board", tool: "views", args: (ids) => ({ action: "add", database: ids.db, type: "board", name: "Board", groupBy: { prop: "Status" } }) },
];

export function commandOf(tool: string, args: Record<string, unknown>): string {
  const json = JSON.stringify(args).replace(/'/g, "'\\''");
  return `ardia plugins call notes ${tool} '${json}'`;
}

export class AgentDemos {
  private readonly runs = new Map<string, AgentDemoRun>();

  constructor(private readonly handlers: () => ToolHandlers, private readonly wait: (ms: number) => Promise<void>, private readonly opened: (workspace: string, page: string) => void, private readonly pauseMs = 650) {}

  status(id: string): AgentDemoRun | null {
    const run = this.runs.get(id);
    return run ? { ...run, steps: run.steps.map((s) => ({ ...s })) } : null;
  }

  start(workspace: string): { job: string } {
    if ([...this.runs.values()].some((r) => r.state === "running")) throw new Error("A demo is already running.");
    const id = randomHex(6);
    const run: AgentDemoRun = { id, state: "running", page: null, steps: AGENT_DEMO_STEPS.map((s) => ({ label: s.label, command: "", done: false })) };
    this.runs.set(id, run);
    for (const key of [...this.runs.keys()]) if (this.runs.size > 4 && key !== id) this.runs.delete(key);
    void this.play(run, workspace);
    return { job: id };
  }

  private async play(run: AgentDemoRun, workspace: string) {
    const ids: Record<string, string> = {};
    const handlers = this.handlers();
    try {
      for (const [n, step] of AGENT_DEMO_STEPS.entries()) {
        const shown = step.args(ids);
        run.steps[n]!.command = commandOf(step.tool, shown);
        const result = await handlers[step.tool]!({ ...shown, ...(n === 0 ? { workspace } : {}) });
        if (step.keep) ids[step.keep] = idOf(result);
        if (step.keep === "page") {
          run.page = ids.page || null;
          if (run.page) this.opened(workspace, run.page);
        }
        run.steps[n]!.done = true;
        if (n < AGENT_DEMO_STEPS.length - 1) await this.wait(this.pauseMs);
      }
      run.state = "done";
    } catch (error) {
      run.state = "failed";
      run.error = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    }
  }
}
