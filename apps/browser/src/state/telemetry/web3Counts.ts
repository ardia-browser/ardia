import { onWeb3Load, type Web3Load } from "../../platform/web3";

const OUTCOMES: readonly Web3Load["outcome"][] = ["ok", "noRpc", "rpcFailed", "reverted", "notContract", "notFound", "badUrl", "unsupportedMode", "badResponse"];

let pages5219 = 0;
let pagesAuto = 0;
const failed = new Map<Web3Load["outcome"], number>();

function noteWeb3Load({ mode, outcome }: Web3Load) {
  if (!OUTCOMES.includes(outcome)) return;
  if (outcome !== "ok") failed.set(outcome, (failed.get(outcome) ?? 0) + 1);
  else if (mode === "5219") pages5219++;
  else pagesAuto++;
}

export const watchWeb3Loads = () => onWeb3Load(noteWeb3Load);

export function takeWeb3Counts() {
  const taken: Record<string, number> = { web3_pages_5219: pages5219, web3_pages_auto: pagesAuto };
  for (const outcome of OUTCOMES) if (outcome !== "ok") taken[`web3_failed_${outcome}`] = failed.get(outcome) ?? 0;
  pages5219 = 0;
  pagesAuto = 0;
  failed.clear();
  return taken;
}
