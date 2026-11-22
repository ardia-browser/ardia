const ch = (code) => String.fromCharCode(code);

export const LINE_BREAKS = {
  lf: ch(10),
  cr: ch(13),
  crlf: ch(13) + ch(10),
  ff: ch(12),
  vt: ch(11),
  nel: ch(0x85),
  lineSeparator: ch(0x2028),
  paragraphSeparator: ch(0x2029),
};

export const CONTROLS = {
  nul: ch(0),
  tab: ch(9),
  unitSeparator: ch(0x1f),
  del: ch(0x7f),
  bom: ch(0xfeff),
  zeroWidthSpace: ch(0x200b),
  rightToLeftOverride: ch(0x202e),
  softHyphen: ch(0xad),
  loneSurrogate: ch(0xd800),
};

export const FILTER_SYNTAX = {
  scriptlet: "##+js(set-constant, ardiaFixtureMarker, 1)",
  scriptletInBody: "+js(set-constant, ardiaFixtureMarker, 1)",
  exception: "#@#.ardia-fixture",
  htmlFilter: "##^script:has-text(ardiaFixtureMarker)",
  responseHeader: "##^responseheader(x-ardia-fixture)",
  adguardScriptlet: "#%#//scriptlet('set-constant', 'ardiaFixtureMarker', '1')",
  adguardCss: "#$#.ardia-fixture { display: none }",
  extendedCss: "#?#.ardia-fixture:has-text(x)",
  network: "||ardia-fixture.invalid^",
  redirect: "||ardia-fixture.invalid^$redirect=noopjs",
  removeparam: "||ardia-fixture.invalid^$removeparam=x",
  preparserIf: "!#if env_chromium",
  preparserInclude: "!#include ardia-fixture.txt",
  comment: "! ardia fixture",
  commentOpener: "/" + "*",
  commentCloser: "*" + "/",
  braces: "{ display: none }",
  procedural: ":has-text(ardiaFixtureMarker)",
  styleAction: ":style(display: none !important)",
  removeAction: ":remove()",
  continuation: " \\",
};

export const URL_SCHEMES = {
  javascript: "javascript:void(0)",
  javascriptMixedCase: "JaVaScRiPt:void(0)",
  javascriptLeadingSpace: " javascript:void(0)",
  javascriptTab: "java" + ch(9) + "script:void(0)",
  javascriptNewline: "java" + ch(10) + "script:void(0)",
  javascriptEncoded: "javascript%3Avoid(0)",
  vbscript: "vbscript:msgbox(1)",
  data: "data:text/html,<p>ardia fixture</p>",
  dataBase64: "data:text/html;base64,PHA+YXJkaWEgZml4dHVyZTwvcD4=",
  file: "file:///etc/hosts",
  fileHost: "file://ardia-fixture.invalid/share",
  chrome: "chrome://settings",
  chromeUntrusted: "chrome-untrusted://ardia-fixture",
  extension: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html",
  devtools: "devtools://devtools/bundled/inspector.html",
  viewSource: "view-source:https://ardia-fixture.invalid/",
  blob: "blob:https://ardia-fixture.invalid/00000000-0000-0000-0000-000000000000",
  filesystem: "filesystem:https://ardia-fixture.invalid/temporary/x",
  aboutSrcdoc: "about:srcdoc",
  ardiaUnknown: "ardia://ardia-fixture-unknown",
  arcLegacyUnknown: "arc://ardia-fixture-unknown",
  credentials: "https://user:pass@ardia-fixture.invalid/",
  backslashHost: "https:\\\\ardia-fixture.invalid",
  noHost: "https:///path",
  schemeRelative: "//ardia-fixture.invalid/",
};

export const PATHS = {
  parent: "../../etc/hosts",
  encodedParent: "..%2f..%2fetc%2fhosts",
  doubleEncodedParent: "%252e%252e%252fetc",
  dotEncodedParent: "%2e%2e/%2e%2e/etc",
  backslashParent: "..\\..\\etc\\hosts",
  absolute: "/etc/hosts",
  home: "~/.ssh/id_ed25519",
  nulTruncation: "a.json" + ch(0) + ".png",
};

export const PROTOTYPE_KEYS = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "length", "__defineGetter__"];

export const OVERLONG = {
  long: "a".repeat(10_000),
  veryLong: "a".repeat(1_000_000),
};

const pollutedProto = JSON.parse('{"__proto__": {"ardiaPolluted": true}}');
const sparse = [];
sparse[1] = 1;

export const WRONG_TYPES = {
  null: null,
  undefined: undefined,
  zero: 0,
  negative: -1,
  fraction: 0.5,
  nan: NaN,
  infinity: Infinity,
  huge: Number.MAX_SAFE_INTEGER + 2,
  true: true,
  false: false,
  emptyString: "",
  emptyArray: [],
  emptyObject: {},
  arrayOfEmpty: [""],
  nestedArray: [[[]]],
  nullPrototype: Object.create(null),
  date: new Date(0),
  map: new Map([["a", 1]]),
  regexp: /ardia/,
  sparse,
  pollutedProto,
  objectWithToString: { toString: () => "https://ardia-fixture.invalid/" },
  numericString: "1",
  booleanString: "true",
};

const named = (group, entries) => Object.entries(entries).map(([name, value]) => ({ id: `${group}.${name}`, value }));

export const HOSTILE_STRINGS = [
  ...named("lineBreak", LINE_BREAKS),
  ...named("control", CONTROLS),
  ...named("filter", FILTER_SYNTAX),
  ...named("url", URL_SCHEMES),
  ...named("path", PATHS),
  ...PROTOTYPE_KEYS.map((key) => ({ id: `prototype.${key}`, value: key })),
  ...named("overlong", OVERLONG),
  ...Object.entries(LINE_BREAKS).flatMap(([name, br]) => [
    { id: `smuggle.${name}.scriptlet`, value: `x${br}ardia-fixture.invalid${FILTER_SYNTAX.scriptlet}` },
    { id: `smuggle.${name}.network`, value: `x${br}${FILTER_SYNTAX.redirect}` },
    { id: `smuggle.${name}.commentWrapped`, value: `head${FILTER_SYNTAX.commentOpener}${br}*${FILTER_SYNTAX.scriptlet}${br}${FILTER_SYNTAX.commentCloser}` },
    { id: `smuggle.${name}.url`, value: `https://ardia-fixture.invalid/${br}${URL_SCHEMES.javascript}` },
  ]),
];

export const HOSTILE_VALUES = [...HOSTILE_STRINGS, ...named("type", WRONG_TYPES)];

export const LINE_TERMINATORS = /[\n\r\f\v\u0085\u2028\u2029]/;

export const UBLOCK_LINE_BREAK = /[\n\r]/;

export function embedded(value, before = "", after = "") {
  return [value, `${before}${value}`, `${value}${after}`, `${before}${value}${after}`];
}
