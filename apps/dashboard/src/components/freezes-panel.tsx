import { Panel } from "@/components/blocks";
import { DataTable } from "@/components/data-table";
import { Loaded, TableSkeleton, useSection } from "@/components/section";
import { formatExact, formatMs } from "@/lib/format";
import type { SectionData } from "@/server/sections";

type Freezes = SectionData<"performance.freezes">;
type Signature = Freezes["signatures"][number];

const THREAD: Record<string, string> = { main: "Main thread", js: "Interface (JS)" };

function Signatures({ data }: { data: Freezes }) {
  if (!data.signatures.length) return <p className="text-sm text-muted-foreground">No freezes reported in the last 7 days.</p>;
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground">
        {formatExact(data.freezes)} freezes, {formatMs(data.frozenMs)} frozen in all, across {formatExact(data.signatures.length)} places. Top first: most people affected, then most time frozen.
      </p>
      <DataTable
        dense
        rows={data.signatures}
        rowKey={(s: Signature) => s.signature}
        limit={10}
        columns={[
          {
            key: "where",
            header: "Where",
            cell: (s: Signature) => (
              <span className="font-mono text-[12px]" title={s.topFrames.join("\n") || "No frames from Ardia's own code"}>
                {s.topFrames[0] ?? `no own frames (${s.signature})`}
              </span>
            ),
          },
          { key: "thread", header: "Thread", cell: (s: Signature) => THREAD[s.thread] ?? s.thread },
          { key: "activity", header: "Job", cell: (s: Signature) => (s.activity && s.activity !== "none" ? s.activity : "–") },
          { key: "people", header: "People", align: "right", sort: (s: Signature) => s.people, cell: (s: Signature) => formatExact(s.people) },
          { key: "freezes", header: "Freezes", align: "right", sort: (s: Signature) => s.freezes, cell: (s: Signature) => formatExact(s.freezes) },
          { key: "frozen", header: "Frozen", align: "right", sort: (s: Signature) => s.frozenMs, cell: (s: Signature) => formatMs(s.frozenMs) },
          { key: "version", header: "Latest version", cell: (s: Signature) => <span className="font-mono text-[12px]">{s.latestVersion}</span> },
        ]}
      />
    </>
  );
}

export function FreezesPanel() {
  const freezes = useSection("performance.freezes");
  return (
    <Panel
      source="app"
      title="Freezes"
      description="app_freeze over the last 7 days, grouped by where Ardia's own code was stuck (the top three frames from Ardia's own files). Hover a place for its frames; symbolicate offsets with the engine's symbols."
    >
      <Loaded query={freezes} skeleton={<TableSkeleton rows={6} columns={7} />}>
        {(data) => <Signatures data={data} />}
      </Loaded>
    </Panel>
  );
}
