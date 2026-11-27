import { useCallback, useEffect, useRef, useState } from "react";
import type { ImportJob, ImportPick, ImportSourceId } from "../../shared/importSources";
import type { WorkspaceId } from "../../shared/protocol";
import type { NotesClient } from "../client/types";

export type ImportPhase = "idle" | "picking" | "running" | "done" | "failed" | "cancelled";

export type ImportRun = { phase: ImportPhase; source: ImportSourceId | null; job: ImportJob | null; error: string };

const POLL_MS = 250;
const IDLE: ImportRun = { phase: "idle", source: null, job: null, error: "" };

const phaseOf = (job: ImportJob): ImportPhase => (job.state === "done" ? "done" : job.state === "failed" ? "failed" : job.state === "cancelled" ? "cancelled" : "running");

export function importFraction(job: ImportJob | null): number {
  if (!job) return 0;
  if (job.state === "done") return 1;
  if (!job.files) return 0;
  return Math.max(0, Math.min(1, job.filesDone / job.files));
}

export function useImportJob(client: NotesClient, workspace: WorkspaceId, options: { onDone?: (job: ImportJob) => void; onJob?: (jobId: string | null) => void } = {}) {
  const [run, setRun] = useState<ImportRun>(IDLE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  const token = useRef(0);
  const callbacks = useRef(options);
  callbacks.current = options;

  const stopPolling = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const poll = useCallback(
    (jobId: string, source: ImportSourceId | null, mine: number) => {
      const tick = async () => {
        let job: ImportJob | null = null;
        try {
          job = await client.call("importStatus", { job: jobId });
        } catch (error) {
          if (!live.current || mine !== token.current) return;
          setRun({ phase: "failed", source, job: null, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        if (!live.current || mine !== token.current) return;
        if (!job) {
          setRun({ phase: "failed", source, job: null, error: "The import stopped before it finished." });
          callbacks.current.onJob?.(null);
          return;
        }
        const phase = phaseOf(job);
        setRun({ phase, source: job.source, job, error: job.error ?? "" });
        if (phase === "running") {
          timer.current = setTimeout(() => void tick(), POLL_MS);
          return;
        }
        callbacks.current.onJob?.(null);
        if (phase === "done") callbacks.current.onDone?.(job);
      };
      void tick();
    },
    [client],
  );

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      stopPolling();
    };
  }, []);

  const start = useCallback(
    async (source: ImportSourceId, pick: ImportPick) => {
      stopPolling();
      const mine = ++token.current;
      setRun({ phase: "picking", source, job: null, error: "" });
      try {
        const started = await client.call("importStart", { workspace, source, pick });
        if (!live.current || mine !== token.current) return;
        if (!started) {
          setRun({ phase: "idle", source, job: null, error: "" });
          return;
        }
        callbacks.current.onJob?.(started.job);
        setRun({ phase: "running", source, job: null, error: "" });
        poll(started.job, source, mine);
      } catch (error) {
        if (!live.current || mine !== token.current) return;
        setRun({ phase: "failed", source, job: null, error: error instanceof Error ? error.message : String(error) });
      }
    },
    [client, workspace, poll],
  );

  const resume = useCallback(
    (jobId: string) => {
      stopPolling();
      const mine = ++token.current;
      setRun((old) => ({ ...old, phase: "running" }));
      poll(jobId, null, mine);
    },
    [poll],
  );

  const cancel = useCallback(async () => {
    const id = run.job?.id;
    if (!id) {
      token.current++;
      stopPolling();
      setRun((old) => ({ ...old, phase: "idle" }));
      return;
    }
    try {
      await client.call("importCancel", { job: id });
    } catch {}
  }, [client, run.job?.id]);

  const reset = useCallback(() => {
    token.current++;
    stopPolling();
    setRun(IDLE);
  }, []);

  return { run, start, resume, cancel, reset };
}
