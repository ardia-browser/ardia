export type RendererEfficiencyCounts = {
  throttled: number;
  restored: number;
  failed: number;
  exemptCall: number;
  exemptCapture: number;
  exemptPictureInPicture: number;
  exemptAudio: number;
};

export type RendererEfficiencyNative = {
  takeCounts(): Record<string, RendererEfficiencyCounts>;
  setConsentEpoch(epoch: string): void;
};
