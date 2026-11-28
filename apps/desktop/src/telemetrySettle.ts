type TelemetrySettle = {
  settle(endsSession: boolean, cause?: string): Promise<string | null>;
  reopen(token: string): Promise<void>;
  resume(cause: string): Promise<void>;
};

let current: TelemetrySettle = { settle: async () => null, reopen: async () => {}, resume: async () => {} };

export const setTelemetrySettle = (next: TelemetrySettle) => void (current = next);
export const settleTelemetry = (endsSession: boolean, cause?: string) => current.settle(endsSession, cause);
export const reopenTelemetry = (token: string) => current.reopen(token);
export const resumeTelemetry = (cause: string) => current.resume(cause);

export function createResumeRule() {
  let endedBy: string | null = null;
  return {
    ended: (cause: string | undefined) => void (endedBy = cause ?? null),
    resumes: (sessionEnded: boolean, cause: string | undefined) => {
      if (!sessionEnded || !cause || (endedBy !== null && cause !== endedBy)) return false;
      endedBy = null;
      return true;
    },
  };
}

export function createEndLedger(newToken: () => string = () => crypto.randomUUID()) {
  let last: string | null = null;
  return {
    end: () => (last = newToken()),
    reopens: (token: string | undefined) => {
      if (!token || token !== last) return false;
      last = null;
      return true;
    },
  };
}
