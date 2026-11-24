import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (file) => readFileSync(new URL(`../ios/${file}`, import.meta.url), "utf8");

test("Chromium reports committedAt with the automation feed off, so a reload closes a verification code prompt", () => {
  const navigation = read("ArdiaWebView+Navigation.mm");
  const emit = navigation.slice(navigation.indexOf("NSMutableDictionary *withInitial"), navigation.indexOf("navigation = withInitial;"));
  const gate = emit.indexOf("if (ArdiaWebView.reportsCommits)");
  assert.ok(gate > 0);
  const at = emit.indexOf('withInitial[@"committedAt"]');
  assert.ok(at > 0 && at < gate, "committedAt is set before the automation feed's gate");
  assert.ok(emit.indexOf("[self noteDocumentCommits]") < at, "commits are counted before committedAt is read");
  assert.ok(emit.indexOf('withInitial[@"committedUrl"]') > gate, "committedUrl stays with the automation feed");
});

test("WebKit reports committedAt on every navigation", () => {
  assert.match(read("WebKitTab.swift"), /"committedAt": committedAt,/);
});
