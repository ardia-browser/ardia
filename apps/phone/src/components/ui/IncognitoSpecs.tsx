import { IncognitoEyes } from "./IncognitoEyes";
import type { SymbolName } from "./symbolPaths";

export const privateMark: SymbolName = "eyes";

export function IncognitoSpecs({ size, color, testID }: { size: number; color: string; testID?: string }) {
  return <IncognitoEyes incognito testID={testID} size={size} color={color} />;
}
