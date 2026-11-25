import type { SelfCheck, SelfCheckNative } from "@ardia/shell";

const registered: SelfCheck[] = [];

export const windowsSelfChecks: SelfCheckNative = {
  register(check) {
    registered.push(check);
  },
};

export const registeredChecks = (): readonly SelfCheck[] => registered;
