import type { NotesClient } from "../client/types";
import type { PageId, WorkspaceId } from "../../shared/protocol";
import { useDatabase } from "./data";
import { RowPropertiesView } from "./propertyList";
import "./styles";

export type RowPropertiesProps = { client: NotesClient; workspace: WorkspaceId; database: PageId; row: PageId };

export function RowProperties({ client, workspace, database, row }: RowPropertiesProps) {
  const m = useDatabase(client, workspace, database);
  const meta = m?.store.pages.get(row);
  if (!m || !meta) return null;
  return <RowPropertiesView m={m} row={meta} />;
}
