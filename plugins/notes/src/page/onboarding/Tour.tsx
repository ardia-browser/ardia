import { useEffect, useRef, useState, type ReactNode } from "react";
import { childrenOf, displayTitle, getPage } from "../../shared/model";
import { useApp } from "../app/context";
import { Icon } from "../ui/icons";
import { countStat } from "./stats";
import { countOnce, finishOnboarding, skipStep, updateOnboarding, type OnboardingState } from "./state";
import { FEATURED_TEMPLATES } from "./templates";

type Stop = { id: string; title: string; body: ReactNode; done: string; watch?: () => () => boolean; cursor?: boolean };

const POLL_MS = 180;
const ADVANCE_MS = 1100;

const visible = (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector);
  return !!el && el.offsetParent !== null && !el.closest(".n-ghost");
};

const count = (selector: string) => document.querySelectorAll(selector).length;

const MARKDOWN_BLOCKS = ['heading', 'bulletListItem', 'numberedListItem', 'checkListItem', 'quote', 'toggleListItem'].map((t) => `.n-page-column .bn-block-content[data-content-type="${t}"]`).join(", ");
const DATABASE_BLOCKS = '.n-page-column [data-content-type="database"], .n-page-column [data-testid="db-view"]';

const STOPS: Stop[] = [
  {
    id: "slash",
    title: "Type / for any block",
    body: (
      <>
        Headings, to-dos, tables, images, code: press <kbd>/</kbd> on an empty line and start typing what you want.
      </>
    ),
    done: "That’s the block menu.",
    cursor: true,
    watch: () => () => visible('[data-testid="slash-menu"]'),
  },
  {
    id: "markdown",
    title: "Markdown works as you type",
    body: (
      <>
        Start a line with <kbd>#</kbd> and a space for a heading, <kbd>-</kbd> for a list or <kbd>[]</kbd> for a to-do.
      </>
    ),
    done: "Shortcut turned into a block.",
    cursor: true,
    watch: () => {
      const start = count(MARKDOWN_BLOCKS);
      return () => count(MARKDOWN_BLOCKS) > start;
    },
  },
  {
    id: "links",
    title: "Mention with @, link with [[",
    body: (
      <>
        Type <kbd>@</kbd> for a person, a page or a date, or <kbd>[[</kbd> to link another page. Links show up as backlinks on the other side.
      </>
    ),
    done: "Pick a page, or press Esc.",
    cursor: true,
    watch: () => () => visible('[data-testid="inline-menu"]'),
  },
  {
    id: "address",
    title: "Find a note from the address bar",
    body: (
      <>
        In Ardia’s address bar, type <kbd>n</kbd>, a space and a word, like <kbd>n getting</kbd>. Notes also answer beside web results, and <kbd>⌘K</kbd> searches in here.
      </>
    ),
    done: "",
  },
  {
    id: "database",
    title: "Make a database",
    body: (
      <>
        Type <kbd>/board</kbd> or <kbd>/table view</kbd>. Every row is a page of its own, with properties you can sort, filter and group.
      </>
    ),
    done: "Your first database.",
    cursor: true,
    watch: () => {
      const start = count(DATABASE_BLOCKS);
      return () => count(DATABASE_BLOCKS) > start;
    },
  },
];

export function Tour({ state }: { state: OnboardingState }) {
  const app = useApp();
  const workspace = state.workspace && app.workspaces.some((w) => w.id === state.workspace) ? state.workspace : app.activeWorkspace;
  const tree = app.trees.get(workspace);
  const index = Math.min(state.tourIndex, STOPS.length);
  const stop = STOPS[index] ?? null;
  const [hit, setHit] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const creating = useRef(false);

  const target = (() => {
    if (!tree) return null;
    for (const id of [state.tourPage, state.gettingStarted, state.importRoot]) if (id && getPage(tree, id) && !getPage(tree, id)!.deleted) return id;
    return childrenOf(tree, "").find((p) => !p.isTemplate)?.id ?? null;
  })();

  useEffect(() => {
    if (target || creating.current || !tree) return;
    creating.current = true;
    void app.client
      .call("applyStarter", { workspace, starter: "blank" })
      .then(({ page }) => updateOnboarding({ gettingStarted: page }))
      .catch(() => {})
      .finally(() => (creating.current = false));
  }, [target, !!tree]);

  useEffect(() => {
    if (!target) return;
    if (app.route.kind === "page" && app.route.page === target) return;
    app.openPage(target, { workspace });
  }, [target]);

  useEffect(() => {
    countOnce(`tour.${stop?.id ?? "finale"}.reached`);
    setHit(false);
    if (!stop?.watch) return;
    let check: (() => boolean) | null = null;
    const arm = setTimeout(() => (check = stop.watch!()), 250);
    let advance: ReturnType<typeof setTimeout> | null = null;
    const timer = setInterval(() => {
      if (!check || advance) return;
      if (check()) {
        setHit(true);
        countStat(`tour.${stop.id}.done`);
        advance = setTimeout(() => updateOnboarding((old) => ({ tourIndex: Math.max(old.tourIndex, index + 1) })), ADVANCE_MS);
      }
    }, POLL_MS);
    return () => {
      clearTimeout(arm);
      clearInterval(timer);
      if (advance) clearTimeout(advance);
    };
  }, [index]);

  const go = (next: number) => updateOnboarding({ tourIndex: Math.max(0, Math.min(STOPS.length, next)) });
  const end = (how: "done" | "skipped", then?: () => void) => {
    setLeaving(true);
    setTimeout(() => {
      if (how === "skipped") skipStep("tour");
      finishOnboarding("done");
      then?.();
    }, 260);
  };
  const placeCursor = () => {
    const tail = document.querySelector<HTMLElement>(".n-page-tail");
    if (tail) tail.click();
    else document.querySelector<HTMLElement>(".n-page-column .bn-editor")?.focus();
  };

  const built = Object.entries(state.built)
    .map(([id, page]) => ({ template: FEATURED_TEMPLATES.find((t) => t.id === id), page }))
    .filter((b) => b.template && tree && getPage(tree, b.page));
  const firstBuilt = built[0];
  const builtTitle = firstBuilt && tree ? displayTitle(getPage(tree, firstBuilt.page)) : "";

  return (
    <div
      ref={card}
      className={`n-tour${leaving ? " is-leaving" : ""}${hit ? " is-hit" : ""}`}
      role="region"
      aria-label="Tour"
      data-testid="tour"
      data-stop={stop?.id ?? "finale"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          end("skipped");
        }
      }}
    >
      <div className="n-tour-top">
        <span className="n-ob-eyebrow">{stop ? `Tour · ${index + 1} of ${STOPS.length}` : "Tour · done"}</span>
        <span className="n-tour-dots" aria-hidden="true">
          {STOPS.map((s, i) => (
            <span key={s.id} className={`n-tour-dot${i < index || (i === index && hit) ? " is-done" : i === index ? " is-on" : ""}`} />
          ))}
        </span>
      </div>
      <div className="n-tour-body" key={stop?.id ?? "finale"} aria-live="polite">
        {stop ? (
          <>
            <div className="n-tour-title">
              {hit ? (
                <span className="n-tour-check" aria-hidden="true">
                  <Icon name="check" size={12} />
                </span>
              ) : null}
              {hit ? stop.done : stop.title}
            </div>
            <p className="n-tour-text">{stop.body}</p>
          </>
        ) : (
          <>
            <div className="n-tour-title">You’re set.</div>
            <p className="n-tour-text">
              Everything lives in the sidebar. Press <kbd>⌘K</kbd> to find any note, and import more from the sidebar whenever you like.
            </p>
          </>
        )}
      </div>
      <div className="n-tour-actions">
        {stop ? (
          <>
            {index > 0 ? (
              <button type="button" className="n-ob-back is-small" aria-label="Previous" onClick={() => go(index - 1)} data-testid="tour-back">
                <Icon name="chevronLeft" size={14} />
              </button>
            ) : null}
            {stop.cursor ? (
              <button type="button" className="n-ob-secondary is-small" onClick={placeCursor} data-testid="tour-try">
                Try it here
              </button>
            ) : null}
            <button type="button" className="n-ob-primary is-small" onClick={() => go(index + 1)} data-testid="tour-next" autoFocus={!stop.cursor}>
              {stop.watch ? "Next" : "Got it"}
            </button>
            <span className="n-spacer" />
            <button type="button" className="n-ob-link" onClick={() => end("skipped")} data-testid="tour-skip">
              Skip tour
            </button>
          </>
        ) : (
          <>
            {firstBuilt ? (
              <button type="button" className="n-ob-primary is-small" autoFocus onClick={() => end("done", () => app.openPage(firstBuilt.page, { workspace }))} data-testid="tour-open-template">
                Open {builtTitle}
              </button>
            ) : null}
            <button type="button" className={firstBuilt ? "n-ob-secondary is-small" : "n-ob-primary is-small"} autoFocus={!firstBuilt} onClick={() => end("done")} data-testid="tour-finish">
              {firstBuilt ? "Stay here" : "Start writing"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
