import { createContext, useContext } from "react";
import { controlSize, radius, type ControlSize } from "./tokens";

export const ControlSizeContext = createContext<ControlSize>("regular");

export function useControlSize() {
  const size = controlSize[useContext(ControlSizeContext)];
  return { button: size.button, buttonPad: size.buttonPad, field: size.field, radius: radius[size.radius] };
}
