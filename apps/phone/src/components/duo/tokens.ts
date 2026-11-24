import { spring } from "../ui/motion";

export const duoInk = { pageDim: "rgba(0,0,0,0.12)" } as const;

export const duoMotion = { slide: spring(0.26, 1), reducedFade: 200 } as const;
