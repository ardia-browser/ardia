import type { ArdiaHost } from "../host";

export const startUpdates = (_host: ArdiaHost, _locks?: LockManager): void => {};

export const updateMenuItem = async (_host: ArdiaHost): Promise<"check" | "restart" | null> => null;

export const updaterMethod = (_host: ArdiaHost, _method: string): ((...args: unknown[]) => Promise<unknown>) | undefined => undefined;

export const runMenuUpdate = (_host: ArdiaHost, _restart: boolean): Promise<unknown> | null => null;
