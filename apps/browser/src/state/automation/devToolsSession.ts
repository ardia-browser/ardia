import { STOPPED } from "./socketCatalog";
import { OpError } from "./workspaceTargets";

export type CdpParams = Record<string, unknown>;
export type CdpEventListener = (method: string, params: CdpParams) => void;

export type DevToolsTransport = {
  send(method: string, params: CdpParams): Promise<CdpParams>;
  onEvent(listener: CdpEventListener): () => void;
  onClosed?(listener: () => void): () => void;
  close(): Promise<void>;
};

export const TRANSPORT_LOSS = "Ardia.transportLoss";

export type TransportOpener = (tabId: string, signal: AbortSignal) => Promise<DevToolsTransport>;

export const INSPECTION_METHODS: ReadonlySet<string> = new Set([
  "Tracing.start",
  "Tracing.end",
  "Audits.enable",
  "Audits.disable",
  "DOM.enable",
  "DOM.disable",
  "DOM.getDocument",
  "DOM.querySelector",
  "CSS.enable",
  "CSS.disable",
  "CSS.getMatchedStylesForNode",
  "CSS.getComputedStyleForNode",
  "Debugger.enable",
  "Debugger.disable",
  "Debugger.setBreakpoint",
  "Debugger.setBreakpointByUrl",
  "Debugger.removeBreakpoint",
  "Page.reload",
]);

const DISABLE_OF: Readonly<Record<string, string>> = {
  "Audits.enable": "Audits.disable",
  "DOM.enable": "DOM.disable",
  "CSS.enable": "CSS.disable",
  "Debugger.enable": "Debugger.disable",
};

export const TEARDOWN_WAIT_MS = 2_000;
export const CLEANUP_STEP_MS = 1_000;
export const OPEN_TIMEOUT_MS = 10_000;

function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => (timer = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([work.catch(() => fallback), deadline]).finally(() => clearTimeout(timer));
}

export const UNAVAILABLE = "This Ardia can't open a DevTools inspection session on a tab yet.";
export const SESSION_ENDED = "The inspection session ended before it finished.";

let opener: TransportOpener | null = null;
const byConnection = new Map<number, Set<InspectionSession>>();
const connectionEpochs = new Map<number, number>();
const pendingOpens = new Map<number, Set<() => void>>();
let controlEpoch = 0;

export const setInspectionTransport = (next: TransportOpener | null) => void (opener = next);
export const liveInspectionSessions = () => [...byConnection.values()].reduce((sum, set) => sum + set.size, 0);

export class InspectionSession {
  readonly tabId: string;
  readonly connection: number;
  readonly ended: Promise<void>;
  private transport: DevToolsTransport;
  private enabled: string[] = [];
  private breakpoints = new Set<string>();
  private tracing = false;
  private listeners = new Set<CdpEventListener>();
  private inFlight = new Set<Promise<unknown>>();
  private closeWaiters = new Set<() => void>();
  private unsubscribe: () => void;
  private closing: Promise<void> | null = null;
  private markEnded!: () => void;

  constructor(tabId: string, connection: number, transport: DevToolsTransport) {
    this.tabId = tabId;
    this.connection = connection;
    this.transport = transport;
    this.ended = new Promise((resolve) => (this.markEnded = resolve));
    const own = byConnection.get(connection) ?? new Set<InspectionSession>();
    own.add(this);
    byConnection.set(connection, own);
    const stopEvents = transport.onEvent((method, params) => {
      for (const listener of [...this.listeners]) listener(method, params);
    });
    const stopClosed = transport.onClosed?.(() => void this.close()) ?? (() => {});
    this.unsubscribe = () => {
      stopEvents();
      stopClosed();
    };
  }

  get isClosed() {
    return this.closing !== null;
  }

  send(method: string, params: CdpParams = {}): Promise<CdpParams> {
    if (this.closing) return Promise.reject(new OpError("failed", SESSION_ENDED));
    if (!INSPECTION_METHODS.has(method)) return Promise.reject(new OpError("refused", `An inspection session never sends ${method}.`));
    const work = this.transport.send(method, params).then((reply) => {
      if (method === "Tracing.start") this.tracing = true;
      if (method === "Tracing.end") this.tracing = false;
      if (Object.hasOwn(DISABLE_OF, method) && !this.enabled.includes(method)) this.enabled.push(method);
      if ((method === "Debugger.setBreakpointByUrl" || method === "Debugger.setBreakpoint") && typeof reply.breakpointId === "string") this.breakpoints.add(reply.breakpointId);
      if (method === "Debugger.removeBreakpoint" && typeof params.breakpointId === "string") this.breakpoints.delete(params.breakpointId);
      return reply;
    });
    this.inFlight.add(work);
    const settled = () => void this.inFlight.delete(work);
    work.then(settled, settled);
    return new Promise<CdpParams>((resolve, reject) => {
      const abandon = () => reject(new OpError("failed", SESSION_ENDED));
      this.closeWaiters.add(abandon);
      work.then(
        (reply) => {
          this.closeWaiters.delete(abandon);
          resolve(reply);
        },
        (error: unknown) => {
          this.closeWaiters.delete(abandon);
          reject(error);
        },
      );
    });
  }

  on(listener: CdpEventListener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  waitFor(method: string, timeoutMs: number, matches: (params: CdpParams) => boolean = () => true): Promise<CdpParams | null> {
    return new Promise((resolve) => {
      const finish = (value: CdpParams | null) => {
        clearTimeout(timer);
        stop();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const stop = this.on((name, params) => {
        if (name === method && matches(params)) finish(params);
      });
      void this.ended.then(() => finish(null));
    });
  }

  async pause(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slept = new Promise<"slept">((resolve) => (timer = setTimeout(() => resolve("slept"), ms)));
    const outcome = await Promise.race([slept, this.ended.then(() => "ended" as const)]);
    clearTimeout(timer);
    if (outcome === "ended") throw new OpError("failed", SESSION_ENDED);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.markEnded();
    for (const abandon of [...this.closeWaiters]) abandon();
    this.closeWaiters.clear();
    this.closing = this.shutDown();
    return this.closing;
  }

  private async shutDown() {
    try {
      await within(Promise.allSettled([...this.inFlight]), TEARDOWN_WAIT_MS, []);
      const quietly = (method: string, params: CdpParams = {}) => within(this.transport.send(method, params), CLEANUP_STEP_MS, {});
      if (this.tracing) await quietly("Tracing.end");
      for (const breakpointId of this.breakpoints) await quietly("Debugger.removeBreakpoint", { breakpointId });
      for (const enable of [...this.enabled].reverse()) await quietly(DISABLE_OF[enable]!);
    } finally {
      this.tracing = false;
      this.breakpoints.clear();
      this.enabled = [];
      this.listeners.clear();
      this.unsubscribe();
      const own = byConnection.get(this.connection);
      own?.delete(this);
      if (own && !own.size) byConnection.delete(this.connection);
      await within(this.transport.close(), CLEANUP_STEP_MS, undefined);
    }
  }
}

const epochOf = (connection: number) => connectionEpochs.get(connection) ?? 0;

export async function openInspection(tabId: string, connection: number): Promise<InspectionSession> {
  if (!opener) throw new OpError("failed", UNAVAILABLE);
  const startedIn = epochOf(connection);
  const controlStartedIn = controlEpoch;
  const abort = new AbortController();
  const opening = opener(tabId, abort.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  const timedOut = new Promise<"timed-out">((resolve) => (timer = setTimeout(() => resolve("timed-out"), OPEN_TIMEOUT_MS)));
  const cancelled = new Promise<"cancelled">((resolve) => (cancel = () => resolve("cancelled")));
  const waiting = pendingOpens.get(connection) ?? new Set<() => void>();
  waiting.add(cancel);
  pendingOpens.set(connection, waiting);
  const outcome = await Promise.race([opening, timedOut, cancelled]).finally(() => {
    clearTimeout(timer);
    waiting.delete(cancel);
    if (!waiting.size && pendingOpens.get(connection) === waiting) pendingOpens.delete(connection);
  });
  if (outcome === "timed-out" || outcome === "cancelled") {
    abort.abort();
    void opening.then((late) => late.close()).catch(() => {});
    throw new OpError("failed", outcome === "cancelled" ? STOPPED : "The tab didn't open an inspection session in time.");
  }
  if (epochOf(connection) !== startedIn || controlEpoch !== controlStartedIn) {
    await within(outcome.close(), CLEANUP_STEP_MS, undefined);
    throw new OpError("failed", STOPPED);
  }
  return new InspectionSession(tabId, connection, outcome);
}

export async function withInspection<T>(tabId: string, connection: number, work: (session: InspectionSession) => Promise<T>): Promise<T> {
  const session = await openInspection(tabId, connection);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

export async function closeInspectionsFor(connection: number) {
  connectionEpochs.set(connection, epochOf(connection) + 1);
  for (const cancel of [...(pendingOpens.get(connection) ?? [])]) cancel();
  await Promise.all([...(byConnection.get(connection) ?? [])].map((session) => session.close()));
}

export async function closeAllInspections() {
  controlEpoch++;
  for (const waiting of [...pendingOpens.values()]) for (const cancel of [...waiting]) cancel();
  await Promise.all([...byConnection.values()].flatMap((set) => [...set]).map((session) => session.close()));
}
