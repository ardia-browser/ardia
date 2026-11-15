export { noteMissing } from "../missing";

let firstWindowNoted = false;

export function noteFirstWindow() {
  if (firstWindowNoted) return;
  firstWindowNoted = true;
  console.info("[ardia linux] first window");
}
