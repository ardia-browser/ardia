import type { MarkDownloadFlight } from "./downloadFlight";
import { downloadFlightFromPageCentre } from "./launchConfig";
export type { DownloadFlightMark, MarkDownloadFlight } from "./downloadFlight";

export const downloadFlightFromPageEdge = (): boolean => !downloadFlightFromPageCentre();

export const downloadFlightWaitsForIcon = (): boolean => true;

const point = ({ x, y }: { x: number; y: number }) => `${Math.round(x)},${Math.round(y)}`;

export const markDownloadFlight: MarkDownloadFlight = (stage, flight) =>
  console.info(
    `[ardia windows] download flight ${stage} from ${point(flight.start)} to ${point(flight.target)} arc ${flight.arc} icon ${flight.icon} in ${Math.round(flight.width)}x${Math.round(flight.height)} over ${flight.ms} ms ${flight.fromPageEdge ? "from the page edge" : "from the page centre"} after ${flight.waitedMs} ms for its icon at ${Date.now()}`,
  );
