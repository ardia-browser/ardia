import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { mount } from "../../test-hooks.mjs";

const { DialogActions } = await import("../ui/Dialog.tsx");
const { passwordPromptWidth } = await import("./Prompts.tsx");
const { POPOVER_WIDTH } = await import("../ui/tokens.ts");

const flat = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
const pill = (title) => React.createElement("Pill", { key: title, title });
const row = (props, titles) => mount(() => DialogActions({ ...props, children: titles.map(pill) })).value;
const kids = (node) => [node.props.children].flat(Infinity).filter(Boolean);

test("a row of buttons alone holds only the buttons, so no empty spacer takes a gap before the first one", () => {
  const actions = row({}, ["Never on This Site", "Not Now", "Connect"]);
  assert.deepEqual(kids(actions).map((k) => k.props.title), ["Never on This Site", "Not Now", "Connect"]);
  const style = flat(actions.props.style);
  assert.equal(style.justifyContent, "flex-end", "the buttons sit at the trailing edge");
  assert.equal(style.flexWrap, "wrap", "buttons that don't fit move to a second line instead of running past the panel's edge");
});

test("a leading button keeps to the leading edge and a note fills the space between", () => {
  const lead = React.createElement("Pill", { title: "Delete" });
  const withLeading = kids(row({ leading: lead }, ["Cancel", "Save"]));
  assert.equal(withLeading.length, 3);
  assert.equal(flat(withLeading[0].props.style).marginRight, "auto");
  assert.equal(withLeading[0].props.children, lead);
  const withNote = kids(row({ leading: lead, note: "Saved just now" }, ["Done"]));
  assert.equal(withNote.length, 3);
  assert.equal(flat(withNote[0].props.style).marginRight, undefined, "the note already pushes the buttons over");
  assert.equal(flat(withNote[1].props.style).flex, 1);
  assert.equal(kids(row({ leading: null }, ["Done"])).length, 1, "a missing leading button adds nothing");
});

test("the password prompt is wide enough for its buttons: Connect gets the wide prompt, Save the medium, Update the small", () => {
  assert.equal(passwordPromptWidth({ state: "save" }), POPOVER_WIDTH.m);
  assert.equal(passwordPromptWidth({ state: "update" }), POPOVER_WIDTH.s);
  assert.equal(passwordPromptWidth({ state: "save", target: "applePasswords" }), POPOVER_WIDTH.l);
  assert.equal(passwordPromptWidth({ state: "update", target: "applePasswords" }), POPOVER_WIDTH.s);
  assert.equal(passwordPromptWidth({ state: "notSaved", target: "applePasswords" }), POPOVER_WIDTH.m);
});
