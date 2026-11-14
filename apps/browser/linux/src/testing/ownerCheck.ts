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
  crash) kill -9 $$ ;;
esac
cmp -s "$dir/received" "$dir/expected" && exit 0
exit 7
`;

export type StubHelper = {
  path: string;
  setMode(mode: "check" | "hang" | "crash"): void;
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
  answers: (string | null)[];
  asked: string[];
  refusals: string[];
  closed: number;
};

export function scriptedPrompt(): ScriptedPrompt {
  const scripted: ScriptedPrompt = {
    answers: [],
    asked: [],
    refusals: [],
    closed: 0,
    ui: {
      ask: async (reason) => {
        scripted.asked.push(reason);
        const prompt: OwnerPrompt = {
          answer: async () => (scripted.answers.length ? scripted.answers.shift()! : null),
          wrongPassword: async () => void scripted.refusals.push("wrong"),
          focus: () => undefined,
          close: () => void scripted.closed++,
        };
        return prompt;
      },
    },
  };
  return scripted;
}
