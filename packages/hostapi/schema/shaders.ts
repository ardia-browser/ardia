import { defineModuleDomain } from "../define.ts";

export const shaders = defineModuleDomain({
  kind: "module",
  package: "packages/shaders",
  imports: {},
  types: {
    MetalSurfaceSnapshot:
      "{ file: string; class: string; ok: boolean; window: number; frame: [number, number, number, number]; key: boolean; main: boolean; drawable: [number, number]; hidden: boolean; alpha: number }",
  },
  modules: {
    ArdiaAreaLight: {
      functions: {
        debugSnapshot: {
          args: [["dir", "string"]],
          result: "MetalSurfaceSnapshot[]",
          swiftResult: "[[String: Any]]",
          async: true,
          queue: "main",
          mac: "custom",
          desktop: "absent",
          windows: "absent",
        },
      },
      events: {},
    },
    ArdiaWindowBackdrop: {
      functions: {
        holdKeyLook: {
          args: [["on", "boolean"]],
          result: "void",
          async: true,
          queue: "main",
          mac: "custom",
          desktop: "custom",
          windows: "absent",
        },
      },
      events: {},
    },
    ArdiaMeadow: {
      functions: {
        debugState: {
          args: [],
          result: "Record<string, unknown>",
          swiftResult: "[String: Any]",
          async: true,
          queue: "main",
          mac: "custom",
          desktop: "absent",
          windows: "absent",
        },
        debugEval: {
          args: [["script", "string"]],
          result: "unknown",
          async: true,
          promise: true,
          queue: "main",
          mac: "custom",
          desktop: "absent",
          windows: "absent",
        },
      },
      events: {},
    },
  },
});
