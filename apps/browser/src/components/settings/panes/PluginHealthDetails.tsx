import { resumePlugin } from "../../../state/plugins/actions";
import { usePluginHealth } from "../../../state/plugins/hooks";
import { Button } from "../../ui";
import { Row } from "../Form";

const STATUS_TEXT = { running: "Running", sleeping: "Asleep until you use it", paused: "Paused", starting: "Starting", stopped: "Stopped", failed: "Stopped with an error" } as const;

const megabytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;

export function PluginHealthDetails({ name }: { name: string }) {
  const health = usePluginHealth((s) => s.rows[name]);
  if (!health) return null;
  const parts = [
    STATUS_TEXT[health.status],
    health.memoryBytes !== null ? megabytes(health.memoryBytes) : null,
    health.contentTabs ? `scripts in ${health.contentTabs} ${health.contentTabs === 1 ? "tab" : "tabs"}` : null,
    health.channels ? `${health.channels} open ${health.channels === 1 ? "connection" : "connections"}` : null,
    health.lastError,
  ].filter((part): part is string => !!part);
  return (
    <Row title="Health" description={parts.join(" · ")}>
      {health.paused ? <Button title="Resume" onPress={() => resumePlugin(name)} /> : null}
    </Row>
  );
}
