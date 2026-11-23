import type { ReactNode } from "react";
import { approveAutomationRule, removeAutomationRule, useAutomationRules, type AutomationRuleRow } from "../../../state/automation/approvalRows";
import { Button } from "../../ui";
import { Row } from "../Form";
import { setting } from "../settingsIndex";

function RuleRow({ rule, pending }: { rule: AutomationRuleRow; pending: boolean }) {
  return (
    <Row title={rule.name} description={rule.summary}>
      {pending ? <Button title="Approve" onPress={() => approveAutomationRule(rule)} /> : null}
      <Button variant="icon" icon="trash" size="m" onPress={() => removeAutomationRule(rule)} tooltip={pending ? "Remove" : "Revoke"} />
    </Row>
  );
}

export function useAutomationRuleRows(): ReactNode[] {
  const { pending, approved } = useAutomationRules();
  const empty = pending.length === 0 && approved.length === 0;
  return [
    <Row key="automationRules" anchor="advanced.automationRules" description={empty ? `${setting("advanced.automationRules").description} Nothing is waiting for approval.` : undefined} />,
    ...pending.map((rule) => <RuleRow key={rule.key} rule={rule} pending />),
    ...approved.map((rule) => <RuleRow key={rule.key} rule={rule} pending={false} />),
  ];
}
