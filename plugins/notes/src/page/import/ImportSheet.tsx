import { useEffect, useRef, useState } from "react";
import { FEATURED_SOURCES, importSource, type ImportPick, type ImportSourceId } from "../../shared/importSources";
import { useApp } from "../app/context";
import { Icon } from "../ui/icons";
import { reducedMotion } from "../ui/motion";
import { countStat } from "../onboarding/stats";
import { ImportProgress } from "./ImportProgress";
import { OTHER_SOURCES, SourceDetail, SourceGrid } from "./ImportSources";
import { closeImportSheet, useImportSheetRequest } from "./importSheetStore";
import { useImportJob } from "./useImportJob";
import "./import.css";

const LEAVE_MS = 220;
const DONE_BEAT_MS = 700;

export function ImportSheetHost() {
  const request = useImportSheetRequest();
  const [shown, setShown] = useState(request);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (request) {
      setShown(request);
      setLeaving(false);
      return;
    }
    if (!shown) return;
    setLeaving(true);
    const timer = setTimeout(
      () => {
        setShown(null);
        setLeaving(false);
      },
      reducedMotion() ? 0 : LEAVE_MS,
    );
    return () => clearTimeout(timer);
  }, [request]);
  if (!shown) return null;
  return <ImportSheet key={shown.at} initial={shown.source} leaving={leaving} />;
}

export function trapFocus(event: React.KeyboardEvent, root: HTMLElement | null) {
  if (event.key !== "Tab" || !root) return;
  const focusable = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"], a[href]')].filter((el) => el.offsetParent !== null && el.tabIndex >= 0);
  if (!focusable.length) return;
  const index = focusable.indexOf(document.activeElement as HTMLElement);
  const next = index < 0 ? (event.shiftKey ? focusable.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length;
  event.preventDefault();
  focusable[next]!.focus();
}

function ImportSheet({ initial, leaving }: { initial: ImportSourceId | null; leaving: boolean }) {
  const app = useApp();
  const workspace = app.activeWorkspace;
  const [selected, setSelected] = useState<ImportSourceId | null>(initial);
  const [showOthers, setShowOthers] = useState(!!initial && !FEATURED_SOURCES.includes(initial));
  const lastPick = useRef<ImportPick>("file");
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(document.activeElement);
  const { run, start, resume, cancel, reset } = useImportJob(app.client, workspace, {
    onDone: (job) => {
      countStat("import.done");
      setTimeout(() => {
        if (job.root) app.openPage(job.root, { workspace: job.workspace });
        closeImportSheet();
      }, DONE_BEAT_MS);
    },
  });

  useEffect(() => {
    let live = true;
    void app.client
      .call("importStatus", {})
      .then((job) => {
        if (!live || !job) return;
        if (job.state === "reading" || job.state === "writing") {
          setSelected(job.source);
          if (!FEATURED_SOURCES.includes(job.source)) setShowOthers(true);
          resume(job.id);
        }
      })
      .catch(() => {});
    panel.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
    return () => {
      live = false;
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
    };
  }, []);

  const focusTile = () => requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(selected ? `[data-testid="import-source-${selected}"]` : '[tabindex="0"]')?.focus());

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (run.phase === "failed" || run.phase === "cancelled") {
        reset();
        focusTile();
      } else if (!showingProgress && selected && document.activeElement?.closest(".n-imp-detail")) focusTile();
      else closeImportSheet();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const begin = (pick: ImportPick) => {
    if (!selected) return;
    lastPick.current = pick;
    countStat(`import.source.${selected}`);
    void start(selected, pick);
  };

  const showingProgress = run.phase !== "idle" && run.phase !== "picking";
  const source = selected ? importSource(selected) : null;

  return (
    <div
      className={`n-imp-scrim${leaving ? " is-leaving" : ""}`}
      onMouseDown={(e) => e.target === e.currentTarget && closeImportSheet()}
      onKeyDown={(e) => trapFocus(e, panel.current)}
    >
      <div ref={panel} className="n-imp-sheet" role="dialog" aria-modal="true" aria-labelledby="n-imp-title" data-testid="import-sheet">
        <header className="n-imp-sheet-head">
          <div>
            <div className="n-ob-eyebrow">Import</div>
            <h2 id="n-imp-title" className="n-ob-title is-small">
              Bring your notes
            </h2>
          </div>
          <button type="button" className="n-imp-close" aria-label="Close" onClick={closeImportSheet} data-testid="import-close">
            <Icon name="x" />
          </button>
        </header>
        {showingProgress ? (
          <div className="n-imp-sheet-body">
            <ImportProgress
              run={run}
              onCancel={() => void cancel()}
              onRetry={() => run.source && void start(run.source, lastPick.current)}
              onBack={() => {
                reset();
                focusTile();
              }}
              onOpen={run.job?.root ? () => (app.openPage(run.job!.root!, { workspace: run.job!.workspace }), closeImportSheet()) : undefined}
              openLabel="Open the import"
            />
          </div>
        ) : (
          <div className="n-imp-sheet-body">
            <p className="n-imp-lede">Pages, databases, links and attachments come along. Everything lands in one new page you can move anywhere.</p>
            <SourceGrid selected={selected && FEATURED_SOURCES.includes(selected) ? selected : null} onSelect={setSelected} size="large" />
            {showOthers ? (
              <div className="n-imp-others" data-testid="import-others">
                <div className="n-ob-eyebrow">Other formats</div>
                <SourceGrid sources={OTHER_SOURCES} selected={selected && !FEATURED_SOURCES.includes(selected) ? selected : null} onSelect={setSelected} size="small" label="Other formats" testId="import-other-sources" />
              </div>
            ) : (
              <button
                type="button"
                className="n-ob-link n-imp-others-toggle"
                onClick={() => {
                  setShowOthers(true);
                  requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('[data-testid="import-other-sources"] [tabindex="0"]')?.focus());
                }}
                data-testid="import-show-others"
              >
                Other formats…
              </button>
            )}
            {source ? <SourceDetail source={source} onStart={begin} busy={run.phase === "picking"} /> : <div className="n-imp-detail is-empty">Choose where your notes live now.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
