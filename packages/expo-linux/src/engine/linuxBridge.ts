import { bridge, invokeMain, invokeMainSync, type LinuxBridge } from "../bridge";

export type { LinuxBridge };

export const PAGES_MODULE = "ArdiaLinuxPages";

export const linuxBridge = (): LinuxBridge | undefined => bridge() ?? undefined;

export function pagesCallSync<Result>(method: string, ...args: unknown[]): Result | undefined {
  const linux = bridge();
  if (!linux) return undefined;
  return invokeMainSync(linux, PAGES_MODULE, method, args) as Result;
}

export async function pagesCall<Result>(method: string, ...args: unknown[]): Promise<Result | null> {
  const linux = bridge();
  if (!linux) return null;
  return (await invokeMain(linux, PAGES_MODULE, method, args)) as Result;
}
