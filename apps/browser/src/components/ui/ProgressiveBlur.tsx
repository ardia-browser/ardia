import { progressiveBlurView, type ProgressiveBlurProps } from "@ardia/shell";

export function ProgressiveBlur(props: ProgressiveBlurProps) {
  const Blur = progressiveBlurView();
  return Blur ? <Blur {...props} /> : null;
}
