import "./styles/index.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { createMockClient } from "./client/mock";
import { seedWorkspaces } from "./client/seed";
import { DEFAULT_VIEW, addOption, addProperty, addView, createRow, readSchema, readViews, updateView } from "../shared/database";
import { pageDocId, treeDocId } from "../shared/protocol";

const emptyStart = new URLSearchParams(location.search).has("empty");
const client = createMockClient({ seed: emptyStart ? (api) => api.addWorkspace({ id: "e0e0e0e0e0e0", name: "My Notes", icon: "", shared: false, folderId: null }) : seedWorkspaces });
(window as unknown as { notesClient: unknown }).notesClient = client;
(window as unknown as { __notesDb: unknown }).__notesDb = { client, DEFAULT_VIEW, addOption, addProperty, addView, createRow, readSchema, readViews, updateView, pageDocId, treeDocId };

function DevSaveToggle() {
  const [failing, setFailing] = useState(client.internals.saveFailing());
  return (
    <div className="n-dev-tools" data-testid="dev-tools">
      <label>
        <input
          type="checkbox"
          checked={failing}
          data-testid="dev-save-failing"
          onChange={(e) => {
            client.internals.setSaveFailing(e.target.checked);
            setFailing(e.target.checked);
          }}
        />
        Simulate save failure
      </label>
      <button type="button" data-testid="dev-refuse" onClick={() => client.internals.refuseEdit()}>
        Refuse an edit
      </button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <>
    <App client={client} />
    {new URLSearchParams(location.search).has("devtools") ? <DevSaveToggle /> : null}
  </>,
);
