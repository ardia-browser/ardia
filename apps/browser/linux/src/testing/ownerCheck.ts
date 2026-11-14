import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnerPrompt, OwnerPromptUI } from "../ownerCheck";

export const CORRECT_PASSWORD = "correct horse";

const STUB = `#!/bin/sh
dir=$(dirname "$0")
cat > "$dir/received"
echo "$*" >> "$dir/calls"
case "$(cat "$dir/mode" 2>/dev/null)" in
  hang) exec sleep 30 ;;
  slow) sleep 0.3 ;;
  crash) kill -9 $$ ;;
esac
cmp -s "$dir/received" "$dir/expected" && exit 0
exit 7
`;

export type StubHelper = {
  path: string;
  setMode(mode: "check" | "hang" | "crash" | "slow"): void;
  calls(): number;
  received(): Buffer;
  hide(): void;
  restore(): void;
  remove(): void;
};

export function stubPasswordHelper(): StubHelper {
  const dir = mkdtempSync(join(tmpdir(), "ardia-chkpwd-"));
  const path = join(dir, "unix_chkpwd");
  const hidden = join(dir, "hidden");
  writeFileSync(path, STUB);
  chmodSync(path, 0o755);
  writeFileSync(join(dir, "expected"), Buffer.concat([Buffer.from(CORRECT_PASSWORD, "utf8"), Buffer.from([0])]));
  return {
    path,
    setMode: (mode) => writeFileSync(join(dir, "mode"), mode),
    calls: () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean).length : 0),
    received: () => readFileSync(join(dir, "received")),
    hide: () => renameSync(path, hidden),
    restore: () => renameSync(hidden, path),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export type ScriptedPrompt = {
  ui: OwnerPromptUI;
  answers: (string | null | Promise<string | null>)[];
  handedOver: Uint8Array[];
  asked: string[];
  openedWaiting: number[];
  refusals: [string, number][];
  unavailable: string[];
  closed: number;
};

export function scriptedPrompt(): ScriptedPrompt {
  const scripted: ScriptedPrompt = {
    answers: [],
    handedOver: [],
    asked: [],
    openedWaiting: [],
    refusals: [],
    unavailable: [],
    closed: 0,
    ui: {
      ask: async (reason, retryInMs) => {
        scripted.asked.push(reason);
        scripted.openedWaiting.push(retryInMs);
        const prompt: OwnerPrompt = {
          answer: async () => {
            const next = await scripted.answers.shift();
            if (next === undefined || next === null) return null;
            const bytes = new TextEncoder().encode(next);
            scripted.handedOver.push(bytes);
            return bytes;
          },
          refuse: async (message, retryInMs) => void scripted.refusals.push([message, retryInMs]),
          focus: () => undefined,
          close: () => void scripted.closed++,
        };
        return prompt;
      },
      tellUnavailable: async (reason) => void scripted.unavailable.push(reason),
    },
  };
  return scripted;
}

export function heldAnswer(): { answer: Promise<string | null>; give(answer: string | null): void } {
  let give: (answer: string | null) => void = () => undefined;
  const answer = new Promise<string | null>((resolve) => {
    give = resolve;
  });
  return { answer, give };
}

export async function untilHelperRuns(helper: StubHelper, before: number, deadlineMs = 5_000): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  while (helper.calls() === before) {
    if (performance.now() > deadline) throw new Error("the password helper never ran");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
