import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { mount } from "../../test-hooks.mjs";

const { DialogActions } = await import("./Dialog.tsx");

const flat = (style) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
const pill = (title) => React.createElement("Pill", { key: title, title });
const row = (props, titles) => mount(() => DialogActions({ ...props, children: titles.map(pill) })).value;
const kids = (node) => [node.props.children].flat(Infinity).filter(Boolean);

test("a row of buttons alone holds only the buttons, so no empty spacer takes a gap before the first one", () => {
  const actions = row({}, ["Never on This Site", "Not Now", "Save"]);
  assert.deepEqual(
    kids(actions).map((k) => k.props.title),
    ["Never on This Site", "Not Now", "Save"],
  );
  const style = flat(actions.props.style);
  assert.equal(style.justifyContent, "flex-end", "the buttons sit at the trailing edge");
  assert.equal(style.flexWrap, "wrap", "buttons that don't fit move to a second line instead of running past the panel's edge");
});

test("a leading button keeps to the leading edge, and several leading buttons stay side by side", () => {
  const lead = React.createElement("Pill", { title: "Delete" });
  const withLeading = kids(row({ leading: lead }, ["Cancel", "Save"]));
  assert.equal(withLeading.length, 3);
  const leadingStyle = flat(withLeading[0].props.style);
  assert.equal(leadingStyle.marginRight, "auto");
  assert.equal(leadingStyle.flexDirection, "row");
  assert.equal(withLeading[0].props.children, lead);
  assert.equal(kids(row({ leading: null }, ["Done"])).length, 1, "a missing leading button adds nothing");
});

test("a note fills the space between the leading button and the buttons", () => {
  const lead = React.createElement("Pill", { title: "Delete" });
  const withNote = kids(row({ leading: lead, note: "Saved just now" }, ["Done"]));
  assert.equal(withNote.length, 3);
  assert.equal(flat(withNote[0].props.style).marginRight, undefined, "the note already pushes the buttons over");
  assert.equal(flat(withNote[1].props.style).flex, 1);
});
