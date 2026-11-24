import { autofill } from "./autofill.ts";
import { bookmarks } from "./bookmarks.ts";
import { contentBlocker } from "./contentBlocker.ts";
import { downloads } from "./downloads.ts";
import { engine } from "./engine.ts";
import { extensions } from "./extensions.ts";
import { favicons } from "./favicons.ts";
import { history } from "./history.ts";
import { importModules } from "./import.ts";
import { media } from "./media.ts";
import { passwords } from "./passwords.ts";
import { permissions } from "./permissions.ts";
import { profiles } from "./profiles.ts";
import { search } from "./search.ts";
import { shaders } from "./shaders.ts";
import { shell } from "./shell.ts";
import { sites } from "./sites.ts";
import { sync } from "./sync.ts";
import { tabs } from "./tabs.ts";
import { webKit } from "./webKit.ts";
import { webView } from "./webView.ts";
import { windows } from "./windows.ts";

export const domains = { autofill, bookmarks, contentBlocker, downloads, engine, extensions, favicons, history, media, passwords, permissions, profiles, search, sites, tabs, webKit, webView, windows };

export const moduleDomains = { shaders, shell, sync, import: importModules };

export { desktopHost } from "./desktop.ts";
