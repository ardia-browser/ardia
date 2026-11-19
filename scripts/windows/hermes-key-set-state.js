var DEVICE = "k3v9p2x7m4q8w1z6r5t0y2u8bd";
var SCOPE = "p:q7r33vuasg667zycjbbfcxedfu";
var SHAPE_OPTIONS = typeof SHAPE === "string" ? SHAPE.split("+") : [];
var has = function (option) {
  return SHAPE_OPTIONS.indexOf(option) >= 0;
};

function canonical(v) {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + canonical(v[k]); }).join(",") + "}";
  return JSON.stringify(v);
}

function stamp(ms, counter) {
  return ms.toString(36).padStart(9, "0") + "." + counter.toString(36).padStart(4, "0") + "." + DEVICE;
}

function filler(i, length) {
  var text = "";
  while (text.length < length) text += " part " + ((i * 2654435761) >>> 0).toString(36);
  return text.slice(0, length);
}

function value(i, now) {
  var site = i % 4000;
  var visits = has("visits") ? 1 + (i % 50) : 1;
  var vt = [];
  for (var v = 0; v < visits; v++) vt.push(now - 60000 - i * 138240 - v * 3600000);
  var t = has("long") ? ("Article " + i + " on site " + site + filler(i, 40 + (i % 81))).slice(0, 40 + (i % 81)) : "Article " + i + " on site " + site;
  var out = { t: t, n: 1 + (i % 7), vt: vt };
  if (has("deep")) out.m = { s: { site: site, path: ["articles", String(i)], seen: { first: vt[0], last: vt[vt.length - 1] } } };
  return out;
}

function url(i) {
  var base = "https://site" + (i % 4000) + ".example/articles/" + i;
  return has("long") ? (base + "/" + filler(i, 60 + (i % 141)).replace(/ /g, "-")).slice(0, 60 + (i % 141)) : base;
}

function makeState(n) {
  var now = 1795000000000;
  var records = {};
  var base = {};
  for (var i = 0; i < n; i++) {
    var key = "h:" + url(i);
    var v = value(i, now);
    records[key] = { h: stamp(now - i * 1000, i % 1296), v: v, o: [DEVICE, i % 3 === 0 ? 3 : 2] };
    if (!has("nobase")) base[key] = canonical(v);
  }
  records["tabs:" + DEVICE] = { h: stamp(now, 1), v: { n: "Device", tabs: [{ u: "https://example.test/", t: "Tab" }] }, o: [DEVICE, 3] };
  base["tabs:" + DEVICE] = canonical(records["tabs:" + DEVICE].v);
  var vv = {};
  vv[DEVICE] = 3;
  var seen = {};
  seen[DEVICE] = now;
  var files = {};
  files["s-" + DEVICE + "-1"] = { d: DEVICE, k: "snapshot", vv: { [DEVICE]: 2 }, at: now - 9000, b: 9000000 };
  files["l-" + DEVICE + "-2"] = { d: DEVICE, k: "log", s: 2, at: now - 5000, b: 4000 };
  files["l-" + DEVICE + "-3"] = { d: DEVICE, k: "log", s: 3, at: now - 1000, b: 3000 };
  var rest = { unapplied: [], vv: vv, extra: {}, files: files, damaged: {}, seq: 3, outbox: [], seen: seen, joined: true, snapshotAt: now - 9000, pending: 0 };
  var profile = Object.assign({ records: records, base: base }, rest);
  var appRecords = {};
  var appBase = {};
  appRecords["prof:" + SCOPE.slice(2)] = { h: stamp(now, 2), v: { n: "Profile" }, o: [DEVICE, 2] };
  appRecords["dev:" + DEVICE] = { h: stamp(now, 3), v: { n: "Device", k: "desktop" }, o: [DEVICE, 2] };
  for (var k in appRecords) appBase[k] = canonical(appRecords[k].v);
  var app = Object.assign({ records: appRecords, base: appBase }, JSON.parse(JSON.stringify(rest)), { seq: 2 });
  var scopes = { app: app };
  scopes[SCOPE] = profile;
  return JSON.stringify({ covers: now, clock: stamp(now, 5), scopes: scopes, version: 1 });
}

var STATE_TEXT = makeState(N);
(function summary() {
  var doc = JSON.parse(STATE_TEXT);
  var p = doc.scopes[SCOPE];
  var kind = function (v) {
    return Array.isArray(v) ? "list of " + v.length : v && typeof v === "object" ? "object of " + Object.keys(v).length : typeof v;
  };
  print("generated " + N + " keys, shape " + (SHAPE_OPTIONS.join("+") || "real") + ": " + STATE_TEXT.length + " characters; profile " + Object.keys(p).sort().map(function (f) { return f + ": " + kind(p[f]); }).join(", "));
})();
