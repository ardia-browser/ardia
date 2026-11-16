export const PUBLIC_NODE_RPC = "https://ethereum-rpc.publicnode.com";

const CHAIN_ID = /^[1-9]\d{0,15}$/;
const HTTPS_URL = /^https:\/\/(?:[^\s/?#@:[\]]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?(?:[/?][^\s#]*)?$/i;
const LOCAL_HTTP_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?(?:[/?][^\s#]*)?$/i;

const usable = (pattern: RegExp, url: string) => {
  const match = pattern.exec(url);
  return !!match && (match[1] === undefined || Number(match[1]) <= 65535);
};

export function web3RpcProblem(chain: string, url: string): string | null {
  if (!CHAIN_ID.test(chain)) return "The chain ID is a whole number, like 1 for Ethereum.";
  if (usable(HTTPS_URL, url) || usable(LOCAL_HTTP_URL, url)) return null;
  return "Use an https:// URL, or http:// on this Mac (127.0.0.1 or localhost).";
}
