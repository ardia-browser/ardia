import type { WebContents } from "electron";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { defineModule } from "../bridge";
import { note } from "../log";
import { DBusConnection, variant, type Message } from "./dbus";

type Fix = { latitude: number; longitude: number; accuracy: number; altitude?: number; heading?: number; speed?: number };
type State = "idle" | "starting" | "running" | "unavailable";

const GEOCLUE = "org.freedesktop.GeoClue2";
const MANAGER_PATH = "/org/freedesktop/GeoClue2/Manager";
const MANAGER = "org.freedesktop.GeoClue2.Manager";
const CLIENT = "org.freedesktop.GeoClue2.Client";
const LOCATION = "org.freedesktop.GeoClue2.Location";
const DESKTOP_ID = "ardia";
const ACCURACY_EXACT = 8;
const FIRST_FIX_DEADLINE_MS = 10000;
const IDLE_STOP_MS = 5 * 60 * 1000;
const RETRY_UNAVAILABLE_MS = 60000;
const DEBUGGER_PROTOCOL = "1.3";

let state: State = "idle";
let connection: DBusConnection | null = null;
let clientPath = "";
let latest: Fix | null = null;
let unavailableSince = 0;
let unavailableReason = "";
let locationRequests = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const waiting = new Set<(fix: Fix | null) => void>();
const fed = new Set<WebContents>();

const usable = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > -1e300;

async function readFix(path: string): Promise<Fix | null> {
  if (!connection) return null;
  const read = (name: string) => connection!.getProperty(GEOCLUE, path, LOCATION, name);
  const [latitude, longitude, accuracy, altitude, heading, speed] = await Promise.all(["Latitude", "Longitude", "Accuracy", "Altitude", "Heading", "Speed"].map(read));
  if (!usable(latitude) || !usable(longitude)) return null;
  const fix: Fix = { latitude: latitude as number, longitude: longitude as number, accuracy: usable(accuracy) ? (accuracy as number) : 1000 };
  if (usable(altitude)) fix.altitude = altitude as number;
  if (usable(heading) && (heading as number) >= 0) fix.heading = heading as number;
  if (usable(speed) && (speed as number) >= 0) fix.speed = speed as number;
  return fix;
}

function settle(fix: Fix | null) {
  for (const resolve of waiting) resolve(fix);
  waiting.clear();
}

function giveUp(reason: string) {
  if (state !== "unavailable") note("geolocation", `GeoClue isn't available, so pages get "position unavailable": ${reason}`);
  state = "unavailable";
  unavailableSince = Date.now();
  unavailableReason = reason;
  latest = null;
  connection?.close();
  connection = null;
  clientPath = "";
  settle(null);
  for (const contents of fed) emulate(contents, null);
}

function onLocationUpdated(message: Message) {
  if (message.path !== clientPath || message.interface !== CLIENT || message.member !== "LocationUpdated") return;
  const path = String(message.body[1] ?? "");
  void readFix(path)
    .then((fix) => {
      if (!fix) return;
      latest = fix;
      settle(fix);
      for (const contents of fed) emulate(contents, fix);
    })
    .catch(() => {});
}

async function start(): Promise<void> {
  state = "starting";
  try {
    connection = await DBusConnection.system();
    connection.onClose(() => {
      if (state === "running" || state === "starting") giveUp("the system bus connection closed");
    });
    connection.onSignal(onLocationUpdated);
    const [path] = await connection.call({ destination: GEOCLUE, path: MANAGER_PATH, interface: MANAGER, member: "GetClient" });
    clientPath = String(path);
    await connection.setProperty(GEOCLUE, clientPath, CLIENT, "DesktopId", variant("s", DESKTOP_ID));
    await connection.setProperty(GEOCLUE, clientPath, CLIENT, "RequestedAccuracyLevel", variant("u", ACCURACY_EXACT));
    await connection.addMatch(`type='signal',sender='${GEOCLUE}',path='${clientPath}',interface='${CLIENT}',member='LocationUpdated'`);
    await connection.call({ destination: GEOCLUE, path: clientPath, interface: CLIENT, member: "Start" });
    state = "running";
    note("geolocation", "GeoClue started");
    const location = await connection.getProperty(GEOCLUE, clientPath, CLIENT, "Location").catch(() => "/");
    if (typeof location === "string" && location !== "/") {
      const fix = await readFix(location).catch(() => null);
      if (fix) {
        latest = fix;
        settle(fix);
      }
    }
  } catch (error) {
    giveUp(error instanceof Error ? error.message : String(error));
  }
}

function stop() {
  if (state !== "running" && state !== "starting") return;
  const closing = connection;
  const path = clientPath;
  state = "idle";
  connection = null;
  clientPath = "";
  latest = null;
  if (closing && path) void closing.call({ destination: GEOCLUE, path, interface: CLIENT, member: "Stop" }).catch(() => {}).finally(() => closing.close());
  else closing?.close();
  note("geolocation", "GeoClue stopped: no page asked for the location lately");
}

function scheduleIdleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    stop();
  }, IDLE_STOP_MS);
}

function currentFix(): Promise<Fix | null> {
  if (latest) return Promise.resolve(latest);
  if (state === "unavailable" && Date.now() - unavailableSince < RETRY_UNAVAILABLE_MS) return Promise.resolve(null);
  const answer = new Promise<Fix | null>((resolve) => {
    waiting.add(resolve);
    setTimeout(() => {
      if (waiting.delete(resolve)) resolve(null);
    }, FIRST_FIX_DEADLINE_MS);
  });
  if (state === "idle" || state === "unavailable") void start();
  return answer;
}

function emulate(contents: WebContents, fix: Fix | null) {
  if (contents.isDestroyed()) return;
  const session = contents.debugger;
  try {
    if (!session.isAttached()) session.attach(DEBUGGER_PROTOCOL);
  } catch (error) {
    note("geolocation", `couldn't give a page its location: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  void session.sendCommand("Emulation.setGeolocationOverride", fix ?? {}).catch(() => {});
}

export async function provideLocation(contents: WebContents): Promise<void> {
  locationRequests++;
  const fix = await currentFix();
  if (contents.isDestroyed()) return;
  emulate(contents, fix);
  if (!fed.has(contents)) {
    fed.add(contents);
    contents.once("destroyed", () => fed.delete(contents));
  }
  scheduleIdleStop();
}

type LocationPermission = "granted" | "denied" | "restricted" | "notDetermined" | "servicesOff";

const deniedByDesktop = () => state === "unavailable" && /AccessDenied|not allowed|disabled/i.test(unavailableReason);

const locationPermission = async (): Promise<LocationPermission> => (deniedByDesktop() ? "servicesOff" : "granted");

const LOCATION_SETTINGS = [["gnome-control-center", "location"], ["systemsettings", "kcm_location"]] as const;

const onPath = (command: string) => (process.env.PATH ?? "").split(delimiter).some((folder) => folder && existsSync(join(folder, command)));

async function openLocationSettings(): Promise<void> {
  const found = LOCATION_SETTINGS.find(([command]) => onPath(command));
  if (!found) return note("geolocation", "no location settings app to open");
  const child = spawn(found[0], [found[1]], { detached: true, stdio: "ignore" });
  child.on("error", (error) => note("geolocation", `couldn't open the location settings: ${error.message}`));
  child.unref();
}

defineModule("ArdiaLocation", {
  async: {
    locationPermission,
    requestLocationPermission: locationPermission,
    openLocationSettings,
    devLocationRequests: async () => locationRequests,
  },
});
