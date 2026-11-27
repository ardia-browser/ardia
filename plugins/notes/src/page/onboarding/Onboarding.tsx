import { useEffect, useRef, useState, type ReactNode } from "react";
import { importSource, type ImportPick, type ImportSourceId } from "../../shared/importSources";
import { childrenOf, getPage } from "../../shared/model";
import { useApp } from "../app/context";
import type { PageId } from "../../shared/protocol";
import { Icon } from "../ui/icons";
import { reducedMotion } from "../ui/motion";
import { toast } from "../ui/toast";
import { ImportProgress } from "../import/ImportProgress";
import { onGridKey, SourceDetail, SourceGrid } from "../import/ImportSources";
import { trapFocus } from "../import/ImportSheet";
import { useWorkspaceEmpty } from "../import/ImportEmptyState";
import { useImportJob } from "../import/useImportJob";
import { countStat } from "./stats";
import {
  STEP_LABELS,
  STEPS,
  finishOnboarding,
  goToStep,
  markOnboardingSeen,
  setReplayHandler,
  skipStep,
  startOnboarding,
  updateOnboarding,
  useOnboardingState,
  type OnboardingState,
  type OnboardingStep,
} from "./state";
import { FEATURED_TEMPLATES, type OnboardingTemplate } from "./templates";
import { TemplatePreviewPane, TogetherPreview, WelcomePreview } from "./Previews";
import { openGallery, useGalleryRequest } from "../templates/store";
import { Tour } from "./Tour";
import { AgentsStep } from "./AgentsStep";
import "./onboarding.css";

export const AVATAR_COLORS = ["#C07A98", "#4691C3", "#7873AF", "#D37B8B", "#C1575C", "#D87249", "#E3AC38", "#3EB489", "#8E8E93"];

function rgbOf(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function nearestAvatarColor(color: string): string {
  const exact = AVATAR_COLORS.find((c) => c.toLowerCase() === color.toLowerCase());
  if (exact) return exact;
  const rgb = rgbOf(color);
  if (!rgb) return AVATAR_COLORS[1]!;
  let best = AVATAR_COLORS[1]!;
  let bestDistance = Infinity;
  for (const c of AVATAR_COLORS) {
    const other = rgbOf(c)!;
    const distance = (rgb[0] - other[0]) ** 2 + (rgb[1] - other[1]) ** 2 + (rgb[2] - other[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  return best;
}

const LEAVE_MS = 420;

export function OnboardingHost({ synced }: { synced: boolean }) {
  const app = useApp();
  const state = useOnboardingState();
  const empty = useWorkspaceEmpty(app.activeWorkspace);
  const hasTree = !!app.trees.get(app.activeWorkspace);
  const gallery = useGalleryRequest();
  useEffect(() => {
    setReplayHandler(() => startOnboarding(app.activeWorkspace, app.me.name, app.me.color, true));
    return () => setReplayHandler(null);
  }, [app.activeWorkspace, app.me.name, app.me.color]);
  useEffect(() => {
    if (!synced || state || !app.activeWorkspace || !hasTree) return;
    if (empty) startOnboarding(app.activeWorkspace, app.me.name, app.me.color);
    else markOnboardingSeen(app.activeWorkspace);
  }, [synced, state, empty, hasTree, app.activeWorkspace]);
  if (!state || state.status !== "active") return null;
  if (gallery) return null;
  if (state.step === "tour") return <Tour state={state} />;
  return <Overlay state={state} />;
}

export type Exit = (then: () => void) => void;

function Overlay({ state }: { state: OnboardingState }) {
  const [leaving, setLeaving] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const exit: Exit = (then) => {
    setLeaving(true);
    setTimeout(then, reducedMotion() ? 0 : LEAVE_MS);
  };
  useEffect(() => {
    const previous = opener.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest(".n-ob-scrim")) previous.focus();
    };
  }, []);
  const props = { state, exit };
  return (
    <div className={`n-ob-scrim${leaving ? " is-leaving" : ""}`} data-testid="onboarding" data-step={state.step} onKeyDown={(e) => trapFocus(e, card.current)}>
      <div ref={card} className="n-ob-card" role="dialog" aria-modal="true" aria-labelledby="n-ob-title">
        {state.step === "welcome" ? <WelcomeStep {...props} /> : null}
        {state.step === "import" ? <ImportStep {...props} /> : null}
        {state.step === "template" ? <TemplateStep {...props} /> : null}
        {state.step === "together" ? <TogetherStep {...props} /> : null}
        {state.step === "agents" ? <AgentsStep {...props} /> : null}
      </div>
    </div>
  );
}

function back(step: OnboardingStep) {
  const index = STEPS.indexOf(step);
  if (index > 0) updateOnboarding({ step: STEPS[index - 1] });
}

export function StepFrame({
  state,
  exit,
  title,
  subtitle,
  children,
  preview,
  previewInteractive,
  primary,
  onPrimary,
  primaryDisabled,
  onSkip,
  skipLabel = "Skip",
  extraActions,
  wide,
}: {
  state: OnboardingState;
  exit: Exit;
  title: string;
  subtitle: string;
  children?: ReactNode;
  preview?: ReactNode;
  previewInteractive?: boolean;
  primary: string;
  onPrimary: () => void;
  primaryDisabled?: boolean;
  onSkip?: () => void;
  skipLabel?: string;
  extraActions?: ReactNode;
  wide?: boolean;
}) {
  const index = STEPS.indexOf(state.step);
  const first = index === 0;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (!first) back(state.step);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [first, state.step]);
  return (
    <div className={`n-ob-frame${wide ? " is-wide" : ""}`}>
      <div className="n-ob-column">
        <div className="n-ob-top n-ob-reveal" style={{ ["--d" as string]: "0ms" }}>
          <div className="n-ob-bars" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span key={s} className={`n-ob-bar${i <= index ? " is-on" : ""}`} />
            ))}
          </div>
          <div className="n-ob-topline">
            <span className="n-ob-eyebrow" data-testid="onboarding-eyebrow">
              Step {String(index + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")} · {STEP_LABELS[state.step]}
            </span>
            <button
              type="button"
              className="n-ob-link n-ob-skip-all"
              data-testid="onboarding-skip-all"
              onClick={() =>
                exit(() => {
                  skipStep(state.step);
                  finishOnboarding("skipped");
                })
              }
            >
              Skip setup
            </button>
          </div>
        </div>
        <div className="n-ob-body" key={state.step}>
          <div className="n-ob-reveal" style={{ ["--d" as string]: "60ms" }}>
            <h1 id="n-ob-title" className="n-ob-title">
              {title}
            </h1>
            <p className="n-ob-subtitle">{subtitle}</p>
          </div>
          <div className="n-ob-content n-ob-reveal" style={{ ["--d" as string]: "140ms" }}>
            {children}
          </div>
        </div>
        <div className="n-ob-actions n-ob-reveal" style={{ ["--d" as string]: "240ms" }}>
          {first ? null : (
            <button type="button" className="n-ob-back" aria-label="Back" title="Back (Esc)" onClick={() => back(state.step)} data-testid="onboarding-back">
              <Icon name="chevronLeft" />
            </button>
          )}
          <button type="button" className="n-ob-primary" onClick={onPrimary} disabled={primaryDisabled} data-testid="onboarding-continue">
            {primary}
          </button>
          {onSkip ? (
            <button type="button" className="n-ob-link" onClick={onSkip} data-testid="onboarding-skip">
              {skipLabel}
            </button>
          ) : null}
          {extraActions}
        </div>
      </div>
      {preview ? (
        <div className="n-ob-preview n-ob-reveal" style={{ ["--d" as string]: "120ms" }} aria-hidden={previewInteractive ? undefined : "true"}>
          {preview}
        </div>
      ) : null}
    </div>
  );
}

function WelcomeStep({ state, exit }: { state: OnboardingState; exit: Exit }) {
  const app = useApp();
  const [name, setName] = useState(state.name || app.me.name);
  const [color, setColor] = useState(() => nearestAvatarColor(state.color || app.me.color || AVATAR_COLORS[1]!));
  const swatches = useRef<HTMLDivElement>(null);
  useEffect(() => {
    updateOnboarding({ name, color });
  }, [name, color]);
  const next = () => {
    const trimmed = name.trim();
    if (trimmed !== app.me.name || color !== app.me.color) void app.client.call("setMe", { ...(trimmed ? { name: trimmed } : {}), color }).catch(() => {});
    goToStep("import");
  };
  const selectedIndex = Math.max(0, AVATAR_COLORS.findIndex((c) => c.toLowerCase() === color.toLowerCase()));
  return (
    <StepFrame
      state={state}
      exit={exit}
      title="Notes, at home in Ardia."
      subtitle="Pages, databases and links that live on this Mac and open from the address bar. First, what should people call you?"
      primary="Continue"
      onPrimary={next}
      preview={<WelcomePreview name={name.trim() || "You"} color={color} />}
    >
      <form
        className="n-ob-form"
        onSubmit={(e) => {
          e.preventDefault();
          next();
        }}
      >
        <label className="n-ob-label" htmlFor="n-ob-name">
          Your name
        </label>
        <input
          id="n-ob-name"
          className="n-ob-input"
          value={name}
          autoFocus
          autoComplete="name"
          spellCheck={false}
          placeholder="The name you go by"
          maxLength={60}
          data-testid="onboarding-name"
          onChange={(e) => setName(e.target.value)}
        />
        <div className="n-ob-label" id="n-ob-color-label">
          Your colour <span className="n-ob-label-note">for your cursor and avatar</span>
        </div>
        <div
          ref={swatches}
          className="n-ob-swatches"
          role="radiogroup"
          aria-labelledby="n-ob-color-label"
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") return;
            onGridKey(e, swatches.current, "[data-swatch]");
            const focused = document.activeElement as HTMLElement | null;
            const value = focused?.dataset.swatch;
            if (value && /^Arrow|^Home$|^End$/.test(e.key)) setColor(value);
          }}
        >
          {AVATAR_COLORS.map((c, i) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={i === selectedIndex}
              aria-label={c}
              tabIndex={i === selectedIndex ? 0 : -1}
              className={`n-ob-swatch${i === selectedIndex ? " is-selected" : ""}`}
              style={{ ["--c" as string]: c }}
              data-swatch={c}
              data-testid="onboarding-swatch"
              onClick={() => setColor(c)}
            />
          ))}
        </div>
      </form>
    </StepFrame>
  );
}

function ImportStep({ state, exit }: { state: OnboardingState; exit: Exit }) {
  const app = useApp();
  const workspace = state.workspace && app.workspaces.some((w) => w.id === state.workspace) ? state.workspace : app.activeWorkspace;
  const [selected, setSelected] = useState<ImportSourceId | "fresh" | null>(state.importSource);
  const lastPick = useRef<ImportPick>("file");
  const { run, start, resume, cancel, reset } = useImportJob(app.client, workspace, {
    onJob: (job) => updateOnboarding({ importJob: job }),
    onDone: (job) => {
      countStat("import.done");
      updateOnboarding({ importRoot: job.root ?? null, importJob: null });
    },
  });
  useEffect(() => {
    if (state.importJob) resume(state.importJob);
  }, []);
  useEffect(() => {
    updateOnboarding({ importSource: selected });
  }, [selected]);
  const begin = (pick: ImportPick) => {
    if (!selected || selected === "fresh") return;
    lastPick.current = pick;
    countStat(`import.source.${selected}`);
    void start(selected, pick);
  };
  const source = selected && selected !== "fresh" ? importSource(selected) : null;
  const showingProgress = run.phase !== "idle" && run.phase !== "picking";
  const running = run.phase === "running" || run.phase === "picking";
  const imported = run.phase === "done" || (run.phase === "idle" && !!source && !!state.importRoot && state.importSource === selected);
  const next = () => {
    if (selected === "fresh") countStat("import.fresh");
    goToStep("template");
  };
  return (
    <StepFrame
      state={state}
      exit={exit}
      wide
      title="Bring your notes."
      subtitle="Pick where they live now. Pages, databases, links and attachments land in one new page you can move anywhere."
      primary={running ? "Importing…" : "Continue"}
      primaryDisabled={running || (!imported && selected !== "fresh")}
      onPrimary={next}
      onSkip={() => {
        skipStep("import");
        goToStep("template");
      }}
    >
      {showingProgress ? (
        <ImportProgress
          run={run}
          onCancel={() => void cancel()}
          onRetry={() => run.source && void start(run.source, lastPick.current)}
          onBack={reset}
        />
      ) : (
        <>
          <SourceGrid
            size="large"
            selected={selected === "fresh" ? null : selected}
            onSelect={(id) => setSelected(id)}
            label="Where your notes live now"
            extra={
              <button
                type="button"
                role="radio"
                aria-checked={selected === "fresh"}
                tabIndex={-1}
                className={`n-imp-tile is-fresh${selected === "fresh" ? " is-selected" : ""}`}
                data-grid-item
                data-testid="import-source-fresh"
                onClick={() => setSelected("fresh")}
              >
                <span className="n-imp-monogram is-fresh" style={{ width: 38, height: 38, fontSize: 18 }} aria-hidden="true">
                  ✦
                </span>
                <span className="n-imp-tile-title">Start fresh</span>
              </button>
            }
          />
          {source ? (
            imported ? (
              <div className="n-imp-detail" data-testid="import-detail">
                <div className="n-imp-detail-text">
                  <div className="n-imp-detail-title">Imported from {source.title}</div>
                  <p className="n-imp-detail-hint">It’s waiting in your sidebar. Continue, or import from somewhere else too.</p>
                </div>
              </div>
            ) : (
              <SourceDetail source={source} onStart={begin} busy={run.phase === "picking"} />
            )
          ) : (
            <div className={`n-imp-detail is-empty${selected === "fresh" ? " is-fresh" : ""}`}>{selected === "fresh" ? "A clean slate. You can import any time from the sidebar or Settings." : "Choose a source to see how to bring it in."}</div>
          )}
        </>
      )}
    </StepFrame>
  );
}

let galleryBefore: Set<string> | null = null;

function TemplateStep({ state, exit }: { state: OnboardingState; exit: Exit }) {
  const app = useApp();
  const workspace = state.workspace && app.workspaces.some((w) => w.id === state.workspace) ? state.workspace : app.activeWorkspace;
  const [busy, setBusy] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const chosen = FEATURED_TEMPLATES.find((t) => t.id === state.template) ?? FEATURED_TEMPLATES[FEATURED_TEMPLATES.length - 1]!;
  const choose = (t: OnboardingTemplate) => updateOnboarding({ template: t.id });
  const apply = async (fromGallery?: PageId) => {
    if (busy) return;
    setBusy(true);
    try {
      let gettingStarted = state.gettingStarted;
      const tree = app.trees.get(workspace);
      const remembered = gettingStarted && tree ? getPage(tree, gettingStarted) : null;
      const seeded = tree ? childrenOf(tree, "").find((p) => p.title === "Getting Started" && p.icon === "👋") : undefined;
      const existing = remembered && !remembered.deleted && !remembered.archivedAt ? remembered : (seeded ?? null);
      if (existing && existing.id !== gettingStarted) {
        gettingStarted = existing.id;
        updateOnboarding({ gettingStarted: existing.id });
      }
      if (!existing) {
        const { page } = await app.client.call("applyStarter", { workspace, starter: "blank" });
        gettingStarted = page;
        updateOnboarding({ gettingStarted: page });
      }
      if (fromGallery) updateOnboarding((old) => ({ built: { ...old.built, gallery: fromGallery } }));
      else if (chosen.id !== "blank" && !state.built[chosen.id]) {
        const page = await chosen.build({ client: app.client, workspace });
        if (page) updateOnboarding((old) => ({ built: { ...old.built, [chosen.id]: page } }));
      }
      countStat(`template.${fromGallery ? "gallery-used" : chosen.id}`);
      goToStep("together");
    } catch (error) {
      toast(`Couldn’t set up ${chosen.title}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };
  const selectedIndex = FEATURED_TEMPLATES.indexOf(chosen);
  useEffect(() => {
    const before = galleryBefore;
    galleryBefore = null;
    const tree = app.trees.get(workspace);
    if (!before || !tree) return;
    const added = childrenOf(tree, "").find((p) => !p.isTemplate && !before.has(p.id));
    if (added) void apply(added.id);
  }, []);
  const browseAll = () => {
    const tree = app.trees.get(workspace);
    galleryBefore = new Set(tree ? childrenOf(tree, "").map((p) => p.id) : []);
    countStat("template.gallery");
    openGallery({ source: "onboarding", workspace, parent: "" });
  };
  return (
    <StepFrame
      state={state}
      exit={exit}
      title="Start from a template."
      subtitle="Getting Started comes with every choice. You can add more any time from Templates."
      primary={busy ? "Setting up…" : chosen.id === "blank" ? "Start blank" : `Use ${chosen.title}`}
      primaryDisabled={busy}
      onPrimary={() => void apply()}
      extraActions={
        <button type="button" className="n-ob-link" onClick={browseAll} data-testid="onboarding-browse-templates">
          Browse all templates
        </button>
      }
      preview={<TemplatePreviewPane template={chosen} />}
    >
      <div
        ref={list}
        className="n-ob-options"
        role="radiogroup"
        aria-label="Templates"
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const next = FEATURED_TEMPLATES[(selectedIndex + (e.key === "ArrowDown" ? 1 : -1) + FEATURED_TEMPLATES.length) % FEATURED_TEMPLATES.length]!;
          choose(next);
          requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-template="${next.id}"]`)?.focus());
        }}
      >
        {FEATURED_TEMPLATES.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={t.id === chosen.id}
            tabIndex={t.id === chosen.id ? 0 : -1}
            autoFocus={t.id === chosen.id}
            className={`n-ob-option${t.id === chosen.id ? " is-selected" : ""}`}
            data-template={t.id}
            data-testid={`onboarding-template-${t.id}`}
            onClick={() => choose(t)}
            onDoubleClick={() => void apply()}
            style={{ ["--i" as string]: i }}
          >
            <span className="n-ob-option-icon">{t.icon}</span>
            <span className="n-ob-option-text">
              <span className="n-ob-option-title">
                {t.title}
                {state.built[t.id] ? <span className="n-ob-option-badge">Added</span> : null}
              </span>
              <span className="n-ob-option-sub">{t.blurb}</span>
            </span>
            <span className="n-ob-radio" aria-hidden="true" />
          </button>
        ))}
      </div>
    </StepFrame>
  );
}

function TogetherStep({ state, exit }: { state: OnboardingState; exit: Exit }) {
  const app = useApp();
  const first = (state.name || app.me.name).trim().split(/\s+/)[0] ?? "";
  const [name, setName] = useState(first ? `${first}’s shared notes` : "Shared notes");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const toTour = () => goToStep("agents");
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy("create");
    try {
      const info = await app.client.call("createSharedWorkspace", { name: name.trim() });
      if (info) {
        countStat("together.created");
        updateOnboarding({ shared: { kind: "created", workspace: info.id, name: info.name } });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  const join = async () => {
    if (busy) return;
    setBusy("join");
    try {
      const info = await app.client.call("joinSharedWorkspace", {});
      if (info) {
        countStat("together.joined");
        updateOnboarding({ shared: { kind: "joined", workspace: info.id, name: info.name } });
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <StepFrame
      state={state}
      exit={exit}
      title="Work together."
      subtitle="A shared workspace is a folder in iCloud Drive. Invite people the way you share any folder on a Mac, and everyone’s edits and cursors show up live."
      primary="Continue"
      onPrimary={toTour}
      onSkip={
        state.shared
          ? undefined
          : () => {
              skipStep("together");
              toTour();
            }
      }
      skipLabel="Not now"
      preview={<TogetherPreview name={state.name || app.me.name || "You"} color={state.color || app.me.color} shared={state.shared?.name ?? null} />}
    >
      {state.shared ? (
        <div className="n-ob-done" role="status" data-testid="onboarding-shared">
          <span className="n-ob-done-mark" aria-hidden="true">
            <Icon name="check" size={14} />
          </span>
          <div>
            <div className="n-ob-done-title">
              {state.shared.kind === "created" ? "Created" : "Joined"} “{state.shared.name}”
            </div>
            <div className="n-ob-done-sub">{state.shared.kind === "created" ? "Invite people with Share… next to it in Settings, or from the sidebar." : "It’s in your sidebar. Pages appear as iCloud brings them down."}</div>
          </div>
        </div>
      ) : (
        <div className="n-ob-together">
          <form
            className="n-ob-choice"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="n-ob-choice-title">Start a shared workspace</div>
            <div className="n-ob-choice-row">
              <input className="n-ob-input is-compact" value={name} aria-label="Shared workspace name" maxLength={60} onChange={(e) => setName(e.target.value)} data-testid="onboarding-shared-name" />
              <button type="submit" className="n-ob-secondary" disabled={!name.trim() || !!busy} data-testid="onboarding-create-shared">
                {busy === "create" ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
          <div className="n-ob-choice">
            <div className="n-ob-choice-title">Someone invited you?</div>
            <div className="n-ob-choice-row">
              <span className="n-ob-choice-sub">Accept their iCloud invite, then pick the folder.</span>
              <button type="button" className="n-ob-secondary" onClick={() => void join()} disabled={!!busy} data-testid="onboarding-join-shared">
                {busy === "join" ? "Choosing…" : "Join…"}
              </button>
            </div>
          </div>
        </div>
      )}
    </StepFrame>
  );
}
