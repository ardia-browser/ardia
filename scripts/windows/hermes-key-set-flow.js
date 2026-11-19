function emptyScope() {
  return { records: {}, base: {}, unapplied: [], vv: {}, extra: {}, files: {}, damaged: {}, seq: 0, outbox: [], seen: {}, joined: false, snapshotAt: 0, pending: 0 };
}

function isFields(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scan(records) {
  var total = 0;
  var bad = 0;
  for (var key in records) {
    total++;
    var r = records[key];
    if (!isFields(r) || typeof r.h !== "string" || !("v" in r) || !Array.isArray(r.o) || typeof r.o[0] !== "string" || typeof r.o[1] !== "number") bad++;
  }
  return total + " records, " + bad + " wrong-typed";
}

function scanChanged(changed) {
  var live = {};
  var removed = 0;
  for (var key in changed) {
    if (changed[key] === null) removed++;
    else live[key] = changed[key];
  }
  return scan(live) + " and " + removed + " removed";
}

function stats() {
  var internal = typeof HermesInternal !== "undefined" && HermesInternal.getInstrumentedStats ? HermesInternal.getInstrumentedStats() : null;
  return internal ? "heap " + internal.js_heapSize + ", allocated " + internal.js_allocatedBytes + ", gcs " + internal.js_numGCs : "no stats";
}

function restOf(state) {
  var rest = { ...state };
  delete rest.records;
  delete rest.base;
  return rest;
}

function changedEntries(before, after) {
  var changed = {};
  for (var key in after) if (before[key] !== after[key]) changed[key] = after[key];
  for (var gone in before) if (!(gone in after)) changed[gone] = null;
  return changed;
}

function apply(variant, scoped) {
  var keys = Object.keys(scoped.records);
  var fresh = "h:https://new.example.test/opened-while-quitting.html";
  var record = function (v) {
    return { h: "zzzzzzzzz.0000.test", v: v, o: ["test", scoped.seq + 1] };
  };
  if (variant === "add" || variant === "addDelete") {
    scoped.records[fresh] = record({ t: "new", n: 1, vt: [Date.now()] });
    scoped.base[fresh] = JSON.stringify(scoped.records[fresh].v);
  }
  if (variant === "addDelete") {
    delete scoped.records[keys[0]];
    delete scoped.base[keys[0]];
    return "added 1, deleted 1";
  }
  if (variant === "add") return "added 1";
  if (variant === "delete") {
    var deleted = 0;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].indexOf("h:") !== 0) continue;
      delete scoped.records[keys[i]];
      delete scoped.base[keys[i]];
      deleted++;
    }
    return "deleted " + deleted;
  }
  return "no change";
}

function round(n) {
  var doc = JSON.parse(STATE_TEXT);
  var scopes = {};
  for (var name in doc.scopes) {
    var scope = doc.scopes[name];
    if (isFields(scope) && isFields(scope.records) && isFields(scope.base)) scopes[name] = { ...emptyScope(), ...scope };
  }
  var profile = null;
  for (var each in scopes) if (each !== "app") profile = each;
  if (!profile) return "round " + n + ": no profile scope";
  var scoped = scopes[profile];
  if (typeof COPY === "string" && COPY === "spread") {
    scoped.records = { ...scoped.records };
    scoped.base = { ...scoped.base };
  }
  if (typeof COPY === "string" && COPY === "forin") {
    var records0 = {};
    var base0 = {};
    for (var r0 in scoped.records) records0[r0] = scoped.records[r0];
    for (var b0 in scoped.base) base0[b0] = scoped.base[b0];
    scoped.records = records0;
    scoped.base = base0;
  }
  for (var stamped in scoped.records) scoped.records[stamped].h.split(".");
  var parsed = scan(scoped.records);
  var records = { ...scoped.records };
  var base = { ...scoped.base };
  var done = apply(VARIANT, scoped);
  var scanned = scan(scoped.records);
  var changes = {};
  changes[profile] = { records: changedEntries(records, scoped.records), base: changedEntries(base, scoped.base), rest: restOf(scoped) };
  var text = JSON.stringify({ device: "test", clock: "zzzzzzzzz.0000.test", changes: changes, id: Date.now(), version: 1 });
  var again = scanChanged(JSON.parse(text).changes[profile].records);
  return "round " + n + ": parsed " + parsed + "; " + done + "; then " + scanned + "; part " + text.length + " characters (" + again + "); " + stats();
}

for (var r = 1; r <= 5; r++) {
  try {
    print(LABEL + " " + VARIANT + " " + round(r));
  } catch (error) {
    print(LABEL + " " + VARIANT + " round " + r + " threw " + error);
  }
}
print(LABEL + " " + VARIANT + ": done");
