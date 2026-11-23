import { CONFIRM_REFUSED } from "./consentSurface";
import { recordOf, UNSAVED, type OfficialFetch, type PluginsStore, type ProgramsState } from "./store";

export type InstallPhase =
  | { step: "review" }
  | { step: "installing"; label: string; fraction: number | null }
  | { step: "installed" }
  | { step: "failed"; reason: string };

export const REVIEW: InstallPhase = { step: "review" };

export type InstallWatch = {
  asking: boolean;
  enabled: boolean;
  unsaved: boolean;
  fetch: OfficialFetch | undefined;
  programs: ProgramsState | undefined;
  program: string | null;
  retryFailure: string | null;
};

const INSTALLING = "Installing…";

function programsPhase(programs: ProgramsState | undefined, program: string): InstallPhase {
  if (programs?.state === "failed") return { step: "failed", reason: `Couldn't add ${program} to your PATH: ${programs.reason}` };
  if (programs?.state === "linked") {
    const refused = Object.values(programs.refused);
    return refused.length ? { step: "failed", reason: `Couldn't add ${program} to your PATH: ${refused[0]}` } : { step: "installed" };
  }
  return { step: "installing", label: `Adding ${program} to your PATH…`, fraction: null };
}

export function installPhase(w: InstallWatch): InstallPhase {
  if (w.asking) return { step: "installing", label: INSTALLING, fraction: null };
  if (w.fetch?.state === "fetching") return { step: "installing", label: "Downloading…", fraction: w.fetch.total > 0 ? Math.min(1, w.fetch.received / w.fetch.total) : null };
  if (w.fetch?.state === "promoting") return { step: "installing", label: INSTALLING, fraction: null };
  if (w.fetch?.state === "failed") return { step: "failed", reason: w.fetch.reason };
  if (w.retryFailure) return { step: "failed", reason: w.retryFailure };
  if (!w.enabled) return { step: "failed", reason: w.unsaved ? UNSAVED : CONFIRM_REFUSED };
  return w.program ? programsPhase(w.programs, w.program) : { step: "installed" };
}

export function installWatch(s: PluginsStore, request: { id: number; name: string; hash: string }, program: string | null, retryFailure: string | null): InstallWatch {
  const record = recordOf(s, request.name);
  const programs = Object.hasOwn(s.programs, request.name) ? s.programs[request.name] : undefined;
  return {
    asking: s.consent?.id === request.id,
    enabled: record.enabled && record.approved === request.hash,
    unsaved: s.unsaved === request.name,
    fetch: Object.hasOwn(s.fetches, request.name) ? s.fetches[request.name] : undefined,
    programs: programs?.hash === request.hash ? programs : undefined,
    program,
    retryFailure,
  };
}
