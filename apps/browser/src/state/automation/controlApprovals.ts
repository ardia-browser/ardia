import { create } from "zustand";
import { controlApprovals, revokeControlApproval, type ControlApproval } from "../../platform/automation";
import { errorText } from "../../lib/errors";

type ControlApprovalsState = { approvals: ControlApproval[]; problem: string | null; doorbell: boolean; loaded: boolean };

export const useControlApprovals = create<ControlApprovalsState>()(() => ({ approvals: [], problem: null, doorbell: true, loaded: false }));

let reads = 0;

export async function refreshControlApprovals() {
  const read = ++reads;
  try {
    const result = await controlApprovals();
    if (read !== reads) return;
    useControlApprovals.setState({ approvals: result.approvals, problem: result.problem ?? null, doorbell: result.doorbell ?? true, loaded: true });
  } catch (error) {
    if (read === reads) useControlApprovals.setState({ problem: errorText(error), loaded: true });
  }
}

export async function refreshExpiredApprovals(at: number) {
  if (useControlApprovals.getState().approvals.some((a) => a.until !== undefined && a.until <= at)) await refreshControlApprovals();
}

export async function revokeApproval(key: string) {
  useControlApprovals.setState((s) => ({ approvals: s.approvals.filter((a) => a.key !== key) }));
  await revokeControlApproval(key).catch(() => false);
  await refreshControlApprovals();
}

export function approvalLine(approval: ControlApproval, now: number): string {
  const parts = [approval.signedBy];
  if (approval.until !== undefined) {
    const minutes = Math.max(1, Math.ceil((approval.until - now) / 60_000));
    parts.push(approval.until <= now ? "Expired" : `Allowed for ${minutes === 1 ? "1 more minute" : `${minutes} more minutes`}`);
  } else {
    parts.push("Always allowed");
  }
  return parts.join(" · ");
}
