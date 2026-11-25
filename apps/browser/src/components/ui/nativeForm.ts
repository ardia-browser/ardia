import { createContext, useContext } from "react";

export const NativeFormContext = createContext(false);

export const useNativeForm = () => useContext(NativeFormContext);
