export const PUBLIC_NODE_RPC = "https://ethereum-rpc.publicnode.com";

const CHAIN_ID = /^[1-9]\d{0,15}$/;
const HTTPS_URL = /^https:\/\/[^\s/?#@]+(?:[/?][^\s#]*)?$/i;
const LOCAL_HTTP_URL = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:[/?][^\s#]*)?$/i;

export function web3RpcProblem(chain: string, url: string): string | null {
  if (!CHAIN_ID.test(chain)) return "The chain ID is a whole number, like 1 for Ethereum.";
  if (HTTPS_URL.test(url) || LOCAL_HTTP_URL.test(url)) return null;
  return "Use an https:// URL, or http:// on this Mac (127.0.0.1 or localhost).";
}
