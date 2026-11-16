import { call, on, type Web3Load } from "@ardia/ardiacore";

export type { Web3Load };

export const setWeb3Rpcs = (rpcs: Record<string, string>) => call("engine.setWeb3Rpcs", { rpcs });
export const onWeb3Load = (listener: (load: Web3Load) => void) => on("engine.web3Load", listener);
