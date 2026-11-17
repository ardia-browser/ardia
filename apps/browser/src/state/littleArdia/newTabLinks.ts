import { setLittleArdiaOpensNewTabLinks } from "../../platform/pageOptions";

let started = false;

export function startLittleArdiaNewTabLinks() {
  if (started) return;
  started = true;
  void setLittleArdiaOpensNewTabLinks(true);
}
