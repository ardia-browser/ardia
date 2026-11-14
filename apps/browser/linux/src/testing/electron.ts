import { EventEmitter } from "node:events";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

class FakeIpcMain extends EventEmitter {
  readonly handlers = new Map<string, Handler>();
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }
  invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) return Promise.reject(new Error(`nothing handles ${channel}`));
    return Promise.resolve(handler(event, ...args));
  }
}

export const ipcMain = new FakeIpcMain();

export const app = Object.assign(new EventEmitter(), {
  isPackaged: true,
  getAppPath: () => process.cwd(),
  exit: () => undefined,
});

type Backend = "basic_text" | "gnome_libsecret" | "kwallet" | "kwallet5" | "kwallet6" | "unknown";
const KEYRING_PREFIX = "v11";
const BASIC_PREFIX = "v10";

export const safeStorage = {
  backend: "basic_text" as Backend,
  plainTextAllowed: false,
  getSelectedStorageBackend(): Backend {
    return this.backend;
  },
  isEncryptionAvailable(): boolean {
    return this.backend !== "basic_text" || this.plainTextAllowed;
  },
  setUsePlainTextEncryption(allowed: boolean): void {
    this.plainTextAllowed = allowed;
  },
  encryptString(plainText: string): Buffer {
    if (!this.isEncryptionAvailable()) throw new Error("Error while encrypting the text provided to safeStorage.encryptString. Encryption is not available.");
    const prefix = this.backend === "basic_text" ? BASIC_PREFIX : KEYRING_PREFIX;
    return Buffer.concat([Buffer.from(prefix), Buffer.from(plainText, "utf8").map((byte) => byte ^ 0x5a)]);
  },
  decryptString(encrypted: Buffer): string {
    const prefix = encrypted.subarray(0, 3).toString();
    if (prefix === KEYRING_PREFIX && this.backend === "basic_text") throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    if (prefix !== KEYRING_PREFIX && prefix !== BASIC_PREFIX) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    return Buffer.from(encrypted.subarray(3).map((byte) => byte ^ 0x5a)).toString("utf8");
  },
};

export class BrowserWindow extends EventEmitter {}
export const contextBridge = { exposeInMainWorld: () => undefined, executeInMainWorld: () => undefined };
export const ipcRenderer = new EventEmitter();

export const session = { defaultSession: { name: "default" } };
