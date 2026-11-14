import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBusConnection, type Variant } from "../engine/dbus";

export const dbusDaemonAvailable = (): boolean => spawnSync("dbus-daemon", ["--version"], { stdio: "ignore" }).status === 0;

export type PrivateBus = { address: string; stop(): void };

export function privateBus(): Promise<PrivateBus> {
  const folder = mkdtempSync(join(tmpdir(), "ardia-bus-"));
  const daemon: ChildProcess = spawn("dbus-daemon", ["--session", "--nofork", "--nopidfile", "--print-address=1", `--address=unix:path=${join(folder, "bus")}`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const stop = () => {
    daemon.kill();
    rmSync(folder, { recursive: true, force: true });
  };
  return new Promise((resolve, reject) => {
    let printed = "";
    const deadline = setTimeout(() => {
      stop();
      reject(new Error("dbus-daemon didn't start"));
    }, 5_000);
    daemon.once("error", (error) => {
      clearTimeout(deadline);
      stop();
      reject(error);
    });
    daemon.stdout!.on("data", (chunk: Buffer) => {
      printed += chunk.toString("utf8");
      if (!printed.includes("\n")) return;
      clearTimeout(deadline);
      resolve({ address: printed.split("\n")[0]!.trim(), stop });
    });
  });
}

export const LOGIND = "org.freedesktop.login1";
export const SESSION_INTERFACE = "org.freedesktop.login1.Session";

export type FakeLogind = {
  connection: DBusConnection;
  sessionPath(id: string): string;
  lock(id: string): void;
  lockedHint(id: string, locked: boolean): void;
  calls: string[];
};

export async function fakeLogind(address: string, sessionsByPid: Record<number, string>): Promise<FakeLogind> {
  const connection = await DBusConnection.connect(address);
  await connection.requestName(LOGIND);
  const sessionPath = (id: string) => `/org/freedesktop/login1/session/_3${id}`;
  const calls: string[] = [];
  connection.serve((call) => {
    calls.push(`${call.member}(${call.body.join(",")})`);
    if (call.member === "GetSession") return { signature: "o", body: [sessionPath(String(call.body[0]))] };
    if (call.member === "GetSessionByPID") {
      const id = sessionsByPid[Number(call.body[0])];
      if (!id) throw new Error("PID does not belong to any known session");
      return { signature: "o", body: [sessionPath(id)] };
    }
    throw new Error(`no method ${call.member}`);
  });
  return {
    connection,
    sessionPath,
    calls,
    lock: (id) => connection.emit({ path: sessionPath(id), interface: SESSION_INTERFACE, member: "Lock" }),
    lockedHint: (id, locked) =>
      connection.emit({
        path: sessionPath(id),
        interface: "org.freedesktop.DBus.Properties",
        member: "PropertiesChanged",
        signature: "sa{sv}as",
        body: [SESSION_INTERFACE, { LockedHint: { signature: "b", value: locked } satisfies Variant, IdleHint: { signature: "b", value: false } satisfies Variant }, []],
      }),
  };
}

export async function fakeScreenSaver(address: string, name: string, path: string): Promise<{ connection: DBusConnection; active(active: boolean): void }> {
  const connection = await DBusConnection.connect(address);
  await connection.requestName(name);
  return { connection, active: (active) => connection.emit({ path, interface: name, member: "ActiveChanged", signature: "b", body: [active] }) };
}
