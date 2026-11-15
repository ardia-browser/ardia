import { requireOptionalNativeModule } from "../modules";

export * from "./reactNativeEngine";

export const TurboModuleRegistry = {
  get: <Module>(name: string): Module | null => requireOptionalNativeModule<Module>(name),
  getEnforcing: <Module>(name: string): Module => {
    const found = requireOptionalNativeModule<Module>(name);
    if (!found) throw new Error(`${name} is not on Linux`);
    return found;
  },
};
