import { isAbsolute, relative } from "node:path";

export type Output = {
  readonly json: boolean;
  info(line: string): void;
  warn(line: string): void;
  result(text: string, data: unknown): void;
};

export type Streams = { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } };

export function createOutput(json: boolean, quiet: boolean, streams: Streams = process): Output {
  return {
    json,
    info(line) {
      if (!quiet) streams.stderr.write(`${line}\n`);
    },
    warn(line) {
      streams.stderr.write(`warning: ${line}\n`);
    },
    result(text, data) {
      streams.stdout.write(json ? `${JSON.stringify(data, null, 2)}\n` : text.endsWith("\n") ? text : `${text}\n`);
    },
  };
}

export class CliError extends Error {
  readonly problems: string[];
  readonly code: number;

  constructor(message: string, problems: string[] = [], code = 1) {
    super(message);
    this.name = "CliError";
    this.problems = problems;
    this.code = code;
  }
}

export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function shownPath(path: string, cwd = process.cwd()): string {
  const rel = relative(cwd, path);
  if (!rel) return ".";
  return rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}
