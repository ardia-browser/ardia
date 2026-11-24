import { reveal } from "@ardia/core";
import { controlDevtoolsEndpoint, type DevtoolsEndpoint } from "../../platform/automation";
import { noteDevtoolsEndpoint, type DevtoolsEndpointOutcome } from "../telemetry/cliCounts";
import type { ConsentToken } from "../telemetry/client";
import { failure, type ErrorCode, type RequestId } from "./automationMethods";
import type { MethodSpec } from "./socketCatalog";
import { obj } from "./socketSchema";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";

export const DEVTOOLS_ENDPOINT = "control.devtoolsEndpoint";

export const CONTROL_OFF = "Control is off.";

export const DEVTOOLS_METHODS: MethodSpec[] = [
  {
    name: DEVTOOLS_ENDPOINT,
    mutates: false,
    description: "The engine's DevTools token connection for ardia browse: its loopback port, its token and the generation they belong to",
    params: obj({}),
    result: "{port, token, generation}",
    get hidden() {
      return !PLATFORM_FEATURES.controlDoorbell;
    },
  },
];

const REFUSALS: Record<Exclude<DevtoolsEndpointOutcome, "given">, [ErrorCode, string]> = {
  control_off: ["failed", CONTROL_OFF],
  unsupported: ["unknown_method", `There's no method ${DEVTOOLS_ENDPOINT} on this Ardia; read the token from ArdiaControl.json.`],
  server_off: ["failed", "The DevTools token connection isn't running."],
  unreadable: ["failed", "Ardia couldn't read the DevTools token."],
  stale: ["failed", "The DevTools token connection restarted while Ardia read it; ask again."],
  left: ["failed", "The connection closed before the token was ready."],
};

type DevtoolsEndpointBody = { result: DevtoolsEndpoint } | ReturnType<typeof failure>;

export function refuseDevtoolsEndpoint(outcome: Exclude<DevtoolsEndpointOutcome, "given">, consent: ConsentToken | null): ReturnType<typeof failure> {
  noteDevtoolsEndpoint(outcome, consent);
  const [code, message] = REFUSALS[outcome];
  return failure(code, message);
}

export async function devtoolsEndpointMethod(connection: number, serving: () => boolean, controlStillOn: () => boolean, consent: ConsentToken | null): Promise<DevtoolsEndpointBody> {
  const stopped = () => refuseDevtoolsEndpoint(controlStillOn() ? "left" : "control_off", consent);
  if (!serving()) return stopped();
  if (!PLATFORM_FEATURES.controlDoorbell) return refuseDevtoolsEndpoint("unsupported", consent);
  const read = await controlDevtoolsEndpoint(connection);
  if (!serving()) return stopped();
  if ("problem" in read) return refuseDevtoolsEndpoint(read.problem === "off" ? "server_off" : read.problem, consent);
  noteDevtoolsEndpoint("given", consent);
  return { result: read };
}

export const isDevtoolsEndpoint = (result: unknown): result is DevtoolsEndpoint =>
  typeof result === "object" && result !== null && "token" in result && "port" in result && "generation" in result;

export function devtoolsEndpointLine(id: RequestId, endpoint: DevtoolsEndpoint): string {
  return JSON.stringify({ id, result: { port: endpoint.port, token: reveal(endpoint.token), generation: endpoint.generation } });
}
