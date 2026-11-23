import { fileURLToPath } from "node:url";

const DRIVE = /(?<![A-Za-z0-9])([A-Za-z]):\//g;

export const toPosixPath = (path: string): string => path.replaceAll("\\", "/");

export const pathKey = (path: string): string => toPosixPath(path).replace(DRIVE, (drive) => drive.toLowerCase());

export const posixFilePath = (url: URL | string, windows?: boolean): string => toPosixPath(fileURLToPath(url, { windows }));

export const keyedPaths = <V>(entries: Iterable<readonly [string, V]>): Map<string, V> => new Map([...entries].map(([path, value]) => [pathKey(path), value]));

export const pathKeys = (paths: Iterable<string>): Set<string> => new Set([...paths].map(pathKey));
