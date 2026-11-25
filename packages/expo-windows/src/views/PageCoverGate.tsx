import { useContext } from "react";
import type { PageCoverGateProps } from "@ardia/shell";
import { PageCovering } from "../engine/coverClip";

export function PageCoverGate({ covering, children }: PageCoverGateProps) {
  const above = useContext(PageCovering);
  return <PageCovering.Provider value={above && covering}>{children}</PageCovering.Provider>;
}
