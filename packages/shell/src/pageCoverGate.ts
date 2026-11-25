import type { ReactNode } from "react";

export type PageCoverGateProps = { covering: boolean; children?: ReactNode };

export const PageCoverGate = ({ children }: PageCoverGateProps) => children;
