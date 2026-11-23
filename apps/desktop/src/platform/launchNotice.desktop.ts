import type { ArdiaHost } from "../host";
import type { LaunchClaim } from "../appServices";

export const noticeLaunch = async (_host: ArdiaHost, _windowId: string, _launch: Promise<LaunchClaim>): Promise<boolean> => false;
