declare const __ARDIA_APP_VERSION__: string | undefined;

const builtVersion = typeof __ARDIA_APP_VERSION__ === "string" && __ARDIA_APP_VERSION__ ? __ARDIA_APP_VERSION__ : null;

export const appVersionOf = (hostVersion: string, built: string | null = builtVersion): string => built ?? hostVersion;
