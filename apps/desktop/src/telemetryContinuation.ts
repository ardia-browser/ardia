import { hostSupports, invokeHost, type ArdiaHost } from "./host.ts";

const TELEMETRY_STEP = "telemetry";

export async function continuesSession(host: ArdiaHost, report: (error: unknown) => void): Promise<boolean> {
  if (!hostSupports("ArdiaShell.launchSteps", host) || !hostSupports("ArdiaShell.completeLaunchStep", host)) return false;
  try {
    const steps = await invokeHost<unknown>("ArdiaShell.launchSteps", { args: [] }, host);
    if (Array.isArray(steps) && steps.includes(TELEMETRY_STEP)) return true;
    await invokeHost("ArdiaShell.completeLaunchStep", { args: [TELEMETRY_STEP] }, host);
  } catch (error) {
    report(error);
  }
  return false;
}
