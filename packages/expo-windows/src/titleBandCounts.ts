import type { TitleBandNative, TitleBandPresses } from "@ardia/shell";

const presses: TitleBandPresses = { taken: 0, leftToText: 0 };

export const noteTitleBandPress = (kind: keyof TitleBandPresses) => void (presses[kind] += 1);

export const windowsTitleBand: TitleBandNative = {
  takePresses() {
    const taken = { ...presses };
    presses.taken = 0;
    presses.leftToText = 0;
    return taken;
  },
};
