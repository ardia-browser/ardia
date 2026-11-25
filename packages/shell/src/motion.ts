export type MotionBurst = { frames: number; milliseconds: number; longest: number; long: number; epoch: string };

export type MotionNative = { onBurst(listen: (burst: MotionBurst) => void, consentEpoch: () => string): () => void };
