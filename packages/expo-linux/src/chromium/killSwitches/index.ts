import { callMain, mainModules } from "../../bridge";
import { nativeSwitchesFetch } from "./switchesFetch";

type Fetched = { status: number; body: string };

let installed = false;

export function installSwitchesFetch() {
  if (installed || !mainModules().ArdiaShell?.async.includes("fetchKillSwitches")) return;
  installed = true;
  window.fetch = nativeSwitchesFetch(() => callMain<Fetched>("ArdiaShell", "fetchKillSwitches"), window.fetch.bind(window));
}
