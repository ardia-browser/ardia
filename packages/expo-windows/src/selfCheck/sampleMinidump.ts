const LOW = 0x100000000;
const STREAM_MODULES = 4;
const STREAM_EXCEPTION = 6;
const STREAM_MISC_INFO = 15;
const STREAM_CRASHPAD = 0x43500001;

type SampleModule = { base: number; size: number; path: string };

type SampleDump = {
  time?: number;
  created?: number;
  process?: string;
  engineVersion?: string;
  appVersion?: string;
  code?: number;
  address?: number;
  firstParameter?: number;
  modules?: SampleModule[];
};

export const SAMPLE_GPU_MODULE = "nvoglv64.dll";

const SAMPLE_MODULES: SampleModule[] = [
  { base: 0x7ff600000000, size: 0x2000000, path: "C:\\Program Files\\Ardia\\Ardia.exe" },
  { base: 0x7ffa10000000, size: 0x1800000, path: `C:\\Windows\\System32\\DriverStore\\FileRepository\\sample.inf\\${SAMPLE_GPU_MODULE}` },
];

class Blob {
  private chunks: Uint8Array[] = [];
  size = 0;

  put(bytes: Uint8Array) {
    const at = this.size;
    this.chunks.push(bytes);
    this.size += bytes.length;
    const pad = (4 - (this.size % 4)) % 4;
    if (pad > 0) {
      this.chunks.push(new Uint8Array(pad));
      this.size += pad;
    }
    return at;
  }

  bytes() {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

const record = (size: number, fill: (view: DataView) => void) => {
  const bytes = new Uint8Array(size);
  fill(new DataView(bytes.buffer));
  return bytes;
};

const put64 = (view: DataView, at: number, value: number) => {
  view.setUint32(at, value % LOW, true);
  view.setUint32(at + 4, Math.floor(value / LOW), true);
};

const text = (blob: Blob, value: string) =>
  blob.put(
    record(4 + value.length, (view) => {
      view.setUint32(0, value.length, true);
      for (let index = 0; index < value.length; index++) view.setUint8(4 + index, value.charCodeAt(index));
    }),
  );

const wide = (blob: Blob, value: string) =>
  blob.put(
    record(4 + value.length * 2, (view) => {
      view.setUint32(0, value.length * 2, true);
      for (let index = 0; index < value.length; index++) view.setUint16(4 + index * 2, value.charCodeAt(index), true);
    }),
  );

export function sampleMinidump(options: SampleDump = {}): Uint8Array {
  const { time = 1_794_770_653, created = 1_794_770_650, code = 0xc0000005, firstParameter = 0, modules = SAMPLE_MODULES } = options;
  const address = options.address ?? (modules.at(-1)?.base ?? 0) + 0x1234;
  const blob = new Blob();
  const streams: [number, number, number][] = [];
  blob.put(new Uint8Array(32));

  streams.push([
    STREAM_MISC_INFO,
    24,
    blob.put(
      record(24, (view) => {
        view.setUint32(0, 24, true);
        view.setUint32(4, 2, true);
        view.setUint32(8, 1, true);
        view.setUint32(12, created, true);
      }),
    ),
  ]);

  streams.push([
    STREAM_EXCEPTION,
    168,
    blob.put(
      record(168, (view) => {
        view.setUint32(0, 262, true);
        view.setUint32(8, code >>> 0, true);
        put64(view, 24, address);
        view.setUint32(32, 2, true);
        put64(view, 40, firstParameter);
      }),
    ),
  ]);

  const named = modules.map((module) => ({ ...module, name: wide(blob, module.path) }));
  streams.push([
    STREAM_MODULES,
    4 + named.length * 108,
    blob.put(
      record(4 + named.length * 108, (view) => {
        view.setUint32(0, named.length, true);
        named.forEach((module, index) => {
          const at = 4 + index * 108;
          put64(view, at, module.base);
          view.setUint32(at + 8, module.size, true);
          view.setUint32(at + 20, module.name, true);
        });
      }),
    ),
  ]);

  const simple: [string, string][] = [];
  if (options.process) simple.push(["ptype", options.process]);
  if (options.engineVersion) simple.push(["ver", options.engineVersion]);
  const pairs = simple.map(([key, value]): [number, number] => [text(blob, key), text(blob, value)]);
  const dictionary = blob.put(
    record(4 + pairs.length * 8, (view) => {
      view.setUint32(0, pairs.length, true);
      pairs.forEach(([key, value], index) => {
        view.setUint32(4 + index * 8, key, true);
        view.setUint32(8 + index * 8, value, true);
      });
    }),
  );

  const objects: [string, string][] = options.appVersion ? [["ardia-ver", options.appVersion]] : [];
  const entries = objects.map(([key, value]): [number, number] => [text(blob, key), text(blob, value)]);
  const objectsSize = 4 + entries.length * 12;
  const annotations = blob.put(
    record(objectsSize, (view) => {
      view.setUint32(0, entries.length, true);
      entries.forEach(([key, value], index) => {
        view.setUint32(4 + index * 12, key, true);
        view.setUint16(8 + index * 12, 1, true);
        view.setUint32(12 + index * 12, value, true);
      });
    }),
  );
  const moduleInfo = blob.put(
    record(28, (view) => {
      view.setUint32(0, 1, true);
      view.setUint32(20, objectsSize, true);
      view.setUint32(24, annotations, true);
    }),
  );
  const moduleLinks = blob.put(
    record(16, (view) => {
      view.setUint32(0, 1, true);
      view.setUint32(4, 0, true);
      view.setUint32(8, 28, true);
      view.setUint32(12, moduleInfo, true);
    }),
  );
  streams.push([
    STREAM_CRASHPAD,
    52,
    blob.put(
      record(52, (view) => {
        view.setUint32(0, 1, true);
        view.setUint32(36, 4 + pairs.length * 8, true);
        view.setUint32(40, dictionary, true);
        view.setUint32(44, 16, true);
        view.setUint32(48, moduleLinks, true);
      }),
    ),
  ]);

  const directory = blob.put(
    record(streams.length * 12, (view) => {
      streams.forEach(([type, size, rva], index) => {
        view.setUint32(index * 12, type, true);
        view.setUint32(index * 12 + 4, size, true);
        view.setUint32(index * 12 + 8, rva, true);
      });
    }),
  );

  const bytes = blob.bytes();
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x504d444d, true);
  header.setUint32(4, 0xa793, true);
  header.setUint32(8, streams.length, true);
  header.setUint32(12, directory, true);
  header.setUint32(20, time, true);
  return bytes;
}

export const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
