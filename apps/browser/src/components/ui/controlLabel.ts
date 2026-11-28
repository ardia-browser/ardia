import { createContext, useContext } from "react";

export const ControlLabelContext = createContext<string | undefined>(undefined);

export function useControlLabel(own?: string): string | undefined {
  const fromRow = useContext(ControlLabelContext);
  return own ?? fromRow;
}
