import { readDocument } from "../../platform/documents";

export const SESSION_DOCUMENT = "session.json";
export const olderBuildSessionDocument = (version: number) => `session-older-build-v${version}.json`;

export const hasSavedSession = () => !!readDocument(SESSION_DOCUMENT);
