import { nativeModule, type ControlRequest, type ControlSocketStatus } from "@ardia/shell";
import { t } from "../lib/uiLanguage";


export type { ControlRequest, ControlSocketStatus };

let bound: ReturnType<typeof nativeModule<t(`ArdiaAutomation`)>> | null = null;
const Automation = () => (bound ??= nativeModule(t(`ArdiaAutomation`)));

export const startControlSocket = () => Automation().start();
export const stopControlSocket = () => Automation().stop();
export const replyOnControlSocket = (connection: number, line: string, ticket = 0) => Automation().reply(connection, line, ticket);
export const broadcastOnControlSocket = (connections: number[], line: string) => Automation().broadcast(connections, line);
export const onControlRequest = (listener: (request: ControlRequest) => void) => Automation().addListener("onRequest", listener);
export const onControlClose = (listener: (e: { connection: number }) => void) => Automation().addListener("onClose", listener);
export const onControlWritten = (listener: (e: { tickets: number[] }) => void) => Automation().addListener("onWritten", listener);
