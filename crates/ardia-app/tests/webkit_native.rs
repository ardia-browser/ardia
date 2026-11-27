#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
fn main() {
    std::process::exit(macos::run());
}

#[cfg(target_os = "macos")]
mod macos {
    use std::collections::HashSet;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use ardia_app::webkit::page::{self, PageSpec};
    use ardia_app::webkit::page_events::PageEvent;
    use ardia_app::webkit::{WebKitEvent, content_rules, downloads};
    use ardia_state::TabId;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use serde_json::Value;

    type Seen = Arc<Mutex<Vec<(TabId, WebKitEvent)>>>;

    const INDEX: &str = r#"<!doctype html><html><head><title>Native test</title>
<link rel="icon" href="/icon.png">
</head><body>
<p>needle one needle two needle three</p>
<form action="/login" method="post"><input name="user" value="me"><input type="password" name="pass"></form>
<img src="/blocked-by-rules.png"><img src="/allowed.png">
<script>setTimeout(() => window.open("/popup"), 50);</script>
</body></html>"#;

    struct Server {
        port: u16,
        requests: Arc<Mutex<HashSet<String>>>,
    }

    fn respond(mut stream: TcpStream, requests: &Arc<Mutex<HashSet<String>>>) {
        let mut reader = BufReader::new(match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        });
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() {
            return;
        }
        let mut length = 0usize;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).unwrap_or(0) == 0 || header == "\r\n" {
                break;
            }
            if let Some(v) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
        let mut body = vec![0u8; length];
        let _ = reader.read_exact(&mut body);
        let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
        if let Ok(mut seen) = requests.lock() {
            seen.insert(path.clone());
        }
        let (status, kind, extra, content): (&str, &str, &str, Vec<u8>) = match path.as_str() {
            "/" | "/again" => ("200 OK", "text/html", "", INDEX.as_bytes().to_vec()),
            "/hsts" => (
                "200 OK",
                "text/html",
                "Strict-Transport-Security: max-age=60\r\n",
                b"<title>hsts</title>".to_vec(),
            ),
            "/download" => (
                "200 OK",
                "text/plain",
                "Content-Disposition: attachment; filename=\"native.txt\"\r\n",
                b"downloaded bytes".to_vec(),
            ),
            "/dialogs" => (
                "200 OK",
                "text/html",
                "",
                b"<title>dialogs</title><script>alert('a'); confirm('b'); prompt('c', 'd');</script>"
                    .to_vec(),
            ),
            "/media" => (
                "200 OK",
                "text/html",
                "",
                b"<title>media</title><audio id=a src=\"/silence.wav\" muted></audio>".to_vec(),
            ),
            _ => ("404 Not Found", "text/plain", "", b"missing".to_vec()),
        };
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n",
            content.len()
        );
        let _ = stream.write_all(head.as_bytes());
        let _ = stream.write_all(&content);
    }

    fn serve() -> Option<Server> {
        let listener = TcpListener::bind("127.0.0.1:0").ok()?;
        let port = listener.local_addr().ok()?.port();
        let requests = Arc::new(Mutex::new(HashSet::new()));
        let seen = requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let seen = seen.clone();
                std::thread::spawn(move || respond(stream, &seen));
            }
        });
        Some(Server { port, requests })
    }

    fn pump(slice: Duration) {
        unsafe {
            let run_loop: *mut AnyObject = msg_send![class!(NSRunLoop), currentRunLoop];
            let until: *mut AnyObject =
                msg_send![class!(NSDate), dateWithTimeIntervalSinceNow: slice.as_secs_f64()];
            let _: () = msg_send![run_loop, runUntilDate: until];
        }
    }

    fn wait(seconds: u64, mut done: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < deadline {
            if done() {
                return true;
            }
            pump(Duration::from_millis(20));
        }
        done()
    }

    fn any(seen: &Seen, test: impl Fn(&WebKitEvent) -> bool) -> bool {
        seen.lock()
            .is_ok_and(|events| events.iter().any(|(_, e)| test(e)))
    }

    fn deflate(text: &str) -> Vec<u8> {
        let mut encoder =
            flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        let _ = encoder.write_all(text.as_bytes());
        encoder.finish().unwrap_or_default()
    }

    fn rules(dir: &Path) -> PathBuf {
        let resources = dir.join("Resources");
        let folder = resources.join("ContentRules");
        let _ = std::fs::create_dir_all(&folder);
        let _ = std::fs::write(
            folder.join("rulesets.json"),
            r#"{"version":"native-test","digest":"nativetest","rulesets":[{"id":"native","enabled":true}]}"#,
        );
        let rule = r#"{"action":{"type":"block"},"trigger":{"url-filter":"blocked-by-rules"}}"#;
        let _ = std::fs::write(
            folder.join("native.rules"),
            deflate(&format!("b1\t{rule}\n")),
        );
        resources
    }

    struct Run {
        failures: Vec<String>,
        passed: usize,
    }

    impl Run {
        fn check(&mut self, name: &str, ok: bool) {
            if ok {
                self.passed += 1;
                eprintln!("ok   {name}");
            } else {
                eprintln!("FAIL {name}");
                self.failures.push(name.to_owned());
            }
        }
    }

    fn spec(tab: &TabId, url: String, seen: &Seen) -> PageSpec {
        let sink = seen.clone();
        PageSpec {
            tab: tab.clone(),
            profile: "native-test".into(),
            private: false,
            url,
            zoom: 1.0,
            muted: false,
            inspectable: false,
            sink: Arc::new(move |tab: TabId, event: WebKitEvent| {
                if let Ok(mut events) = sink.lock() {
                    events.push((tab, event));
                }
            }),
        }
    }

    fn titled<'a>(seen: &'a Seen, title: &'static str) -> impl FnMut() -> bool + 'a {
        move || {
            any(
                seen,
                |e| matches!(e, WebKitEvent::Navigation(n) if n.title == title && !n.loading),
            )
        }
    }

    pub fn run() -> i32 {
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let _: bool = msg_send![app, setActivationPolicy: 2isize];
        }
        let Some(server) = serve() else {
            eprintln!("no local server");
            return 1;
        };
        let scratch =
            std::env::temp_dir().join(format!("ardia-webkit-native-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&scratch);
        let _ = std::fs::create_dir_all(&scratch);
        let resources = rules(&scratch);
        content_rules::start(Some(&scratch), Some(resources));
        page::set_history_dir(Some(scratch.join("Chromium")));
        let reported: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let report_into = reported.clone();
        let folder = scratch.join("Downloads");
        let _ = std::fs::create_dir_all(&folder);
        let answer_folder = folder.clone();
        downloads::install(
            Arc::new(move |_profile, item| {
                if let Ok(mut items) = report_into.lock() {
                    items.push(item);
                }
            }),
            Arc::new(move |_profile, answer| answer(Some(answer_folder.clone()), false)),
        );

        let mut run = Run {
            failures: Vec::new(),
            passed: 0,
        };
        let base = format!("http://127.0.0.1:{}", server.port);
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let tab = TabId::new("native-tab");
        run.check(
            "open returns a page view",
            page::open(spec(&tab, format!("{base}/"), &seen)).is_some(),
        );
        run.check(
            "page loads and reports its title",
            wait(20, titled(&seen, "Native test")),
        );
        run.check(
            "page script reports icons",
            wait(5, || {
                any(
                    &seen,
                    |e| matches!(e, WebKitEvent::Icons(i) if !i.is_empty()),
                )
            }),
        );
        run.check(
            "content rules block the listed image",
            wait(5, || {
                server
                    .requests
                    .lock()
                    .is_ok_and(|r| r.contains("/allowed.png"))
            }) && !server
                .requests
                .lock()
                .is_ok_and(|r| r.contains("/blocked-by-rules.png")),
        );
        run.check(
            "a popup without a gesture is blocked",
            wait(5, || {
                any(&seen, |e| {
                    matches!(e, WebKitEvent::Page(PageEvent::PopupBlocked { .. }))
                })
            }),
        );

        let answer: Arc<Mutex<Option<Option<String>>>> = Arc::new(Mutex::new(None));
        let slot = answer.clone();
        page::evaluate(
            &tab,
            "post(\"result\", JSON.stringify(document.querySelectorAll(\"p\").length + 1))",
            Box::new(move |value| {
                if let Ok(mut slot) = slot.lock() {
                    *slot = Some(value);
                }
            }),
        );
        run.check(
            "evaluate returns through callAsyncJavaScript",
            wait(5, || {
                answer
                    .lock()
                    .is_ok_and(|a| a.as_ref().is_some_and(|v| v.as_deref() == Some("2")))
            }),
        );

        page::find(&tab, "needle", true);
        run.check(
            "find counts matches",
            wait(5, || {
                any(&seen, |e| matches!(e, WebKitEvent::FindMatches(Some(3), _)))
            }),
        );
        page::find(&tab, "needle", false);
        pump(Duration::from_millis(300));
        page::stop_finding(&tab);

        page::zoom_step(&tab, 1);
        run.check(
            "zoom step reports the new zoom",
            wait(3, || {
                any(
                    &seen,
                    |e| matches!(e, WebKitEvent::Zoom(z) if (*z - 1.1).abs() < 0.01),
                )
            }),
        );
        page::set_zoom(&tab, 1.0);
        page::set_muted(&tab, true);
        page::set_muted(&tab, false);
        page::set_visible(&tab, false);
        page::set_visible(&tab, true);
        page::focus(&tab);

        page::load(&tab, &format!("{base}/hsts"));
        run.check(
            "a page with an HSTS header loads",
            wait(10, titled(&seen, "hsts")),
        );

        page::load(&tab, &format!("{base}/dialogs"));
        run.check(
            "dialogs from a page outside any window are answered at once",
            wait(10, titled(&seen, "dialogs")),
        );

        page::load(&tab, &format!("{base}/download"));
        run.check(
            "an attachment becomes a finished download",
            wait(15, || {
                reported
                    .lock()
                    .is_ok_and(|items| items.iter().any(|i| i.to_string().contains("\"finished\"")))
            }),
        );
        run.check(
            "the download lands in the chosen folder",
            folder.join("native.txt").is_file(),
        );

        page::load(&tab, "http://127.0.0.1:1/");
        run.check(
            "an unreachable host shows the error page",
            wait(15, || {
                any(&seen, |e| {
                    matches!(e, WebKitEvent::Navigation(n) if n.url.starts_with("http://127.0.0.1:1") && !n.loading && !n.title.is_empty())
                })
            }),
        );

        page::load(&tab, &format!("{base}/again"));
        let _ = wait(10, || {
            seen.lock().is_ok_and(|events| {
                events.iter().rev().take(4).any(|(_, e)| {
                    matches!(e, WebKitEvent::Navigation(n) if n.url.ends_with("/again") && !n.loading)
                })
            })
        });
        page::go_back(&tab);
        pump(Duration::from_millis(500));
        page::go_forward(&tab);
        pump(Duration::from_millis(500));
        page::reload(&tab, false);
        pump(Duration::from_millis(500));
        page::reload(&tab, true);
        pump(Duration::from_millis(500));
        page::stop(&tab);

        page::flush_history();
        page::close(&tab);
        run.check("close releases the page", !page::has(&tab));
        let history = scratch.join("Chromium").join("WebKit Tab History");
        run.check(
            "history is saved on close",
            wait(5, || {
                std::fs::read_dir(&history)
                    .map(|dirs| {
                        dirs.flatten().any(|d| {
                            std::fs::read_dir(d.path()).is_ok_and(|mut f| f.next().is_some())
                        })
                    })
                    .unwrap_or(false)
            }),
        );
        let restored: Seen = Arc::new(Mutex::new(Vec::new()));
        run.check(
            "reopening restores the page",
            page::open(spec(&tab, format!("{base}/again"), &restored)).is_some()
                && wait(15, || {
                    any(
                        &restored,
                        |e| matches!(e, WebKitEvent::Navigation(n) if n.can_go_back),
                    )
                }),
        );
        page::close(&tab);

        let _ = std::fs::remove_dir_all(&scratch);
        eprintln!("{} passed, {} failed", run.passed, run.failures.len());
        if run.failures.is_empty() { 0 } else { 1 }
    }
}
