import { HOST_METHODS as M, type SignInOptions, type SignInResult } from "./protocol";
import { PluginError, type Rpc } from "./rpc";

export function signInApi(rpc: Rpc) {
  return {
    async start(options: SignInOptions): Promise<SignInResult> {
      const params: Record<string, unknown> = { url: options.url, callback: options.callback, state: options.state };
      if (options.timeoutMs !== undefined) params.timeoutMs = options.timeoutMs;
      const answer = await rpc.request<{ url?: unknown } | null>(M.signInStart, params);
      const url = answer && typeof answer === "object" ? answer.url : undefined;
      if (typeof url !== "string") throw new PluginError("failed", "Ardia answered signIn.start without a URL.");
      return { url };
    },
  };
}
