export type SelfCheck = { name: string; run(): Promise<void> | void };

export type SelfCheckNative = { register(check: SelfCheck): void };
