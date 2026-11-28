import type { Env } from "./dev";
import { main } from "./main";

export function runAsProcess(argv: readonly string[], name: string, env: Env): void {
  const quietPipe = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw error;
  };
  process.stdout.on("error", quietPipe);
  process.stderr.on("error", quietPipe);
  main(argv, { env }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${name}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 70;
    },
  );
}
