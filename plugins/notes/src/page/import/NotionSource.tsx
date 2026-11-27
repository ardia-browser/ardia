import { useCallback, useEffect, useRef, useState } from "react";
import { NOTION_LOGIN_URL, type NotionAccount, type NotionCrawl } from "../../shared/notionLive";
import { useApp } from "../app/context";
import { GenericSourceDetail, SourceIcon, type SourceDetailProps } from "./ImportSources";
import "./notionSource.css";

const SIGNED_OUT_POLL_MS = 2500;
const CRAWL_POLL_MS = 700;
const READING_SHARE = 0.85;

const count = (n: number) => n.toLocaleString();

export function notionCrawlLine(job: NotionCrawl): string {
  if (job.stage === "reading") {
    if (!job.pagesFound) return "Reading your workspace…";
    const databases = job.databases ? ` · ${count(job.databases)} database${job.databases === 1 ? "" : "s"}` : "";
    return `Reading your workspace… ${count(job.pagesRead)} of ${count(job.pagesFound)} pages${databases}`;
  }
  if (job.stage === "downloading") return job.filesFound ? `Bringing in files… ${count(job.filesDone)} of ${count(job.filesFound)}` : "Bringing in files…";
  if (job.stage === "cancelling") return "Cancelling…";
  if (job.stage === "ready") return "Read everything. Bringing it into Notes…";
  return "";
}

export function notionCrawlFraction(job: NotionCrawl): number | null {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  if (job.stage === "reading") return job.pagesFound ? clamp((READING_SHARE * job.pagesRead) / job.pagesFound) : null;
  if (job.stage === "downloading") return job.filesFound ? clamp(READING_SHARE + ((1 - READING_SHARE) * (job.filesDone + job.filesSkipped)) / job.filesFound) : READING_SHARE;
  if (job.stage === "ready") return 1;
  return null;
}

type Loaded = { account: NotionAccount | null };

export const NOTION_LIVE_UNSUPPORTED = "Live import from Notion is coming soon — import a Notion export instead.";

const running = (job: NotionCrawl | null) => job?.stage === "reading" || job?.stage === "downloading" || job?.stage === "cancelling";

export function NotionDetail(props: SourceDetailProps) {
  const { source, onStart, busy } = props;
  const { client } = useApp();
  const [loaded, setLoaded] = useState<Loaded>({ account: null });
  const [space, setSpace] = useState<string | null>(null);
  const [job, setJob] = useState<NotionCrawl | null>(null);
  const [starting, setStarting] = useState(false);
  const handed = useRef<number | null>(null);
  const alive = useRef(true);

  const check = useCallback(
    async (fresh: boolean) => {
      try {
        const account = await client.call("notionAccount", { fresh });
        if (alive.current) setLoaded({ account });
      } catch (error) {
        if (alive.current) setLoaded({ account: { state: "unavailable", reason: error instanceof Error ? error.message : String(error) } });
      }
    },
    [client],
  );

  useEffect(() => {
    alive.current = true;
    void check(true);
    void client
      .call("notionImportStatus", {})
      .then((status) => {
        if (alive.current && status && (running(status) || status.stage === "failed" || status.stage === "ready")) setJob(status);
      })
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, [check, client]);

  const signedOut = loaded.account?.state === "signedOut";
  useEffect(() => {
    if (!signedOut) return;
    const timer = setInterval(() => void check(true), SIGNED_OUT_POLL_MS);
    const onFocus = () => void check(true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [signedOut, check]);

  const spaces = loaded.account?.state === "signedIn" ? loaded.account.spaces : [];
  useEffect(() => {
    if (space && spaces.some((s) => s.id === space && s.canImport)) return;
    setSpace(spaces.find((s) => s.canImport)?.id ?? null);
  }, [spaces.map((s) => `${s.id}:${s.canImport}`).join(",")]);

  const isRunning = running(job);
  useEffect(() => {
    if (!isRunning) return;
    const timer = setInterval(() => {
      void client
        .call("notionImportStatus", {})
        .then((status) => alive.current && setJob(status))
        .catch(() => undefined);
    }, CRAWL_POLL_MS);
    return () => clearInterval(timer);
  }, [isRunning, client]);

  useEffect(() => {
    if (job?.stage !== "ready" || handed.current === job.startedAt) return;
    handed.current = job.startedAt;
    onStart("account");
  }, [job?.stage, job?.startedAt]);

  const begin = async () => {
    if (!space || starting) return;
    setStarting(true);
    try {
      setJob(await client.call("notionImport", { space }));
    } catch (error) {
      setJob({ stage: "failed", spaceId: space, spaceName: "", pagesFound: 0, pagesRead: 0, blocks: 0, databases: 0, rows: 0, filesFound: 0, filesDone: 0, filesSkipped: 0, skipped: 0, startedAt: Date.now(), error: error instanceof Error ? error.message : String(error) });
    } finally {
      setStarting(false);
    }
  };
  const cancel = () => {
    setJob((old) => (old && running(old) ? { ...old, stage: "cancelling" } : old));
    void client.call("notionImportCancel", {}).catch(() => undefined);
  };
  const open = (url: string) => void client.call("openUrl", { url }).catch(() => undefined);
  const useFile = (
    <button type="button" className="n-ob-link" disabled={busy || isRunning} onClick={() => onStart("file")} data-testid="notion-use-file">
      Choose a file instead
    </button>
  );

  const account = loaded.account;
  if (account?.state === "unsupported" && !running(job)) return <GenericSourceDetail {...props} note={NOTION_LIVE_UNSUPPORTED} />;
  let body: React.ReactNode;
  if (job && (running(job) || job.stage === "ready")) {
    const fraction = notionCrawlFraction(job);
    body = (
      <div className="n-nl-progress" data-testid="notion-import-progress" data-stage={job.stage} aria-live="polite">
        <p className="n-imp-detail-hint" data-testid="notion-import-line">
          {notionCrawlLine(job)}
        </p>
        <div className={`n-imp-bar${fraction === null ? " is-waiting" : ""}`} role="progressbar" aria-label="Reading Notion" aria-valuemin={0} aria-valuemax={100} {...(fraction === null ? {} : { "aria-valuenow": Math.round(fraction * 100) })}>
          <span className="n-imp-bar-fill" style={fraction === null ? undefined : { transform: `scaleX(${fraction})` }} />
        </div>
        {job.stage !== "ready" ? (
          <div className="n-imp-detail-actions">
            <button type="button" className="n-ob-secondary" onClick={cancel} disabled={job.stage === "cancelling"} data-testid="notion-import-cancel">
              {job.stage === "cancelling" ? "Cancelling…" : "Cancel"}
            </button>
          </div>
        ) : null}
      </div>
    );
  } else if (!account) {
    body = <p className="n-imp-detail-hint">Checking your Notion sign-in in Ardia…</p>;
  } else if (account.state === "signedOut") {
    body = (
      <>
        <p className="n-imp-detail-hint">Sign in to Notion in an Ardia tab, then come back here. Notes uses that sign-in to read your whole workspace onto this device.</p>
        <div className="n-imp-detail-actions">
          <button type="button" className="n-ob-primary" onClick={() => open(NOTION_LOGIN_URL)} data-testid="notion-sign-in">
            Sign in to Notion in Ardia
          </button>
          {useFile}
        </div>
      </>
    );
  } else if (account.state === "unavailable") {
    body = (
      <>
        <p className="n-imp-detail-hint" data-testid="notion-unavailable">
          {account.reason}
        </p>
        <div className="n-imp-detail-actions">
          <button type="button" className="n-ob-primary" disabled={busy} onClick={() => onStart("file")} data-testid="import-choose">
            {busy ? "Waiting for you…" : "Choose file…"}
          </button>
          <button type="button" className="n-ob-link" onClick={() => void check(true)}>
            Check again
          </button>
        </div>
      </>
    );
  } else if (account.state === "signedIn") {
    const chosen = spaces.find((s) => s.id === space);
    body = (
      <>
        <p className="n-imp-detail-hint" data-testid="notion-account">
          Signed in as {account.user.name || account.user.email || "you"}
          {account.user.name && account.user.email ? ` (${account.user.email})` : ""}. Notes only reads from Notion, and everything stays on this device.
        </p>
        {spaces.length ? (
          <div className="n-nl-spaces" role="radiogroup" aria-label="Notion workspace" data-testid="notion-spaces">
            {spaces.map((s) => (
              <button key={s.id} type="button" role="radio" aria-checked={space === s.id} disabled={!s.canImport || isRunning} title={s.reason} className={`n-nl-space${space === s.id ? " is-selected" : ""}`} onClick={() => setSpace(s.id)} data-testid={`notion-space-${s.id}`}>
                <span className="n-nl-space-icon" aria-hidden="true">
                  {s.icon || s.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="n-nl-space-name">{s.name}</span>
                {!s.canImport ? <span className="n-nl-space-note">{s.role === "guest" ? "Guest" : "Not allowed"}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {!spaces.some((s) => s.canImport) ? <p className="n-imp-detail-hint">{spaces[0]?.reason ?? "Notion didn't list a workspace Notes can bring in."}</p> : null}
        {job?.stage === "cancelled" && job.note ? (
          <p className="n-imp-detail-hint" data-testid="notion-import-note">
            {job.note}
          </p>
        ) : null}
        {job?.stage === "failed" ? (
          <p className="n-imp-error" role="alert" data-testid="notion-import-error">
            {job.error}
          </p>
        ) : null}
        <div className="n-imp-detail-actions">
          <button type="button" className="n-ob-primary" disabled={!chosen?.canImport || starting || busy} onClick={() => void begin()} data-testid="notion-import">
            {starting ? "Starting…" : job?.stage === "failed" ? "Try again" : "Import from Notion"}
          </button>
          {useFile}
        </div>
      </>
    );
  } else {
    body = null;
  }

  return (
    <div className="n-imp-detail" data-testid="import-detail" key={source.id}>
      <SourceIcon source={source} size={42} />
      <div className="n-imp-detail-text">
        <div className="n-imp-detail-title">Import from Notion</div>
        {body}
      </div>
    </div>
  );
}
