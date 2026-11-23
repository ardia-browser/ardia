import type { ArdiaHost } from "../host";

export const UPDATE_METHODS: readonly string[] = [];

export const installsUpdates = (_host: ArdiaHost | undefined): boolean => false;

export const updatesAvailable = (_host: ArdiaHost): boolean => false;
