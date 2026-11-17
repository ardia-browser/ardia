let bookmarkExports = 0;
let passwordExports = 0;
let unpackedInstalls = 0;
let bookmarkExportFailures = 0;
let passwordExportFailures = 0;
let passwordListShows = 0;
let passwordListLargeShows = 0;
let passwordListSlowShows = 0;

const LARGE_PASSWORD_LIST = 1000;
const SLOW_PASSWORD_LIST_MS = 1000;

export const noteBookmarkExport = () => void (bookmarkExports += 1);
export const notePasswordExport = () => void (passwordExports += 1);
export const noteUnpackedInstall = () => void (unpackedInstalls += 1);
export const noteBookmarkExportFailure = () => void (bookmarkExportFailures += 1);
export const notePasswordExportFailure = () => void (passwordExportFailures += 1);

export function notePasswordListShown(logins: number, ms: number) {
  passwordListShows += 1;
  if (logins >= LARGE_PASSWORD_LIST) passwordListLargeShows += 1;
  if (ms >= SLOW_PASSWORD_LIST_MS) passwordListSlowShows += 1;
}

export function takeExportCounts() {
  const taken = {
    bookmark_html_exports: bookmarkExports,
    password_exports: passwordExports,
    unpacked_extension_installs: unpackedInstalls,
    bookmark_html_export_failures: bookmarkExportFailures,
    password_export_failures: passwordExportFailures,
    password_list_shows: passwordListShows,
    password_list_large_shows: passwordListLargeShows,
    password_list_slow_shows: passwordListSlowShows,
  };
  bookmarkExports = 0;
  passwordExports = 0;
  unpackedInstalls = 0;
  bookmarkExportFailures = 0;
  passwordExportFailures = 0;
  passwordListShows = 0;
  passwordListLargeShows = 0;
  passwordListSlowShows = 0;
  return taken;
}
