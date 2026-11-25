import { actionWords } from "../../lib/sharedWords";

export const newTabLabel = (incognito: boolean) => (incognito ? actionWords.newIncognitoTab : actionWords.newTab);
