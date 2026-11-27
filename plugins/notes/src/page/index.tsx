import "./styles/index.css";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { createBridgeClient } from "./client/bridge";
import { createMockClient } from "./client/mock";
import { seedWorkspaces } from "./client/seed";

const hasArdia = typeof (window as unknown as { ardia?: unknown }).ardia === "object" && (window as unknown as { ardia?: unknown }).ardia !== null;
const client = hasArdia ? createBridgeClient() : createMockClient({ seed: seedWorkspaces });

(window as unknown as { notesClient: unknown }).notesClient = client;

createRoot(document.getElementById("root")!).render(<App client={client} />);
