mod support;

use serde_json::json;
use std::process::Command;
use std::time::{Duration, Instant};
use support::{host_binary, scratch_plugin, Host};

const WAIT: Duration = Duration::from_secs(10);

fn run(name: &str, source: &str, extra: &[&str]) -> (Option<i32>, String, Duration) {
    let folder = scratch_plugin(name, source);
    let mut host = Host::spawn(&folder, "main.js", extra);
    let started = Instant::now();
    let ended = loop {
        if let Some(status) = host.child.try_wait().unwrap() {
            let mut out = String::new();
            use std::io::Read;
            if let Some(mut pipe) = host.child.stderr.take() {
                let _ = pipe.read_to_string(&mut out);
            }
            break (status.code(), out);
        }
        if started.elapsed() > WAIT {
            let ended = host.end(Duration::ZERO);
            panic!("{name} didn't exit; stderr:\n{}", ended.stderr);
        }
        let _ = host.line(Duration::from_millis(20));
    };
    (ended.0, ended.1, started.elapsed())
}

#[test]
fn a_runaway_entry_hits_the_turn_cpu_budget() {
    let (code, stderr, took) = run("cpu-entry", "for (;;) {}", &["--turn-cpu-ms", "200"]);
    assert_eq!(code, Some(72), "{stderr}");
    assert!(stderr.contains("used too much CPU"), "{stderr}");
    assert!(took < Duration::from_secs(3), "{took:?}");
}

#[test]
fn a_runaway_promise_job_is_interrupted_too() {
    let (code, stderr, _) = run("cpu-job", "Promise.resolve().then(() => { for (;;) {} });", &["--turn-cpu-ms", "200"]);
    assert_eq!(code, Some(72), "{stderr}");
}

#[test]
fn a_runaway_timer_callback_is_interrupted() {
    let (code, stderr, _) = run("cpu-timer", "setTimeout(() => { for (;;) {} }, 10);", &["--turn-cpu-ms", "200"]);
    assert_eq!(code, Some(72), "{stderr}");
}

#[test]
fn a_catch_cannot_swallow_the_interrupt() {
    let (code, stderr, _) = run("cpu-catch", "for (;;) { try { for (;;) {} } catch (e) { __ardiaBridge.send('caught'); } }", &["--turn-cpu-ms", "200"]);
    assert_eq!(code, Some(72), "{stderr}");
}

#[test]
fn many_short_turns_add_up_to_the_minute_budget() {
    let source = "const spin = () => { const end = Date.now() + 40; while (Date.now() < end) {} setTimeout(spin, 0); }; spin();";
    let (code, stderr, took) = run("cpu-minute", source, &["--turn-cpu-ms", "1000", "--minute-cpu-ms", "400"]);
    assert_eq!(code, Some(72), "{stderr}");
    assert!(took >= Duration::from_millis(350), "{took:?}");
}

#[test]
fn allocator_exhaustion_ends_with_its_own_code() {
    let source = "const keep = []; for (;;) keep.push(new Array(100000).fill(Math.random()));";
    let (code, stderr, _) = run("oom", source, &["--memory-mb", "32"]);
    assert_eq!(code, Some(71), "{stderr}");
    assert!(stderr.contains("ran out of memory"), "{stderr}");
}

#[test]
fn a_huge_single_allocation_counts_as_exhaustion() {
    let (code, stderr, _) = run("oom-one", "const big = new ArrayBuffer(64 * 1024 * 1024); __ardiaBridge.send(String(big.byteLength));", &["--memory-mb", "32"]);
    assert_eq!(code, Some(71), "{stderr}");
}

#[test]
fn unbounded_recursion_while_loading_is_a_stack_exit() {
    let (code, stderr, _) = run("stack", "function down(n) { return down(n + 1) + 1; } down(0);", &[]);
    assert_eq!(code, Some(73), "{stderr}");
    assert!(stderr.contains("threw while it loaded"), "{stderr}");
}

#[test]
fn caught_recursion_keeps_the_plugin_running() {
    let folder = scratch_plugin("stack-caught", "function down(n) { return down(n + 1) + 1; }\nlet name = '';\ntry { down(0); } catch (e) { name = e.name; }\n__ardiaBridge.send(JSON.stringify({ name }));\n");
    let mut host = Host::spawn(&folder, "main.js", &["--stack-kb", "256"]);
    let message = host.expect(WAIT, "the caught error");
    assert_eq!(message["name"], "RangeError");
    host.close();
    assert_eq!(host.end(WAIT).code, Some(74));
}

#[test]
fn an_entry_that_throws_is_a_load_failure() {
    let (code, stderr, _) = run("throws", "throw new TypeError('nope');", &[]);
    assert_eq!(code, Some(70), "{stderr}");
    assert!(stderr.contains("Uncaught TypeError: nope"), "{stderr}");
    assert!(stderr.contains("main.js threw while it loaded, so the plugin stopped"), "{stderr}");
}

#[test]
fn a_syntax_error_is_a_load_failure() {
    let (code, stderr, _) = run("syntax", "function (", &[]);
    assert_eq!(code, Some(70), "{stderr}");
    assert!(stderr.contains("SyntaxError"), "{stderr}");
}

#[test]
fn a_missing_entry_is_a_load_failure() {
    let folder = scratch_plugin("missing", "");
    let mut host = Host::spawn(&folder, "dist/nope.js", &[]);
    let ended = host.end(WAIT);
    assert_eq!(ended.code, Some(70));
    assert!(ended.stderr.contains("dist/nope.js isn't inside the plugin's folder"), "{}", ended.stderr);
}

#[test]
fn bad_arguments_are_a_usage_exit() {
    let output = Command::new(host_binary()).arg("host").output().unwrap();
    assert_eq!(output.status.code(), Some(64));
    let output = Command::new(host_binary()).output().unwrap();
    assert_eq!(output.status.code(), Some(64));
    let output = Command::new(host_binary()).args(["host", "--entry", "main.js"]).env("ARDIA_PLUGIN_FD", "97").output().unwrap();
    assert_eq!(output.status.code(), Some(64));
    assert!(String::from_utf8_lossy(&output.stderr).contains("ARDIA_PLUGIN_FD 97 isn't open"));
}

#[test]
fn eof_without_a_stop_is_a_channel_closed_exit() {
    let folder = scratch_plugin("eof", "__ardiaBridge.onLine(() => {});");
    let mut host = Host::spawn(&folder, "main.js", &[]);
    std::thread::sleep(Duration::from_millis(100));
    host.close();
    assert_eq!(host.end(WAIT).code, Some(74));
}

#[test]
fn eof_after_plugin_stopping_is_normal() {
    let folder = scratch_plugin("eof-stop", "__ardiaBridge.onLine(() => {});");
    let mut host = Host::spawn(&folder, "main.js", &[]);
    host.send(&json!({ "event": "plugin.stopping", "time": 0, "data": {} }));
    std::thread::sleep(Duration::from_millis(50));
    host.close();
    assert_eq!(host.end(WAIT).code, Some(0));
}

#[test]
fn staying_past_the_stop_grace_is_a_shutdown_deadline_exit() {
    let folder = scratch_plugin("linger", "__ardiaBridge.onLine(() => {}); setInterval(() => {}, 20);");
    let mut host = Host::spawn(&folder, "main.js", &["--stop-grace-ms", "300"]);
    let started = Instant::now();
    host.send(&json!({ "event": "plugin.stopping", "time": 0, "data": {} }));
    let ended = host.end(WAIT);
    assert_eq!(ended.code, Some(77), "{}", ended.stderr);
    assert!(started.elapsed() >= Duration::from_millis(280), "{:?}", started.elapsed());
    assert!(started.elapsed() < Duration::from_millis(1500), "{:?}", started.elapsed());
    assert!(ended.stderr.contains("overstayed its stop grace"));
}

#[test]
fn a_line_over_32_mb_violates_the_channel() {
    let folder = scratch_plugin("violate", "__ardiaBridge.onLine(() => {});");
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let block = vec![b'x'; 1 << 20];
    for _ in 0..33 {
        if host.send_raw(&block).is_err() {
            break;
        }
    }
    let ended = host.end(WAIT);
    assert_eq!(ended.code, Some(75), "{}", ended.stderr);
    assert!(ended.stderr.contains("over 32 MB"));
}

#[test]
fn the_wall_clock_watchdog_ends_a_turn_the_cpu_check_would_still_allow() {
    let (code, stderr, took) = run("wall", "for (;;) {}", &["--turn-cpu-ms", "60000", "--minute-cpu-ms", "60000", "--turn-wall-ms", "300"]);
    assert_eq!(code, Some(78), "{stderr}");
    assert!(took < Duration::from_secs(3), "{took:?}");
}

#[test]
fn send_refusals_reach_the_plugin_as_errors() {
    let source = "const out = [];\nfor (const line of ['x'.repeat(1048576), 'a\\nb', 'a\\rb']) { try { __ardiaBridge.send(line); out.push('sent'); } catch (e) { out.push(e.message); } }\n__ardiaBridge.send(JSON.stringify(out));\n__ardiaBridge.send('x'.repeat(1048575));\n";
    let folder = scratch_plugin("refusals", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let refusals = host.expect(WAIT, "the refusals");
    assert_eq!(refusals, json!(["a line to Ardia is at most 1 MB", "a line to Ardia can't contain a newline", "a line to Ardia can't contain a newline"]));
    assert_eq!(host.line(WAIT).map(|line| line.len()), Some(1048575));
}

#[test]
fn ten_thousand_timers_is_the_cap() {
    let source = "let made = 0, problem = '';\ntry { for (let i = 0; i < 10001; i++) { setTimeout(() => {}, 100000); made++; } } catch (e) { problem = e.name + ': ' + e.message; }\n__ardiaBridge.send(JSON.stringify({ made, problem }));\n";
    let folder = scratch_plugin("timers-cap", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let report = host.expect(WAIT, "the timer report");
    assert_eq!(report["made"], 10000);
    assert_eq!(report["problem"], "RangeError: a plugin can have at most 10000 timers waiting");
}

#[test]
fn early_lines_wait_for_a_listener_and_cap_at_256() {
    let source = "setTimeout(() => { const got = []; __ardiaBridge.onLine((line) => got.push(line)); setTimeout(() => __ardiaBridge.send(JSON.stringify({ count: got.length, first: got[0], last: got[got.length - 1] })), 50); }, 300);";
    let folder = scratch_plugin("early", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    for n in 0..300 {
        host.send(&json!({ "n": n }));
    }
    let report = host.expect(WAIT, "the early-line report");
    assert_eq!(report["count"], 256);
    assert_eq!(report["first"], "{\"n\":0}");
    assert_eq!(report["last"], "{\"n\":255}");
}

#[test]
fn there_are_no_module_loaders_or_os_bindings() {
    let source = "const out = { require: typeof require, process: typeof process, std: typeof std, os: typeof os, scriptArgs: typeof scriptArgs, print: typeof print };\nimport('./main.js').then(() => { out.import = 'loaded'; }, (e) => { out.import = e.name; }).finally(() => __ardiaBridge.send(JSON.stringify(out)));\n";
    let folder = scratch_plugin("loaders", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let report = host.expect(WAIT, "the loader report");
    assert_eq!(report["require"], "undefined");
    assert_eq!(report["process"], "undefined");
    assert_eq!(report["std"], "undefined");
    assert_eq!(report["os"], "undefined");
    assert_eq!(report["scriptArgs"], "undefined");
    assert_eq!(report["print"], "undefined");
    assert_ne!(report["import"], "loaded");
}

#[test]
fn console_and_uncaught_errors_go_to_stderr_like_the_swift_host() {
    let source = "console.log('plain', 1, { a: [1] });\nconsole.warn('careful');\nconsole.error(new Error('boom'));\nsetTimeout(() => { throw new Error('late'); }, 0);\nsetTimeout(() => __ardiaBridge.send('done'), 30);\n";
    let folder = scratch_plugin("console", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    assert_eq!(host.line(WAIT).as_deref(), Some("done"));
    host.close();
    let ended = host.end(WAIT);
    assert!(ended.stderr.starts_with("plain 1 {\"a\":[1]}\n[warn] careful\n[error] Error: boom\n"), "{}", ended.stderr);
    assert!(ended.stderr.contains("[error] Uncaught Error: late"), "{}", ended.stderr);
}

#[test]
fn cancelled_long_timers_free_their_native_slots() {
    let source = "for (let i = 0; i < 30000; i++) clearTimeout(setTimeout(() => __ardiaBridge.send('fired'), 1e9));\nfor (let i = 0; i < 30000; i++) clearInterval(setInterval(() => __ardiaBridge.send('fired'), 1e9));\nconst live = [];\nfor (let i = 0; i < 10000; i++) live.push(setTimeout(() => {}, 1e9));\nlet refused = '';\ntry { setTimeout(() => __ardiaBridge.send('refused timer fired'), 0); } catch (e) { refused = e.name + ': ' + e.message; }\nclearTimeout(live.pop());\nconst again = typeof setTimeout(() => __ardiaBridge.send('replacement fired'), 10);\n__ardiaBridge.send(JSON.stringify({ refused, again }));\n";
    let folder = scratch_plugin("timers-cancel", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let report = host.expect(WAIT, "the cancel report");
    assert_eq!(report["refused"], "RangeError: a plugin can have at most 10000 timers waiting");
    assert_eq!(report["again"], "number");
    assert_eq!(host.line(WAIT).as_deref(), Some("replacement fired"));
    assert_eq!(host.line(Duration::from_millis(200)), None);
}

#[test]
fn clearing_an_interval_from_inside_its_callback_stops_it() {
    let source = "let ticks = 0;\nconst id = setInterval(() => { ticks++; if (ticks === 3) { clearInterval(id); setTimeout(() => __ardiaBridge.send(JSON.stringify({ ticks })), 50); } }, 5);\n";
    let folder = scratch_plugin("interval-self-clear", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    assert_eq!(host.expect(WAIT, "the tick count")["ticks"], 3);
}

#[test]
fn the_watchdog_exits_even_when_nobody_reads_stderr() {
    let folder = scratch_plugin("stderr-full-watchdog", "setTimeout(() => { console.log('x'.repeat(4095)); for (;;) console.log('y'); }, 100);");
    let mut host = Host::spawn(&folder, "main.js", &["--turn-wall-ms", "300", "--turn-cpu-ms", "60000", "--minute-cpu-ms", "60000"]);
    host.shrink_stderr_to_one_page();
    assert_eq!(host.wait_without_reading_stderr(Duration::from_secs(5)), Some(78));
}

#[test]
fn a_cpu_budget_exit_completes_with_a_full_stderr() {
    let folder = scratch_plugin("stderr-full-cpu", "setTimeout(() => { console.log('x'.repeat(4095)); for (;;) {} }, 100);");
    let mut host = Host::spawn(&folder, "main.js", &["--turn-cpu-ms", "200"]);
    host.shrink_stderr_to_one_page();
    assert_eq!(host.wait_without_reading_stderr(Duration::from_secs(5)), Some(72));
}

#[test]
fn a_shutdown_deadline_exit_completes_with_a_full_stderr() {
    let folder = scratch_plugin("stderr-full-stop", "__ardiaBridge.onLine(() => {});\nsetTimeout(() => { console.log('x'.repeat(4095)); __ardiaBridge.send('full'); }, 100);\nsetInterval(() => {}, 20);\n");
    let mut host = Host::spawn(&folder, "main.js", &["--stop-grace-ms", "300"]);
    host.shrink_stderr_to_one_page();
    assert_eq!(host.line(WAIT).as_deref(), Some("full"));
    host.send(&json!({ "event": "plugin.stopping", "time": 0, "data": {} }));
    assert_eq!(host.wait_without_reading_stderr(Duration::from_secs(5)), Some(77));
}

#[test]
fn a_line_over_32_mb_with_its_newline_in_the_same_write_violates_the_channel() {
    let folder = scratch_plugin("violate-newline", "__ardiaBridge.onLine((line) => __ardiaBridge.send('got ' + line.length));");
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let mut line = vec![b'x'; (32 << 20) + 1];
    line.extend_from_slice(b"\nsmall\n");
    let _ = host.send_raw(&line);
    let got = host.line(Duration::from_secs(5));
    assert_eq!(got, None, "the oversized line reached the plugin");
    let ended = host.end(WAIT);
    assert_eq!(ended.code, Some(75), "{}", ended.stderr);
}

#[test]
fn a_flood_of_small_lines_is_delivered_in_order_across_bounded_reads() {
    let folder = scratch_plugin("flood", "let n = 0;\n__ardiaBridge.onLine((line) => { if (Number(line) !== n) __ardiaBridge.send('out of order at ' + n); n++; if (n === 20000) __ardiaBridge.send('all ' + n); });");
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let text: String = (0..20000).map(|n| format!("{n}\n")).collect();
    host.send_raw(text.as_bytes()).unwrap();
    assert_eq!(host.line(WAIT).as_deref(), Some("all 20000"));
}

#[test]
fn fetches_at_the_timer_cap_reject_and_release_their_slots() {
    let source = "(async () => {\nconst live = [];\nfor (let i = 0; i < 10000; i++) live.push(setTimeout(() => {}, 1e9));\nconst first = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => fetch('https://example.com/' + i)));\nconst rejected = first.filter((r) => r.status === 'rejected').map((r) => r.reason.name + ': ' + r.reason.message);\nlet thrown = '';\ntry { setTimeout(() => {}, 1); } catch (e) { thrown = e.name; }\nfor (const id of live) clearTimeout(id);\nconst later = await Promise.all(Array.from({ length: 20 }, (_, i) => fetch('https://example.com/later/' + i).then((r) => r.text())));\n__ardiaBridge.send(JSON.stringify({ rejected, thrown, later }));\n})();\n";
    let folder = scratch_plugin("fetch-at-cap", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let mut fetched = Vec::new();
    let report = loop {
        let message = host.expect(WAIT, "a fetch or the report");
        if message["method"] == "net.fetch" {
            let url = message["params"]["url"].as_str().unwrap().to_string();
            host.send(&json!({ "id": message["id"], "result": { "ok": true, "status": 200, "statusText": "OK", "url": url, "headers": {}, "body": format!("body of {url}") } }));
            fetched.push(url);
            continue;
        }
        break message;
    };
    let rejected = report["rejected"].as_array().unwrap();
    assert_eq!(rejected.len(), 20, "{report}");
    assert!(rejected.iter().all(|r| r == "RangeError: a plugin can have at most 10000 timers waiting"), "{report}");
    assert_eq!(report["thrown"], "RangeError");
    assert_eq!(fetched.len(), 20, "no refused fetch reached Ardia: {fetched:?}");
    assert!(fetched.iter().all(|url| url.contains("/later/")), "{fetched:?}");
    let later = report["later"].as_array().unwrap();
    assert_eq!(later.len(), 20);
    assert_eq!(later[19], "body of https://example.com/later/19");
}

#[test]
fn clear_timer_coerces_its_argument_once() {
    let source = "let calls = 0;\nconst timeout = setTimeout(() => __ardiaBridge.send('timeout fired'), 20);\nconst interval = setInterval(() => __ardiaBridge.send('interval fired'), 20);\nclearTimeout({ valueOf() { calls++; return timeout; } });\nconst afterTimeout = calls;\nclearInterval({ valueOf() { calls++; return interval; } });\nsetTimeout(() => __ardiaBridge.send(JSON.stringify({ afterTimeout, calls })), 80);\n";
    let folder = scratch_plugin("coerce-once", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let report = host.expect(WAIT, "the coercion report");
    assert_eq!(report, json!({ "afterTimeout": 1, "calls": 2 }));
}

#[test]
fn a_plugin_that_spoofs_stack_and_string_methods_cannot_make_an_unrelated_send_fail() {
    let source = "const frame = '    at launch (ardia://plugin-host/prelude.js:1:1)';\nglobalThis.Error = function () { return { stack: frame }; };\nString.prototype.includes = () => true;\nString.prototype.split = function () { return [frame]; };\nString.prototype.trim = function () { return frame; };\nArray.prototype.filter = function () { return this; };\nRegExp.prototype.test = () => true;\nconst live = [];\nfor (let i = 0; i < 10000; i++) live.push(setTimeout(() => {}, 1e9));\nlet thrown = 'nothing';\ntry { setTimeout(() => {}, 1); } catch (e) { thrown = e instanceof RangeError ? 'RangeError' : 'other'; }\n__ardiaBridge.send('unrelated after a refused timer');\nfetch('https://example.com/x').then(() => 'resolved', (e) => (e instanceof RangeError ? 'RangeError' : 'other')).then((outcome) => {\n  __ardiaBridge.send('unrelated after a refused fetch');\n  __ardiaBridge.send(JSON.stringify({ thrown, outcome }));\n});\n";
    let folder = scratch_plugin("spoof", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    assert_eq!(host.line(WAIT).as_deref(), Some("unrelated after a refused timer"));
    assert_eq!(host.line(WAIT).as_deref(), Some("unrelated after a refused fetch"));
    assert_eq!(host.expect(WAIT, "the spoof report"), json!({ "thrown": "RangeError", "outcome": "RangeError" }));
    assert_eq!(host.line(Duration::from_millis(200)), None, "a refused fetch reached Ardia");
}

#[test]
fn abort_signal_timeout_at_the_cap_throws_and_leaves_nothing_behind() {
    let source = "const live = [];\nfor (let i = 0; i < 10000; i++) live.push(setTimeout(() => {}, 1e9));\nlet thrown = '';\ntry { AbortSignal.timeout(10); } catch (e) { thrown = e.name + ': ' + e.message; }\nclearTimeout(live.pop());\nconst signal = AbortSignal.timeout(10);\nsignal.addEventListener('abort', () => __ardiaBridge.send(JSON.stringify({ thrown, reason: signal.reason.name })));\n";
    let folder = scratch_plugin("abort-timeout-cap", source);
    let mut host = Host::spawn(&folder, "main.js", &[]);
    let report = host.expect(WAIT, "the abort report");
    assert_eq!(report["thrown"], "RangeError: a plugin can have at most 10000 timers waiting");
    assert_eq!(report["reason"], "TimeoutError");
}
