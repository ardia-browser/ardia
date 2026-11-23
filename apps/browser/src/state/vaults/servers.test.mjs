import assert from "node:assert/strict";
import { test } from "node:test";
import { customServerURL, initialServer, serverLabel, serverValue } from "./servers.ts";

const servers = [
  { id: "us", title: "Bitwarden.com", custom: null },
  { id: "eu", title: "Bitwarden.eu", url: "https://vault.bitwarden.eu", custom: null },
  { id: "selfHosted", title: "Self-Hosted", custom: { title: "Server URL", placeholder: "vault.example.com" } },
];

test("a custom server is https, or http only on this Mac's loopback, and never carries a user or password", () => {
  assert.equal(customServerURL("vault.example.com/"), "https://vault.example.com");
  assert.equal(customServerURL("https://pw.example.org/vaultwarden"), "https://pw.example.org/vaultwarden");
  assert.equal(customServerURL("http://localhost:8080"), "http://localhost:8080");
  assert.equal(customServerURL("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(customServerURL("http://[::1]:8080"), "http://[::1]:8080");
  for (const refused of ["", "   ", "not a url", "intranet", "http://vault.example.com", "https://sam:pw@vault.example.com", "ftp://vault.example.com", `https://${"a".repeat(2050)}.com`]) {
    assert.equal(customServerURL(refused), null, refused.slice(0, 40));
  }
});

test("the sheet opens on the server the provider already uses, a preset by id, title or address, else the custom one with its address", () => {
  assert.deepEqual(initialServer(servers, undefined), { id: "us", url: "" });
  assert.deepEqual(initialServer(servers, "eu"), { id: "eu", url: "" });
  assert.deepEqual(initialServer(servers, "https://vault.bitwarden.eu/"), { id: "eu", url: "" });
  assert.deepEqual(initialServer(servers, "Bitwarden.com"), { id: "us", url: "" }, "native reports a preset by its title");
  assert.deepEqual(initialServer(servers, "https://vault.example.com"), { id: "selfHosted", url: "https://vault.example.com" });
  assert.deepEqual(initialServer([], "https://vault.example.com"), { id: "", url: "" });
  assert.deepEqual(initialServer(servers.slice(0, 2), "https://vault.example.com"), { id: "us", url: "" });
});

test("a sign-in sends a preset's id or the checked custom address, and the row names only a server that isn't the default", () => {
  assert.equal(serverValue(servers, { id: "eu", url: "ignored" }), "eu");
  assert.equal(serverValue(servers, { id: "selfHosted", url: "vault.example.com" }), "https://vault.example.com");
  assert.equal(serverValue(servers, { id: "selfHosted", url: "http://vault.example.com" }), null);
  assert.equal(serverValue([], { id: "", url: "" }), undefined);
  assert.equal(serverLabel(servers, undefined), null);
  assert.equal(serverLabel(servers, "us"), null);
  assert.equal(serverLabel(servers, "eu"), "Bitwarden.eu");
  assert.equal(serverLabel(servers, "https://vault.example.com:8443/"), "vault.example.com");
});
