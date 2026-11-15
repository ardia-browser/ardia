export type { EventSubscription } from "../events";
export { addNativeListener, emitNativeEvent, emitWhenListened } from "../events";

export const nativeEventName = (module: string, event: string) => `${module}:${event}`;
