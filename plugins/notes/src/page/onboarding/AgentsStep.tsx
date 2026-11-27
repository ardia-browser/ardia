import { useEffect, useRef, useState } from "react";
import { getPage } from "../../shared/model";
import type { AgentDemoRun, AgentStatus } from "../../shared/protocol";
import { useApp } from "../app/context";
import { useTreeVersion } from "../app/hooks";
import { Icon } from "../ui/icons";
import { PageBody } from "../view/PageBody";
import { StepFrame, type Exit } from "./Onboarding";
import { countStat } from "./stats";
import { goToStep, skipStep, updateOnboarding, type OnboardingState } from "./state";

const STATUS_POLL_MS = 2000;
const DEMO_POLL_MS = 200;
const COPIED_MS = 1600;

export const AGENT_PROMPTS = [
  "Turn my meeting notes from today into tasks in my Tasks database",
  "Summarise this week’s journal",
  "Import my Obsidian vault and tag pages by topic",
  "Build a reading-list database from these links",
];

export const AGENT_SETUP = [
  "Ardia Notes is available through the `ardia` command: every part of Notes is a tool, called as `ardia plugins call notes <tool> '<json>'`.",
  "Start with `ardia plugins call notes describe` to list every tool, action and field, and `ardia plugins call notes describe '{\"topic\":\"markdown\"}'` for the Markdown it reads and writes.",
  "Name a page by id, ardia://notes address or exact title. Errors name the field and the nearest valid value, so read them and retry.",
  "Your edits appear live in the user's open pages and save like theirs.",
].join("\n");

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return false;
    }
    setCopied(key);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(null), COPIED_MS);
    return true;
  };
  return { copied, copy };
}

function useAgentStatus() {
  const app = useApp();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const live = useRef(true);
  const refresh = () =>
    void app.client
      .call("agentStatus", {})
      .then((s) => live.current && setStatus(s))
      .catch(() => live.current && setStatus({ known: false, command: false, control: false }));
  useEffect(() => {
    live.current = true;
    refresh();
    const timer = setInterval(refresh, STATUS_POLL_MS);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, []);
  return { status, refresh };
}

function useDemo(initialJob: string | null) {
  const app = useApp();
  const [run, setRun] = useState<AgentDemoRun | null>(null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  const poll = (job: string) => {
    const tick = async () => {
      let next: AgentDemoRun | null = null;
      try {
        next = await app.client.call("agentDemoStatus", { job });
      } catch (e) {
        if (live.current) setError(e instanceof Error ? e.message : String(e));
        return;
      }
      if (!live.current) return;
      if (!next) {
        updateOnboarding({ agentDemoJob: null });
        return;
      }
      setRun(next);
      if (next.page) updateOnboarding({ agentDemoPage: next.page });
      if (next.state === "running") timer.current = setTimeout(() => void tick(), DEMO_POLL_MS);
      else updateOnboarding({ agentDemoJob: null });
    };
    void tick();
  };
  useEffect(() => {
    live.current = true;
    if (initialJob) poll(initialJob);
    return () => {
      live.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const start = async (workspace: string) => {
    setError("");
    setRun({ id: "", state: "running", page: null, steps: [] });
    try {
      const { job } = await app.client.call("agentDemo", { workspace });
      updateOnboarding({ agentDemoJob: job, agentDemoPage: null });
      countStat("agents.demo.run");
      poll(job);
    } catch (e) {
      setRun(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return { run, error, start };
}

type CmdToken = { kind: "cmd" | "key" | "str" | "lit" | "punct" | "space"; text: string };

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)|([{}\[\],:])|(\s+)|(.)/g;

export function commandTokens(command: string): CmdToken[] {
  const quote = command.indexOf(" '");
  if (quote < 0 || !command.endsWith("'")) return [{ kind: "cmd", text: command }];
  const out: CmdToken[] = [{ kind: "cmd", text: command.slice(0, quote + 2) }];
  const json = command.slice(quote + 2, -1);
  for (const m of json.matchAll(JSON_TOKEN)) {
    if (m[1] !== undefined) {
      out.push({ kind: m[2] ? "key" : "str", text: m[1] });
      if (m[2]) out.push({ kind: "punct", text: m[2] });
    } else if (m[3] !== undefined) out.push({ kind: "lit", text: m[3] });
    else if (m[4] !== undefined) out.push({ kind: "punct", text: m[4] });
    else if (m[5] !== undefined) out.push({ kind: "space", text: m[5] });
    else out.push({ kind: "str", text: m[6] ?? "" });
  }
  out.push({ kind: "cmd", text: "'" });
  return out;
}

function Command({ command }: { command: string }) {
  return (
    <code className="n-ag-line-cmd">
      {commandTokens(command).map((t, i) => (
        <span key={i} className={`n-ag-tok is-${t.kind}`}>
          {t.text}
        </span>
      ))}
    </code>
  );
}

const NARROW = "(max-width: 820px)";

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === "function" && matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia(NARROW);
    const changed = () => setNarrow(query.matches);
    changed();
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  return narrow;
}

function StatusRow({ on, known, title, detail, action, onAction, testId }: { on: boolean; known: boolean; title: string; detail: string; action: string; onAction: () => void; testId: string }) {
  return (
    <div className={`n-ag-status${on ? " is-on" : ""}`} data-testid={testId} data-on={on ? "true" : "false"}>
      <span className="n-ag-status-mark" aria-hidden="true">
        {on ? <Icon name="check" size={11} /> : null}
      </span>
      <span className="n-ag-status-text">
        <span className="n-ag-status-title">{title}</span>
        <span className="n-ag-status-detail">{on ? "On" : known ? detail : `Check: ${detail}`}</span>
      </span>
      {on ? null : (
        <button type="button" className="n-ob-secondary is-small" onClick={onAction} data-testid={`${testId}-open`}>
          {action}
        </button>
      )}
    </div>
  );
}

function LivePage({ workspace, page }: { workspace: string; page: string }) {
  const app = useApp();
  const tree = app.trees.get(workspace);
  useTreeVersion(tree);
  if (!tree || !getPage(tree, page)) return <div className="n-ag-live is-waiting" />;
  return (
    <div className="n-ag-live" data-testid="agents-demo-page">
      <div className="n-ag-live-scale" inert>
        <PageBody workspace={workspace} page={page} embedded composingComment={false} setComposingComment={() => {}} />
      </div>
    </div>
  );
}

function Demo({ state, onOpen }: { state: OnboardingState; onOpen: (page: string) => void }) {
  const app = useApp();
  const workspace = state.workspace && app.workspaces.some((w) => w.id === state.workspace) ? state.workspace : app.activeWorkspace;
  const { run, error, start } = useDemo(state.agentDemoJob);
  const log = useRef<HTMLOListElement>(null);
  const page = run?.page ?? state.agentDemoPage;
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run?.steps.filter((s) => s.done).length]);
  const running = run?.state === "running";
  return (
    <div className="n-ag-demo" data-testid="agents-demo" data-state={run?.state ?? "idle"}>
      <div className="n-ag-term">
        <div className="n-ag-term-head">
          <span className="n-ag-term-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="n-ob-eyebrow">Watch it work</span>
          <span className="n-spacer" />
          {run?.state === "done" && page ? (
            <button type="button" className="n-ob-primary is-small" onClick={() => onOpen(page)} data-testid="agents-demo-open">
              Open the demo page
            </button>
          ) : (
            <button type="button" className="n-ob-secondary is-small" onClick={() => void start(workspace)} disabled={running} data-testid="agents-demo-run">
              {running ? "Running…" : run ? "Run again" : "Run the demo"}
            </button>
          )}
        </div>
        {run && run.steps.length ? (
          <ol className="n-ag-log" ref={log} aria-live="polite" aria-label="Demo commands">
            {run.steps.map((s, i) => {
              const current = !s.done && run.steps.slice(0, i).every((x) => x.done) && running;
              return (
                <li key={i} className={`n-ag-line${s.done ? " is-done" : current ? " is-current" : ""}`} data-testid="agents-demo-step">
                  <span className="n-ag-line-mark" aria-hidden="true">
                    {s.done ? "✓" : current ? "›" : "·"}
                  </span>
                  <span className="n-ag-line-text">
                    <span className="n-ag-line-label">{s.label}</span>
                    {s.command ? <Command command={s.command} /> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="n-ag-term-empty">{error || (running ? "Starting…" : "A scripted run of real ardia commands, no model involved. It builds a page and a small database while you watch.")}</p>
        )}
        {run?.state === "failed" ? <p className="n-ag-term-error">{run.error || "The demo stopped."}</p> : null}
      </div>
      {page ? <LivePage workspace={workspace} page={page} /> : null}
    </div>
  );
}

export function AgentsStep({ state, exit }: { state: OnboardingState; exit: Exit }) {
  const app = useApp();
  const { status } = useAgentStatus();
  const { copied, copy } = useCopy();
  const known = status?.known !== false;
  const openSettings = (pane: "plugins" | "advanced") => {
    countStat(`agents.settings.${pane}`);
    void app.client.call("openArdiaSettings", { pane }).catch(() => {});
  };
  const narrow = useNarrow();
  const toTour = (page?: string) => exit(() => {
    if (page) updateOnboarding({ tourPage: page });
    goToStep("tour");
  });
  return (
    <StepFrame
      state={state}
      exit={exit}
      title="Let your agents write too."
      subtitle="Claude Code, Codex or any CLI agent can work in your notes through Ardia’s command line. Edits show up live and save like yours."
      primary="Continue"
      onPrimary={() => toTour()}
      onSkip={() => {
        skipStep("agents");
        toTour();
      }}
      preview={narrow ? undefined : <Demo state={state} onOpen={(page) => toTour(page)} />}
      previewInteractive
    >
      <div className="n-ag" data-testid="agents-step">
        <div className="n-ag-section">
          <div className="n-ob-eyebrow">Set up</div>
          {status === null ? (
            <div className="n-ag-status is-loading" />
          ) : (
            <div className="n-ag-statuses">
              <StatusRow on={status.command} known={known} title="Command Line plugin" detail="installs the ardia command" action="Open Plugins…" onAction={() => openSettings("plugins")} testId="agents-command" />
              <StatusRow on={status.control} known={known} title="Let programs control Ardia" detail="Settings › Advanced" action="Open Advanced…" onAction={() => openSettings("advanced")} testId="agents-control" />
            </div>
          )}
          <button
            type="button"
            className={`n-ag-copy is-setup${copied === "setup" ? " is-copied" : ""}`}
            onClick={() =>
              void copy("setup", AGENT_SETUP).then((ok) => {
                if (ok) countStat("agents.setup.copied");
              })
            }
            data-testid="agents-copy-setup"
          >
            <span className="n-ag-copy-text">Copy agent setup</span>
            <span className="n-ag-copy-hint">{copied === "setup" ? "Copied" : "paste into your agent’s instructions"}</span>
          </button>
        </div>
        <div className="n-ag-section">
          <div className="n-ob-eyebrow">Try asking</div>
          <div className="n-ag-prompts">
            {AGENT_PROMPTS.map((prompt, i) => (
              <button
                key={prompt}
                type="button"
                className={`n-ag-copy${copied === `p${i}` ? " is-copied" : ""}`}
                onClick={() =>
                  void copy(`p${i}`, prompt).then((ok) => {
                    if (ok) countStat(`agents.prompt.${i}.copied`);
                  })
                }
                aria-label={`Copy prompt: ${prompt}`}
                data-testid="agents-prompt"
              >
                <span className="n-ag-copy-text">“{prompt}”</span>
                <span className="n-ag-copy-hint">{copied === `p${i}` ? "Copied" : "Copy"}</span>
              </button>
            ))}
          </div>
        </div>
        {narrow ? (
          <div className="n-ag-section">
            <div className="n-ob-eyebrow">Watch it work</div>
            <div className="n-ag-inline-demo">
              <Demo state={state} onOpen={(page) => toTour(page)} />
            </div>
          </div>
        ) : null}
      </div>
    </StepFrame>
  );
}
