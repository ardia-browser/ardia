import { importSource } from "../../shared/importSources";
import { Monogram, SourceIcon } from "./ImportSources";
import { importFraction, type ImportRun } from "./useImportJob";
import "./import.css";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function ImportProgress({
  run,
  onCancel,
  onRetry,
  onOpen,
  openLabel = "Open",
  onBack,
}: {
  run: ImportRun;
  onCancel: () => void;
  onRetry: () => void;
  onOpen?: () => void;
  openLabel?: string;
  onBack?: () => void;
}) {
  const source = run.source ? importSource(run.source) : null;
  const job = run.job;
  const fraction = importFraction(job);
  const name = source?.title ?? "your notes";
  const counts = [
    { label: "Pages", value: job?.pages ?? 0 },
    { label: "Databases", value: job?.databases ?? 0 },
    { label: "Files", value: job?.attachments ?? 0 },
  ];
  const eyebrow =
    run.phase === "done"
      ? "Imported"
      : run.phase === "failed"
        ? "Import stopped"
        : run.phase === "cancelled"
          ? "Cancelled"
          : job?.state === "writing"
            ? "Writing pages"
            : "Reading files";
  return (
    <div className={`n-imp-progress is-${run.phase}`} data-testid="import-progress" data-phase={run.phase} aria-live="polite">
      <div className="n-imp-progress-head">
        {source ? <SourceIcon source={source} size={40} /> : <Monogram letter="·" size={40} />}
        <div>
          <div className="n-ob-eyebrow">{eyebrow}</div>
          <div className="n-imp-progress-title">
            {run.phase === "done"
              ? `${plural(job?.pages ?? 0, "page")} from ${name}`
              : run.phase === "failed"
                ? `Couldn’t finish importing ${name}`
                : run.phase === "cancelled"
                  ? `Import from ${name} cancelled`
                  : `Bringing in ${name}`}
          </div>
        </div>
      </div>
      {run.phase === "failed" ? (
        <p className="n-imp-error" role="alert" data-testid="import-error">
          {run.error || "Something went wrong while reading the files."}
        </p>
      ) : (
        <>
          <div
            className="n-imp-bar"
            role="progressbar"
            aria-label="Import progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(fraction * 100)}
            data-testid="import-bar"
          >
            <span className="n-imp-bar-fill" style={{ transform: `scaleX(${fraction})` }} />
          </div>
          <div className="n-imp-meta">
            <span className="n-imp-files">{job && job.files ? `${job.filesDone.toLocaleString()} of ${plural(job.files, "file")}` : run.phase === "done" ? "All files read" : "Counting files…"}</span>
            <span className="n-imp-current" title={job?.current ?? ""} data-testid="import-current">
              {run.phase === "running" ? job?.current ?? "" : job && job.skipped ? `${plural(job.skipped, "file")} skipped` : ""}
            </span>
          </div>
          <dl className="n-imp-counts">
            {counts.map((c) => (
              <div key={c.label} className="n-imp-count">
                <dt>{c.label}</dt>
                <dd data-testid={`import-count-${c.label.toLowerCase()}`}>{c.value.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <div className="n-imp-progress-actions">
        {run.phase === "running" || run.phase === "picking" ? (
          <button type="button" className="n-ob-secondary" onClick={onCancel} data-testid="import-cancel">
            Cancel
          </button>
        ) : null}
        {run.phase === "done" && onOpen ? (
          <button type="button" className="n-ob-primary" onClick={onOpen} data-testid="import-open" autoFocus>
            {openLabel}
          </button>
        ) : null}
        {run.phase === "failed" || run.phase === "cancelled" ? (
          <>
            <button type="button" className="n-ob-primary" onClick={onRetry} data-testid="import-retry" autoFocus>
              Try again
            </button>
            {onBack ? (
              <button type="button" className="n-ob-link" onClick={onBack}>
                Choose another source
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
