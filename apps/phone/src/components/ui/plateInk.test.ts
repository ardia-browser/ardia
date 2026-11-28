import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../..", import.meta.url));

export const PLATES = ["ChromeSurface", "LookFrost", "ChromeFrost", "LookGlass", "OverlayPlate", "ToastPlate", "Plate", "PlainPlate", "MenuMaterial"] as const;

const INK_PROPS = /\b(color|placeholderTextColor|selectionColor|tintColor|roles|ink|dark)\s*=\s*\{/g;

const INK_STYLES = /\b(color|tintColor)\s*:\s*([^,}\n]+)/g;

const FOREIGN_INK = /\btheme\.|\brolesFor\(|\boverlayInk\.|\bchromeInk\.|\bcolorRoles\.|(?<![\w.])roles\.|\bstartInk\.|\breaderInk\./;

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (path.endsWith(".tsx") && !path.includes(".test.") && !path.includes(`${join("src", "dev")}`)) out.push(path);
  }
  return out;
}

function tagEnd(text: string, from: number): { end: number; selfClosing: boolean } | null {
  let braces = 0;
  for (let at = from; at < text.length; at++) {
    const char = text[at];
    if (char === "{") braces++;
    else if (char === "}") braces--;
    else if (char === ">" && braces === 0) return { end: at + 1, selfClosing: text[at - 1] === "/" };
  }
  return null;
}

function expressionAt(text: string, open: number): string {
  let braces = 0;
  for (let at = open; at < text.length; at++) {
    if (text[at] === "{") braces++;
    else if (text[at] === "}" && --braces === 0) return text.slice(open + 1, at);
  }
  return text.slice(open + 1);
}

export type ForeignInk = { file: string; line: number; plate: string; prop: string; value: string };

export function foreignInk(file: string, text: string): ForeignInk[] {
  const found: ForeignInk[] = [];
  for (const plate of PLATES) {
    const opening = new RegExp(`<${plate}[\\s>]`, "g");
    for (let match = opening.exec(text); match; match = opening.exec(text)) {
      const start = tagEnd(text, match.index + plate.length + 1);
      if (!start || start.selfClosing) continue;
      const either = new RegExp(`<${plate}[\\s>]|</${plate}>`, "g");
      either.lastIndex = start.end;
      let depth = 1;
      let close = -1;
      for (let next = either.exec(text); next; next = either.exec(text)) {
        if (next[0].startsWith("</")) {
          if (--depth === 0) {
            close = next.index;
            break;
          }
        } else if (!tagEnd(text, next.index + plate.length + 1)?.selfClosing) depth++;
      }
      if (close < 0) continue;
      const body = text.slice(start.end, close);
      INK_PROPS.lastIndex = 0;
      for (let prop = INK_PROPS.exec(body); prop; prop = INK_PROPS.exec(body)) {
        const value = expressionAt(body, prop.index + prop[0].length - 1);
        if (FOREIGN_INK.test(value)) found.push({ file, line: text.slice(0, start.end + prop.index).split("\n").length, plate, prop: prop[1]!, value: value.trim() });
      }
      INK_STYLES.lastIndex = 0;
      for (let style = INK_STYLES.exec(body); style; style = INK_STYLES.exec(body)) {
        if (FOREIGN_INK.test(style[2]!)) found.push({ file, line: text.slice(0, start.end + style.index).split("\n").length, plate, prop: style[1]!, value: style[2]!.trim() });
      }
    }
  }
  return found;
}

test("text and icons drawn on a glass, frost or solid plate take their ink from the plate's own shade, never from the theme or a fixed table", () => {
  const found = sources(join(SOURCE, "components")).flatMap((file) => foreignInk(relative(SOURCE, file), readFileSync(file, "utf8")));
  assert.deepEqual(found.map((ink) => `${ink.file}:${ink.line} <${ink.plate}> ${ink.prop}={${ink.value}}`), []);
});

test("the check catches theme ink inside a plate and lets plate ink through", () => {
  const caught = foreignInk("probe.tsx", `<ChromeSurface dark={dark}>\n<Symbol color={theme.label} />\n<Text style={{ color: rolesFor(dark).label }} />\n</ChromeSurface>`);
  assert.deepEqual(caught.map((ink) => ink.value), ["theme.label", "rolesFor(dark).label"]);
  assert.deepEqual(foreignInk("probe.tsx", `<ChromeSurface dark={dark}><PlateSymbol name="x" /><Symbol color={plate.roles.label} /></ChromeSurface>`), []);
  assert.equal(foreignInk("probe.tsx", `<LookFrost fill={fill}>\n<Glyph color={overlayInk.label} />\n</LookFrost>`).length, 1);
});

test("every menu plate names the shade its ink table is chosen by", () => {
  const unnamed = sources(join(SOURCE, "components")).flatMap((file) => {
    const text = readFileSync(file, "utf8");
    return [...text.matchAll(/<MenuMaterial\b/g)].filter((match) => !/\bdark=\{/.test(text.slice(match.index, tagEnd(text, match.index + 13)?.end ?? match.index))).map((match) => `${relative(SOURCE, file)}:${text.slice(0, match.index).split("\n").length}`);
  });
  assert.deepEqual(unnamed, []);
});
