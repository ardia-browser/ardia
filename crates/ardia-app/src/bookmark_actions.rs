use ardia_state::bookmarks::{BookmarkNode, BookmarkTree, MAX_BOOKMARK_DEPTH};
use ardia_state::windows::ToastKind;
use ardia_state::{Action, ProfileId, TabId, WindowId};

use crate::coordinator::AppCoordinator;

pub const EXPORT_FILE_NAME: &str = "Ardia Bookmarks.html";
const BOOKMARKLET_PREFIX: &str = "javascript:";

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn seconds(ms: i64) -> i64 {
    ms.max(0) / 1000
}

fn write_folder(tree: &BookmarkTree, folder: &str, depth: usize, out: &mut String) {
    if depth > MAX_BOOKMARK_DEPTH {
        return;
    }
    let pad = "    ".repeat(depth);
    out.push_str(&format!("{pad}<DL><p>\n"));
    for child in tree.children(folder) {
        match tree.get(child.as_str()) {
            Some(BookmarkNode::Url {
                url,
                title,
                added_at,
                ..
            }) => out.push_str(&format!(
                "{pad}    <DT><A HREF=\"{}\" ADD_DATE=\"{}\">{}</A>\n",
                escape(url),
                seconds(*added_at),
                escape(title)
            )),
            Some(BookmarkNode::Folder {
                id,
                title,
                added_at,
                ..
            }) => {
                out.push_str(&format!(
                    "{pad}    <DT><H3 ADD_DATE=\"{}\" LAST_MODIFIED=\"0\">{}</H3>\n",
                    seconds(*added_at),
                    escape(title)
                ));
                write_folder(tree, id.as_str(), depth + 1, out);
            }
            None => {}
        }
    }
    out.push_str(&format!("{pad}</DL><p>\n"));
}

pub fn bookmarks_html(tree: &BookmarkTree) -> String {
    let mut out = String::from(
        "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n",
    );
    for (root, toolbar) in [(tree.bar(), true), (tree.other(), false)] {
        let Some(node) = tree.get(root.as_str()) else {
            continue;
        };
        out.push_str(&format!(
            "    <DT><H3 ADD_DATE=\"0\" LAST_MODIFIED=\"0\"{}>{}</H3>\n",
            if toolbar {
                " PERSONAL_TOOLBAR_FOLDER=\"true\""
            } else {
                ""
            },
            escape(node.title())
        ));
        write_folder(tree, root.as_str(), 1, &mut out);
    }
    out.push_str("</DL><p>\n");
    out
}

fn percent_decoded(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[at] == b'%'
            && at + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[at + 1]), hex(bytes[at + 2]))
        {
            out.push((high * 16 + low) as u8);
            at += 3;
            continue;
        }
        out.push(bytes[at]);
        at += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn bookmarklet_script(url: &str) -> Option<String> {
    let trimmed = url.trim();
    let body = trimmed
        .get(..BOOKMARKLET_PREFIX.len())
        .filter(|head| head.eq_ignore_ascii_case(BOOKMARKLET_PREFIX))
        .map(|_| &trimmed[BOOKMARKLET_PREFIX.len()..])?;
    let decoded = percent_decoded(body);
    (!decoded.trim().is_empty()).then_some(decoded)
}

impl AppCoordinator {
    pub fn run_bookmarklet_in(&self, tab: &TabId, url: &str) {
        let Some(script) = bookmarklet_script(url) else {
            return;
        };
        let web_page = self
            .store
            .snapshot()
            .tab(tab.as_str())
            .is_some_and(|listed| {
                listed.url.starts_with("http://")
                    || listed.url.starts_with("https://")
                    || listed.url == "about:blank"
            });
        if !web_page {
            ardia_telemetry::counts::count("bookmarklets_refused");
            return;
        }
        let (Some(engine), Some(engine_tab)) = (self.engine(), self.engine_tab(tab)) else {
            ardia_telemetry::counts::count("bookmarklets_refused");
            return;
        };
        ardia_telemetry::counts::count("bookmarklet_runs");
        let reply = engine.evaluate_js(engine_tab, &script);
        self.spawn(async move {
            if let Err(problem) = reply.await {
                log::debug!("a bookmarklet didn't run: {problem}");
            }
        });
    }

    pub fn export_bookmarks_of(&self, window: &WindowId, profile: &ProfileId) {
        let html = self
            .store
            .snapshot()
            .bookmarks_of(profile)
            .map(|tree| bookmarks_html(tree));
        let Some(html) = html else {
            return;
        };
        #[cfg(target_os = "macos")]
        {
            use ardia_engine::macos::dialogs::FilePanel;
            let consent = ardia_telemetry::consent_now();
            let chosen = FilePanel::save(EXPORT_FILE_NAME, &["html"]).show(None);
            let me = self.weak();
            let window = window.clone();
            self.spawn(async move {
                let Ok(paths) = chosen.await else {
                    return;
                };
                let Some(path) = paths.into_iter().next() else {
                    return;
                };
                let written = std::fs::write(&path, html.as_bytes());
                ardia_telemetry::counts::add_for(
                    consent.as_ref(),
                    if written.is_ok() {
                        "bookmark_html_exports"
                    } else {
                        "bookmark_html_export_failures"
                    },
                    1,
                );
                let Some(me) = me.upgrade() else {
                    return;
                };
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let reveal = format!(
                    "{}{}",
                    ardia_ui::popovers::toast::REVEAL_ACTION,
                    path.to_string_lossy()
                );
                let (kind, message, action, icon) = match written {
                    Ok(()) => (
                        ToastKind::Info,
                        format!("Bookmarks exported\n{name}"),
                        Some(reveal),
                        Some("book"),
                    ),
                    Err(problem) => (
                        ToastKind::Error,
                        format!("Couldn't export bookmarks\n{problem}"),
                        None,
                        None,
                    ),
                };
                me.notify_toast(&window, kind, message, action, icon);
            });
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (window, html);
            log::info!("exporting bookmarks isn't supported here yet");
        }
    }

    fn notify_toast(
        &self,
        window: &WindowId,
        kind: ToastKind,
        message: String,
        action: Option<String>,
        icon: Option<&str>,
    ) {
        let now = ardia_state::store::now_ms();
        let mut toast = ardia_ui::popovers::toast::toast(message, kind, action.as_deref(), now);
        toast.icon = icon.map(str::to_owned);
        self.dispatch_quietly(Action::PushToast {
            window: window.clone(),
            toast,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ardia_state::ids::IdGen;

    #[test]
    fn exports_read_as_netscape_bookmarks() {
        let ids = IdGen::with_launch("x");
        let mut tree = BookmarkTree::new("p", 0);
        let bar = tree.bar();
        let folder = tree
            .add_folder(&ids, &bar, None, "Work & Play", 2_000)
            .unwrap();
        tree.add_url(
            &ids,
            &folder,
            None,
            "A <b>",
            "https://a.example/?x=1&y=2",
            3_000,
        )
        .unwrap();
        let html = bookmarks_html(&tree);
        assert!(html.starts_with("<!DOCTYPE NETSCAPE-Bookmark-file-1>"));
        assert!(html.contains("PERSONAL_TOOLBAR_FOLDER=\"true\">Bookmarks Bar</H3>"));
        assert!(html.contains("<H3 ADD_DATE=\"2\" LAST_MODIFIED=\"0\">Work &amp; Play</H3>"));
        assert!(
            html.contains("HREF=\"https://a.example/?x=1&amp;y=2\" ADD_DATE=\"3\">A &lt;b&gt;</A>")
        );
    }

    #[test]
    fn bookmarklets_decode_their_script() {
        assert_eq!(
            bookmarklet_script("javascript:alert(%22hi%22)").as_deref(),
            Some("alert(\"hi\")")
        );
        assert_eq!(
            bookmarklet_script("JavaScript:void(0)").as_deref(),
            Some("void(0)")
        );
        assert_eq!(bookmarklet_script("javascript:  "), None);
        assert_eq!(bookmarklet_script("https://x/"), None);
    }
}
