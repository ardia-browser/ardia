import { at, b, callout, database, db, divider, h3, i, p, page, span, todos } from "../dsl";
import type { TemplateSpec } from "../types";

const projectTracker: TemplateSpec = {
  id: "project-tracker",
  title: "Project tracker",
  description: "Projects and their tasks, linked. A board by status, a timeline of who's doing what when, and progress that adds itself up.",
  category: "work",
  tags: ["projects", "tasks", "board", "timeline", "gantt", "kanban", "planning"],
  root: page({
    key: "home",
    title: "Projects",
    icon: "🚀",
    cover: "gradient:7",
    fullWidth: true,
    blocks: [
      callout("🧭", ["Every project rolls up its tasks. Tick a task ", b("Done"), " and the project's progress bar moves on its own."], "blue"),
      database("projects", "board"),
      database("tasks", "mine"),
      divider(),
      p(i("Tip: open a project to see its brief, or drag a task between columns to change its status.")),
    ],
    children: [
      db({
        key: "projects",
        title: "Projects",
        icon: "📁",
        inline: true,
        titleName: "Project",
        properties: [
          { key: "status", name: "Status", type: "status", options: [{ name: "Planning", color: "gray", group: "todo" }, { name: "In progress", color: "blue", group: "doing" }, { name: "Paused", color: "orange", group: "doing" }, { name: "Done", color: "green", group: "done" }] },
          { key: "owner", name: "Owner", type: "person" },
          { key: "dates", name: "Dates", type: "date" },
          { key: "priority", name: "Priority", type: "select", options: [{ name: "High", color: "red" }, { name: "Medium", color: "yellow" }, { name: "Low", color: "gray" }] },
          { key: "tasks", name: "Tasks", type: "relation", relation: "tasks", twoWay: "Project" },
          { key: "progress", name: "Progress", type: "rollup", rollup: { relation: "tasks", target: "done", fn: "percent_checked" }, format: "percent", display: "bar", divideBy: 1, barColor: "green" },
          { key: "left", name: "Tasks left", type: "rollup", rollup: { relation: "tasks", target: "done", fn: "unchecked" } },
        ],
        views: [
          { key: "board", name: "Board", type: "board", group: { prop: "status" }, show: ["owner", "dates", "progress"], cardPreview: "none" },
          { key: "timeline", name: "Timeline", type: "timeline", date: "dates", zoom: "week", show: ["owner"] },
          { key: "all", name: "All projects", type: "table", sorts: [{ prop: "dates", dir: "asc" }], calcs: { title: "count", progress: "avg" } },
        ],
        rows: [
          { key: "p-launch", title: "Website relaunch", icon: "🌐", values: { status: "In progress", owner: ["me"], dates: span(-10, 14), priority: "High", tasks: ["t-copy", "t-design", "t-qa", "t-launch"] }, blocks: [h3("Goal"), p("Ship a faster, clearer site that turns visitors into sign-ups."), h3("Scope"), ...todos("New home and pricing pages", "Move the blog", "Redirects for every old address")] },
          { key: "p-onboard", title: "Customer onboarding revamp", icon: "🤝", values: { status: "Planning", owner: ["priya"], dates: span(7, 35), priority: "Medium", tasks: ["t-interviews", "t-flow"] } },
          { key: "p-q-report", title: "Quarterly report", icon: "📊", values: { status: "Done", owner: ["sam"], dates: span(-30, -12), priority: "Low", tasks: ["t-numbers"] } },
          { key: "p-hiring", title: "Hire a support lead", icon: "🧑‍💼", values: { status: "Paused", owner: ["alex"], dates: span(-4, 40), priority: "Medium", tasks: [] } },
        ],
      }),
      db({
        key: "tasks",
        title: "Tasks",
        icon: "✅",
        inline: true,
        titleName: "Task",
        properties: [
          { key: "done", name: "Done", type: "checkbox" },
          { key: "assignee", name: "Assignee", type: "person" },
          { key: "due", name: "Due", type: "date", dateFormat: "relative" },
          { key: "effort", name: "Effort", type: "select", options: [{ name: "S", color: "green" }, { name: "M", color: "yellow" }, { name: "L", color: "red" }] },
        ],
        views: [
          { key: "mine", name: "Open tasks", type: "table", filter: [{ prop: "done", cond: "unchecked" }], sorts: [{ prop: "due", dir: "asc" }] },
          { key: "calendar", name: "Calendar", type: "calendar", date: "due", show: ["assignee"] },
          { key: "everything", name: "All tasks", type: "list", show: ["done", "due", "assignee"] },
        ],
        rows: [
          { key: "t-copy", title: "Write the new home page copy", values: { done: true, assignee: ["me"], due: at(-3), effort: "M" } },
          { key: "t-design", title: "Final designs for pricing", values: { done: false, assignee: ["mei"], due: at(2), effort: "L" } },
          { key: "t-qa", title: "Check every redirect", values: { done: false, assignee: ["jordan"], due: at(9), effort: "S" } },
          { key: "t-launch", title: "Launch and announce", values: { done: false, assignee: ["me"], due: at(14), effort: "M" } },
          { key: "t-interviews", title: "Interview five new customers", values: { done: false, assignee: ["priya"], due: at(10), effort: "L" } },
          { key: "t-flow", title: "Sketch the first-week flow", values: { done: false, assignee: ["priya"], due: at(18), effort: "M" } },
          { key: "t-numbers", title: "Pull the quarter's numbers", values: { done: true, assignee: ["sam"], due: at(-20), effort: "S" } },
        ],
      }),
    ],
  }),
};

export const WORK: TemplateSpec[] = [projectTracker];
