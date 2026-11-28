import assert from "node:assert/strict";
import { test } from "node:test";
import { compositeOver, inkChannels, luminanceContrast, plateLuminance, READABLE_GLYPH, READABLE_TEXT } from "../../lib/readableInk.ts";
import { fileExtension, fileKindOf, fileTileLabel, toastTileInk } from "./toastTokens.ts";

const luminance = (color: string) => {
  const [red, green, blue] = inkChannels(color);
  return plateLuminance(red, green, blue);
};

const contrast = (ink: string, under: string) => luminanceContrast(luminance(compositeOver(ink, under)), luminance(under));

test("a file's tile names its kind in three or four letters: PDF, ZIP, IMG, APK, or its own short extension", () => {
  assert.equal(fileTileLabel(fileExtension("ok-report.pdf")), "PDF");
  assert.equal(fileTileLabel(fileExtension("b.zip")), "ZIP");
  assert.equal(fileTileLabel(fileExtension("photo.JPEG")), "IMG");
  assert.equal(fileTileLabel(fileExtension("ardia.apk")), "APK");
  assert.equal(fileTileLabel(fileExtension("notes.docx")), "DOC");
  assert.equal(fileTileLabel(fileExtension("model.stl")), "STL");
  assert.equal(fileTileLabel(fileExtension("README")), "FILE");
  assert.equal(fileTileLabel(fileExtension("weird.superlong")), "FILE");
  assert.equal(fileKindOf("tgz"), "archive");
  assert.equal(fileExtension(".hidden"), "");
});

test("every tile's label reads at 4.5:1 on its colour, and the warning glyph at 3:1 on amber", () => {
  for (const fill of Object.values(toastTileInk.file)) assert.ok(contrast(toastTileInk.fileLabel, fill) >= READABLE_TEXT, fill);
  assert.ok(contrast(toastTileInk.countLabel, toastTileInk.count) >= READABLE_TEXT);
  assert.ok(contrast(toastTileInk.warningGlyph, toastTileInk.warning) >= READABLE_GLYPH);
});
