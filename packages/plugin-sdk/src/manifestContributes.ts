import {
  LIMITS_V3,
  OMNIBOX_KEYWORD_PATTERN,
  PAGE_BAR_ACTIONS,
  PAGE_BAR_DIVIDER,
  PANEL_MODES_V3,
  ROW_TYPES_V3,
  RUN_AT,
  SPLIT_SIDES_V3,
  argument,
  cssPath,
  description,
  eventName,
  jsonPath,
  key,
  matchPattern,
  name,
  pageTitle,
  pluginPath,
  scriptPath,
  shortcut,
  symbol,
  title,
  when,
} from "./manifestParts";
import { arr, bool, int, json, num, obj, oneOf, str, text, union, withDefault, type Infer } from "./spec";

const list = <T>(item: Parameters<typeof arr<T>>[0], max: number, description?: string) => arr(item, { max, ...(description ? { description } : {}) });

const keywords = arr(text(LIMITS_V3.keyword), { max: LIMITS_V3.commandKeywords });

const openProperties = {
  open: oneOf(["tab", "split"] as const, "Open the plugin's page as a tab, or in Split View beside the current tab"),
  context: bool("Hand the page the current tab (needs the tabs permission)"),
  side: oneOf(SPLIT_SIDES_V3),
  sideSetting: key,
  path: str({ pattern: "^(/[^?#\\s]*)?(\\?[^#\\s]*)?$", max: 512, rule: "a path in the plugin's page like /history" }),
};

export const commandSpec = obj(
  {
    name,
    title,
    icon: symbol,
    keywords,
    shortcut,
    tool: name,
    input: json(),
    when,
    view: key,
    panel: key,
    inputMode: key,
    handler: oneOf([true] as const, "main handles it; the default when there's a main and nothing else"),
    ...openProperties,
  },
  { required: ["name", "title"] },
);

export const inputModeSpec = obj(
  { id: key, title, placeholder: text(LIMITS_V3.title), icon: symbol, keywords },
  { required: ["id", "title"] },
);

const menuItem = obj({ command: name, title, icon: symbol, when }, { required: ["command"] });
const menuList = arr(menuItem, { max: LIMITS_V3.menuItems });

const row = obj(
  {
    key,
    title,
    description,
    type: oneOf(ROW_TYPES_V3),
    default: union([bool(), str({ max: 1024, rule: "text" }), num()], "true, false, text or a number"),
    choices: arr(obj({ value: key, title }, { required: ["value", "title"] }), { min: LIMITS_V3.choices[0], max: LIMITS_V3.choices[1] }),
    min: num(),
    max: num(),
    step: num({ exclusiveMinimum: 0 }),
    placeholder: title,
  },
  { required: ["key", "title", "type"] },
);

const program = obj(
  {
    name,
    path: pluginPath("an executable file inside the plugin's folder, like bin/tool"),
    example: text(LIMITS_V3.example),
    afterUpdate: arr(arr(argument, { min: 1, max: 8 }), { max: 4 }),
    claim: oneOf([true] as const),
  },
  { required: ["name", "path"] },
);

const tool = obj(
  { name, title, description, timeout: withDefault(int(LIMITS_V3.toolTimeout[0], LIMITS_V3.toolTimeout[1]), 30), input: json("A JSON Schema for the tool's input") },
  { required: ["name", "title"] },
);

export const pageStyleSpec = obj(
  { id: key, matches: arr(matchPattern, { min: 1, max: LIMITS_V3.matches }), css: cssPath, when },
  { required: ["id", "matches", "css"] },
);

export const contentScriptSpec = obj(
  {
    id: key,
    matches: arr(matchPattern, { min: 1, max: LIMITS_V3.matches }),
    js: arr(scriptPath, { min: 1, max: LIMITS_V3.contentScriptFiles }),
    css: arr(cssPath, { max: LIMITS_V3.contentScriptFiles }),
    runAt: withDefault(oneOf(RUN_AT), "document_idle"),
    allFrames: bool(),
  },
  { required: ["id", "matches", "js"] },
);

const pageBar = obj(
  {
    look: oneOf(["stripes"] as const),
    when: obj({ siteSwitch: key, localAddresses: key }, { required: ["siteSwitch"] }),
    buttons: arr(oneOf([...PAGE_BAR_ACTIONS, PAGE_BAR_DIVIDER] as const), { min: 1, max: LIMITS_V3.pageBarButtons }),
  },
  { required: ["look", "when", "buttons"] },
);

const passwordManager = obj(
  {
    fill: oneOf(["system"] as const),
    fields: arr(oneOf(["login", "oneTimeCode"] as const), { min: 1, max: 2, unique: true }),
    verificationCodeSetup: oneOf(["system"] as const),
    passkeys: oneOf(["system"] as const),
  },
  { required: ["fill", "fields"] },
);

export const contributesSpec = obj(
  {
    commands: list(commandSpec, LIMITS_V3.commands),
    inputModes: list(inputModeSpec, LIMITS_V3.inputModes, "Modes the command bar switches into, each with its own placeholder"),
    toolbar: list(obj({ id: key, title, icon: symbol, command: name, view: key, tooltip: text(LIMITS_V3.tooltip) }, { required: ["id", "title", "icon"] }), LIMITS_V3.toolbar),
    sidebarViews: list(obj({ id: key, title: pageTitle, icon: symbol }, { required: ["id", "title"] }), LIMITS_V3.sidebarViews),
    panels: list(
      obj(
        { id: key, title: pageTitle, icon: symbol, mode: oneOf(PANEL_MODES_V3), file: pluginPath("a page inside the plugin's folder"), view: key, retainContext: bool(), side: oneOf(SPLIT_SIDES_V3) },
        { required: ["id", "title", "mode"] },
      ),
      LIMITS_V3.panels,
    ),
    menus: obj({ tab: menuList, group: menuList, page: menuList, selection: menuList, link: menuList, image: menuList }, { what: "contributes.menus" }),
    omnibox: list(
      obj(
        { id: key, title, keyword: str({ pattern: OMNIBOX_KEYWORD_PATTERN, rule: "1 to 32 letters, digits, - and _" }), global: bool("Shows in every search; takes no keyword") },
        { required: ["id", "title"] },
      ),
      LIMITS_V3.omnibox,
    ),
    pageStyles: list(pageStyleSpec, LIMITS_V3.pageStyles, "CSS Ardia adds to pages that match (needs permissions.pages to cover matches)"),
    contentScripts: list(contentScriptSpec, LIMITS_V3.contentScripts, "Scripts Ardia runs in an isolated world on pages that match (needs permissions.pages to cover matches)"),
    netRules: jsonPath,
    siteSwitches: list(obj({ key, title: text(LIMITS_V3.switchTitle), icon: symbol }, { required: ["key", "title"] }), LIMITS_V3.siteSwitches),
    pageBar,
    themes: list(obj({ id: key, title, file: jsonPath }, { required: ["id", "title", "file"] }), LIMITS_V3.themes),
    hooks: arr(eventName, { max: LIMITS_V3.hooks, unique: true }),
    tools: list(tool, LIMITS_V3.tools),
    programs: list(program, LIMITS_V3.programs, "Commands Ardia puts on your PATH while the plugin is on"),
    settings: obj({ defaults: json("Ardia settings, as in config.json"), rows: list(row, LIMITS_V3.rows) }, { what: "contributes.settings" }),
    passwordManager,
  },
  { what: "contributes" },
);

export type ContributesV3 = Infer<typeof contributesSpec>;
export type CommandV3 = Infer<typeof commandSpec>;
export type ContentScriptV3 = Infer<typeof contentScriptSpec>;
export type PageStyleV3 = Infer<typeof pageStyleSpec>;
