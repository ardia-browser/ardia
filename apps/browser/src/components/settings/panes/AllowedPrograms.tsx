import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { approvalLine, refreshControlApprovals, refreshExpiredApprovals, revokeApproval, useControlApprovals } from "../../../state/automation/controlApprovals";
import { Button } from "../../ui";
import { Row } from "../Form";
import { setting } from "../settingsIndex";

export function AllowedProgramsRows() {
  const { approvals, problem, doorbell } = useControlApprovals(useShallow((s) => ({ approvals: s.approvals, problem: s.problem, doorbell: s.doorbell })));
  useEffect(() => void refreshControlApprovals(), []);
  const [now, setNow] = useState(Date.now);
  const timed = approvals.some((a) => a.until !== undefined);
  useEffect(() => {
    if (!timed) return;
    const tick = setInterval(() => {
      const at = Date.now();
      setNow(at);
      void refreshExpiredApprovals(at);
    }, 15_000);
    return () => clearInterval(tick);
  }, [timed]);
  const base = setting("advanced.allowedPrograms").description;
  const note = problem ?? (!doorbell ? `${base} This test instance lets every program of yours in without asking.` : approvals.length ? undefined : `${base} You haven't allowed any.`);
  return (
    <>
      <Row anchor="advanced.allowedPrograms" description={note} />
      {approvals.map((approval) => (
        <Row key={approval.key} title={approval.name} description={approvalLine(approval, now)}>
          <Button variant="icon" icon="trash" size="m" onPress={() => void revokeApproval(approval.key)} tooltip="Remove" />
        </Row>
      ))}
    </>
  );
}
