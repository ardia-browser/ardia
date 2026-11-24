import { engineAvailable, hostCall } from "../engine/host";
import { expectEqual, expectTrue, type Check } from "./check";
import { firstWindow } from "./engineSleep";

const EDGE_KEY = "self-check-top-edge";
const EDGE_URL = "data:text/html,<title>top edge</title><p>a page that reaches the window's top edge</p>";
const PLACE = { unit: "px", x: 0, y: 0, width: 400, height: 200 };

type Hit = { hit?: unknown; appHit?: unknown };

const hitAt = (x: number, y: number) => hostCall<Hit>("tab.hitTest", { key: EDGE_KEY, x, y });

const topEdgeChecks: Check[] = [
  {
    name: "engine: a page that reaches the window's top edge answers the app window's own top resize band, corners included, and stays the page below it",
    async run() {
      const windowId = await firstWindow();
      await hostCall("tab.create", { key: EDGE_KEY, url: EDGE_URL, profile: "" }, windowId);
      try {
        await hostCall("tab.show", { key: EDGE_KEY, visible: true, ...PLACE }, windowId);
        const width = PLACE.width;
        const points = { middleOfTheTopEdge: [150, 1], windowCorner: [1, 1], pageEndAwayFromTheWindowCorner: [width - 2, 1], belowTheBand: [150, 40] } as const;
        const answers = Object.fromEntries(await Promise.all(Object.entries(points).map(async ([name, [x, y]]) => [name, await hitAt(x, y)] as const)));
        const hits = Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answer.hit]));
        const app = Object.fromEntries(Object.entries(answers).map(([name, answer]) => [name, answer.appHit]));
        const band = ["middleOfTheTopEdge", "windowCorner", "pageEndAwayFromTheWindowCorner"] as const;
        expectTrue(band.every((name) => ["top", "topLeft", "topRight"].includes(String(app[name]))), `the app window's own answers along its top edge: ${JSON.stringify(app)}`);
        expectEqual(hits, { ...Object.fromEntries(band.map((name) => [name, app[name]])), belowTheBand: "client" }, "the page window's hit test along the window's top edge");
      } finally {
        await hostCall("tab.close", { key: EDGE_KEY });
      }
    },
  },
];

export const checks: Check[] = engineAvailable() ? topEdgeChecks : [];
