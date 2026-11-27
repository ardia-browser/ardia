import { readFileSync } from "node:fs";

export function signalState(target, signal = (to, sig) => process.kill(to, sig)) {
  try {
    signal(target, 0);
    return "running";
  } catch (error) {
    return error?.code === "EPERM" ? "unsignalable" : "gone";
  }
}

const validPid = (pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff;

export const isAlive = (pid) => validPid(pid) && signalState(pid) !== "gone";

export const groupAlive = (pgid) => Number.isSafeInteger(pgid) && pgid > 1 && signalState(-pgid) !== "gone";

export const signalable = (pid) => validPid(pid) && signalState(pid) === "running";

export function signalableFrom(pidFile) {
  try {
    return signalable(Number(readFileSync(pidFile, "utf8").trim()));
  } catch {
    return false;
  }
}

export function trySignal(pid, sig, report = (text) => process.stderr.write(`${text}\n`)) {
  try {
    process.kill(pid, sig);
    return true;
  } catch (error) {
    report(`couldn't send ${sig} to pid ${pid}: ${error?.code ?? error?.message ?? error}`);
    return false;
  }
}
