import { bridge, invokeMain, invokeMainSync, mainModules } from "./bridge";
import { moduleDefaults } from "./defaults";
import { engineModules } from "./engine/modules";
import { addNativeListener, type EventSubscription } from "./events";
import { noteMissing } from "./missing";
import { serviceModules } from "./services/modules";
import { aroundMain, writtenInTs } from "./tsModules";

type Call = (...values: unknown[]) => unknown;
type Listener = (payload: unknown) => void;

const modules = new Map<string, object>();

function mainMember(name: string, key: string): Call | unknown {
  const shape = mainModules()[name];
  const linux = bridge();
  if (!shape || !linux) return undefined;
  if (shape.sync.includes(key)) return (...args: unknown[]) => invokeMainSync(linux, name, key, args);
  if (shape.async.includes(key)) return (...args: unknown[]) => invokeMain(linux, name, key, args);
  if (shape.constants && Object.hasOwn(shape.constants, key)) return shape.constants[key];
  return undefined;
}

const inert = (module: string, key: string) => () => {
  noteMissing(`${module}.${key}`);
  return Promise.resolve(null);
};

function answer(name: string, key: string): unknown {
  const fromMain = mainMember(name, key);
  const wrap = aroundMain[name]?.[key];
  if (wrap) return wrap(typeof fromMain === "function" ? (fromMain as Call) : null);
  if (fromMain !== undefined) return fromMain;
  for (const layer of [writtenInTs, engineModules, serviceModules]) {
    const module = layer[name];
    if (module && Object.hasOwn(module, key)) return module[key];
  }
  const defaults = moduleDefaults[name];
  if (defaults && Object.hasOwn(defaults, key)) {
    noteMissing(`${name}.${key}`);
    return defaults[key];
  }
  if (key === "addListener") return (event: string, listener: Listener): EventSubscription => addNativeListener(name, event, listener);
  if (key === "removeListeners" || key === "removeAllListeners") return () => {};
  return inert(name, key);
}

function moduleOnLinux(name: string): object {
  const cached = modules.get(name);
  if (cached) return cached;
  const answers = new Map<string, unknown>();
  const made = new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string" || key === "then" || key === "$$typeof" || key === "toJSON") return undefined;
        if (answers.has(key)) return answers.get(key);
        const value = answer(name, key);
        answers.set(key, value);
        return value;
      },
      has: (_target, key) => typeof key === "string",
    },
  );
  modules.set(name, made);
  return made;
}

const known = (name: string) => !!(mainModules()[name] || writtenInTs[name] || aroundMain[name] || engineModules[name] || serviceModules[name] || moduleDefaults[name]);

export function requireNativeModule<Module = unknown>(name: string): Module {
  return moduleOnLinux(name) as Module;
}

export function requireOptionalNativeModule<Module = unknown>(name: string): Module | null {
  return known(name) ? (moduleOnLinux(name) as Module) : null;
}
