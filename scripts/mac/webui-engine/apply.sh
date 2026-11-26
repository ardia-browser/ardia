#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  echo "usage: scripts/mac/webui-engine/apply.sh [--dev|--check|--paths|--revert]   copy //ardia/mac (the dev-only Mac WebUI shell) into CHROMIUM_SRC and hook it in; every hook compiles out of official builds; --dev also copies dev-copies.tsv, the inputs only non-official builds compile" >&2
  exit 0
fi
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
src=${CHROMIUM_SRC:-$HOME/chromium-build/chromium_git/chromium/src}
owned=(ardia/mac)
mode=${1:-apply}

read -r -d '' edits <<'PY' || true
import re
import sys
mode, src = sys.argv[1:3]
DEV = "#if !defined(OFFICIAL_BUILD)\n"
MAC_DEV = "#if BUILDFLAG(IS_MAC) && !defined(OFFICIAL_BUILD)\n"
HOOKS_INCLUDE = '#include "ardia/mac/ac_mac_hooks.h"  // nogncheck\n'
PAGE_MENU_OBSERVER = ("RenderViewContextMenuObserver* (*g_ardia_mac_page_menu_observer)(\n"
                      "    RenderViewContextMenuBase* menu,\n    ui::SimpleMenuModel* model) = nullptr;\n")
PAGE_MENU_DECLARATIONS = ("\n" + MAC_DEV + HOOKS_INCLUDE + "\n" + PAGE_MENU_OBSERVER +
                          "void (*g_ardia_mac_page_menu_destroyed)(RenderViewContextMenuBase* menu) = nullptr;\n#endif\n")
SUPERSEDED = {
    PAGE_MENU_DECLARATIONS: ("\n" + MAC_DEV + HOOKS_INCLUDE + "\n" + PAGE_MENU_OBSERVER + "#endif\n",),
}
HOOKS = [
    ("chrome/BUILD.gn",
     '      "//ardia/core",  # Ardia: ArdiaCore (engine/ardiacore)\n',
     '      "//ardia/mac",\n',
     "after"),
    ("chrome/browser/chrome_browser_main.cc",
     '#include "build/build_config.h"\n',
     MAC_DEV + '#include "ardia/mac/ac_mac_webui.h"  // nogncheck\n#endif\n',
     "after"),
    ("chrome/browser/chrome_browser_main.cc",
     '  TRACE_EVENT0("startup", "ChromeBrowserMainParts::PostBrowserStart");\n',
     MAC_DEV + '  if (ardia_mac::WebUIShellRequested()) {\n    ardia_mac::StartWebUIShell();\n  }\n#endif\n',
     "after"),
    ("content/app_shim_remote_cocoa/web_contents_view_cocoa.mm",
     "@implementation WebContentsViewCocoa {\n",
     DEV + HOOKS_INCLUDE + "\nbool (*g_ardia_mac_shell_passes_point)(NSView* view, NSPoint point) = nullptr;\n#endif\n\n",
     "before"),
    ("content/app_shim_remote_cocoa/web_contents_view_cocoa.mm",
     "- (void)dealloc {\n",
     DEV + "- (NSView*)hitTest:(NSPoint)point {\n  if (g_ardia_mac_shell_passes_point &&\n"
     "      g_ardia_mac_shell_passes_point(self, point)) {\n    return nil;\n  }\n  return [super hitTest:point];\n}\n#endif\n\n",
     "before"),
    ("chrome/browser/ui/window_feature_controller/window_feature_controller.cc",
     '#include "chrome/browser/ui/web_applications/app_browser_controller.h"\n',
     "\n" + MAC_DEV + HOOKS_INCLUDE + "\nbool g_ardia_mac_hosts_normal_windows = false;\n#endif\n",
     "after"),
    ("chrome/browser/ui/window_feature_controller/window_feature_controller.cc",
     "bool WindowFeatureController::SupportsWindowFeatureImpl(\n    WindowFeature feature,\n"
     "    bool check_can_support) const {\n",
     MAC_DEV + "  if (g_ardia_mac_hosts_normal_windows &&\n"
     "      browser_type_ == BrowserWindowInterface::Type::TYPE_NORMAL) {\n    return false;\n  }\n#endif\n",
     "after"),
    ("chrome/browser/ui/views/frame/browser_frame_view_mac.mm",
     '#include "chrome/browser/ui/views/frame/browser_frame_view_mac.h"\n',
     "\n" + DEV + HOOKS_INCLUDE + "#endif\n",
     "after"),
    ("chrome/browser/ui/views/frame/browser_frame_view_mac.mm",
     "void BrowserFrameViewMac::OnPaint(gfx::Canvas* canvas) {\n",
     DEV + "  if (g_ardia_mac_hosts_normal_windows &&\n      GetBrowserView()->GetIsNormalType()) {\n"
     "    return;\n  }\n#endif\n",
     "after"),
    ("components/renderer_context_menu/render_view_context_menu_base.cc",
     '#include "url/origin.h"\n',
     PAGE_MENU_DECLARATIONS,
     "after",
     r"\(\s*\*\s*g_ardia_mac_page_menu_observer\s*\)\s*\("),
    ("components/renderer_context_menu/render_view_context_menu_base.cc",
     "  InitMenu();\n",
     MAC_DEV + "  if (g_ardia_mac_page_menu_observer) {\n    if (RenderViewContextMenuObserver* observer =\n"
     "            g_ardia_mac_page_menu_observer(this, &menu_model_)) {\n      observers_.AddObserver(observer);\n"
     "    }\n  }\n#endif\n",
     "after",
     r"if\s*\(\s*g_ardia_mac_page_menu_observer\s*\)"),
    ("components/renderer_context_menu/render_view_context_menu_base.cc",
     "RenderViewContextMenuBase::~RenderViewContextMenuBase() {\n",
     MAC_DEV + "  if (g_ardia_mac_page_menu_destroyed) {\n    g_ardia_mac_page_menu_destroyed(this);\n  }\n#endif\n",
     "after",
     r"if\s*\(\s*g_ardia_mac_page_menu_destroyed\s*\)"),
    ("chrome/browser/ui/views/overlay/video_overlay_window_views.cc",
     "std::unique_ptr<content::VideoOverlayWindow> CreateVideoOverlayWindow(\n"
     "    content::VideoPictureInPictureWindowController* controller) {\n",
     MAC_DEV + "std::unique_ptr<content::VideoOverlayWindow> (*g_ardia_mac_video_overlay)(\n"
     "    content::VideoPictureInPictureWindowController* controller) = nullptr;\n#endif\n\n",
     "before",
     r"\(\s*\*\s*g_ardia_mac_video_overlay\s*\)\s*\("),
    ("chrome/browser/ui/views/overlay/video_overlay_window_views.cc",
     "std::unique_ptr<content::VideoOverlayWindow> CreateVideoOverlayWindow(\n"
     "    content::VideoPictureInPictureWindowController* controller) {\n",
     MAC_DEV + "  if (g_ardia_mac_video_overlay) {\n    if (auto overlay = g_ardia_mac_video_overlay(controller)) {\n"
     "      return overlay;\n    }\n  }\n#endif\n",
     "after",
     r"if\s*\(\s*g_ardia_mac_video_overlay\s*\)"),
    ("chrome/browser/chrome_content_browser_client_navigation_throttles.cc",
     "void CreateAndAddChromeThrottlesForNavigation(\n",
     MAC_DEV + "void (*g_ardia_mac_add_navigation_throttles)(\n"
     "    content::NavigationThrottleRegistry& registry) = nullptr;\n#endif\n\n",
     "before",
     r"\(\s*\*\s*g_ardia_mac_add_navigation_throttles\s*\)\s*\("),
    ("chrome/browser/chrome_content_browser_client_navigation_throttles.cc",
     "    page_load_metrics::MetricsNavigationThrottle::CreateAndAdd(registry);\n",
     MAC_DEV + "    if (g_ardia_mac_add_navigation_throttles) {\n"
     "      g_ardia_mac_add_navigation_throttles(registry);\n    }\n#endif\n",
     "after",
     r"if\s*\(\s*g_ardia_mac_add_navigation_throttles\s*\)"),
    ("content/browser/renderer_host/render_frame_host_impl.cc",
     "void RenderFrameHostImpl::DownloadURL(\n",
     MAC_DEV + "namespace {\nbool (*g_ardia_mac_download_url)(RenderFrameHost* frame,\n"
     "                                 const GURL& url,\n"
     "                                 bool follows_redirects,\n"
     "                                 bool names_file,\n"
     "                                 bool user_gesture) = nullptr;\n}\n\n"
     "CONTENT_EXPORT void SetArdiaMacDownloadUrlHook(\n"
     "    bool (*hook)(RenderFrameHost*, const GURL&, bool, bool, bool));\n\n"
     "void SetArdiaMacDownloadUrlHook(\n"
     "    bool (*hook)(RenderFrameHost*, const GURL&, bool, bool, bool)) {\n"
     "  g_ardia_mac_download_url = hook;\n}\n#endif\n\n",
     "before",
     r"\bSetArdiaMacDownloadUrlHook\s*\(|\(\s*\*\s*g_ardia_mac_download_url\s*\)\s*\("),
    ("content/browser/renderer_host/render_frame_host_impl.cc",
     "  std::unique_ptr<download::DownloadUrlParameters> parameters =\n"
     "      CreateDownloadUrlParameters(blink_parameters->url, traffic_annotation);\n",
     MAC_DEV + "  if (g_ardia_mac_download_url &&\n"
     "      g_ardia_mac_download_url(\n"
     "          this, blink_parameters->url,\n"
     "          blink_parameters->cross_origin_redirects ==\n"
     "              network::mojom::RedirectMode::kFollow,\n"
     "          blink_parameters->suggested_name.has_value(),\n"
     "          blink_parameters->has_user_gesture)) {\n"
     "    return;\n  }\n#endif\n",
     "before",
     r"if\s*\(\s*g_ardia_mac_download_url\s*&&"),
    ("content/browser/web_contents/web_contents_impl.cc",
     "FrameTree* WebContentsImpl::CreateNewWindow(\n",
     MAC_DEV + "namespace {\nbool (*g_ardia_mac_new_window_in_place)(WebContents* source,\n"
     "                                        const GURL& url,\n"
     "                                        WindowOpenDisposition disposition,\n"
     "                                        bool form_submission,\n"
     "                                        bool user_gesture) = nullptr;\n}\n\n"
     "CONTENT_EXPORT void SetArdiaMacNewWindowInPlaceHook(\n"
     "    bool (*hook)(WebContents*, const GURL&, WindowOpenDisposition, bool, bool));\n\n"
     "void SetArdiaMacNewWindowInPlaceHook(\n"
     "    bool (*hook)(WebContents*, const GURL&, WindowOpenDisposition, bool, bool)) {\n"
     "  g_ardia_mac_new_window_in_place = hook;\n}\n#endif\n\n",
     "before",
     r"\bSetArdiaMacNewWindowInPlaceHook\s*\("),
    ("content/browser/web_contents/web_contents_impl.cc",
     "  content::ChildProcessId render_process_id = opener->GetProcess()->GetID();\n",
     MAC_DEV + "  if (params.opener_suppressed && g_ardia_mac_new_window_in_place &&\n"
     "      g_ardia_mac_new_window_in_place(\n"
     "          this, params.target_url, params.disposition,\n"
     "          params.is_form_submission || params.form_submission_post_data,\n"
     "          has_user_gesture)) {\n"
     "    return nullptr;\n  }\n#endif\n",
     "before",
     r"if\s*\(\s*(?:params\.opener_suppressed\s*&&\s*)?g_ardia_mac_new_window_in_place\s*&&"),
    ("third_party/blink/renderer/core/html/html_anchor_element.cc",
     "  NavigationPolicy navigation_policy = NavigationPolicyFromEvent(&event);\n",
     DEV + "  if (navigation_policy == kNavigationPolicyDownload &&\n"
     "      FastHasAttribute(html_names::kDownloadAttr)) {\n"
     "    request.SetSuggestedFilename(\n"
     "        static_cast<String>(FastGetAttribute(html_names::kDownloadAttr)));\n"
     "  }\n#endif\n",
     "after",
     r"navigation_policy\s*==\s*kNavigationPolicyDownload\s*&&\s*FastHasAttribute"),
]


GUARD = re.compile(r"^[ \t]*#[ \t]*if[ \t]+(?:BUILDFLAG[ \t]*\([ \t]*IS_MAC[ \t]*\)[ \t]*&&[ \t]*)?"
                   r"![ \t]*defined[ \t]*\(?[ \t]*OFFICIAL_BUILD[ \t]*\)?[ \t]*$", re.M)
OPENS = re.compile(r"[ \t]*#[ \t]*if")
CLOSES = re.compile(r"[ \t]*#[ \t]*endif\b")


def blocks(s, identity, text):
    spans = []
    for opening in GUARD.finditer(s):
        depth, at, end = 1, opening.end() + 1, None
        while at <= len(s):
            stop = s.find("\n", at)
            line = s[at:stop if stop != -1 else len(s)]
            if CLOSES.match(line):
                depth -= 1
                if depth == 0:
                    end = stop + 1 if stop != -1 else len(s)
                    break
            elif OPENS.match(line):
                depth += 1
            if stop == -1:
                break
            at = stop + 1
        if end is not None and re.search(identity, s[opening.start():end]):
            spans.append((opening.start(), end))
    innermost = [span for span in spans
                 if not any(other != span and span[0] <= other[0] and other[1] <= span[1] for other in spans)]
    found = []
    for start, end in innermost:
        if text.startswith("\n") and start > 0 and s[start - 1] == "\n":
            start -= 1
        if text.endswith("\n\n") and s[end:end + 1] == "\n":
            end += 1
        found.append(s[start:end])
    return found


failed = False
pending = {}
for hook in HOOKS:
    path, anchor, text, where = hook[:4]
    identity = hook[4] if len(hook) > 4 else None
    full = f"{src}/{path}"
    s = pending.get(full)
    if s is None:
        try:
            s = open(full).read()
        except FileNotFoundError:
            if mode == "--revert":
                continue
            sys.exit(f"apply.sh: {path} is not in {src}")
    copies = s.count(text)
    stale = [earlier for earlier in SUPERSEDED.get(text, ()) if earlier in s]
    if identity:
        variants = [block for block in blocks(s, identity, text) if block != text and text not in block and block not in text]
        stale += [block for block in dict.fromkeys(variants) if block not in stale]
    if mode == "--check":
        if copies != 1 or stale:
            problem = "an earlier shape of" if stale else ("a duplicate" if copies > 1 else "missing")
            print(f"apply.sh --check: {problem} hook in {path}: {text.strip().splitlines()[0]}", file=sys.stderr)
            failed = True
        continue
    shapes = [text, *stale]
    if mode == "--revert":
        for shape in shapes:
            s = s.replace(shape, "")
    elif copies == 1 and not stale:
        pass
    elif copies or stale:
        for shape in shapes:
            s = s.replace(shape, "")
        if s.count(anchor) != 1:
            sys.exit(f"apply.sh: anchor not found once in {path}: {anchor.strip()!r}")
        s = s.replace(anchor, anchor + text if where == "after" else text + anchor, 1)
    else:
        if s.count(anchor) != 1:
            sys.exit(f"apply.sh: anchor not found once in {path}: {anchor.strip()!r}")
        s = s.replace(anchor, anchor + text if where == "after" else text + anchor, 1)
    pending[full] = s
for full, s in pending.items():
    if open(full).read() != s:
        open(full, "w").write(s)
        print(("unhooked " if mode == "--revert" else "hooked ") + full[len(src) + 1:])
sys.exit(1 if failed else 0)
PY

copy_in() {
  while IFS=$'\t' read -r source target; do
    [[ -n "$source" ]] || continue
    mkdir -p "$(dirname "$src/$target")"
    cp "$repo/$source" "$src/$target"
  done <"$here/dev-copies.tsv"
}

copied_names() {
  while IFS=$'\t' read -r source target; do
    [[ -n "$source" ]] && printf '%s\n' "${target#ardia/mac/}"
  done <"$here/dev-copies.tsv"
}

case "$mode" in
  apply | --dev)
    [[ -d "$src" ]] || { echo "apply.sh: no Chromium tree at $src" >&2; exit 1; }
    python3 -c "$edits" apply "$src"
    mkdir -p "$src/ardia/mac"
    rsync -r --checksum "$here/src/ardia/mac/" "$src/ardia/mac/"
    if [[ "$mode" == --dev ]]; then copy_in; fi
    ;;
  --paths)
    printf '%s/\n' "${owned[@]}"
    printf '%s\n' chrome/BUILD.gn chrome/browser/chrome_browser_main.cc \
      content/app_shim_remote_cocoa/web_contents_view_cocoa.mm \
      chrome/browser/ui/window_feature_controller/window_feature_controller.cc \
      chrome/browser/ui/views/frame/browser_frame_view_mac.mm \
      components/renderer_context_menu/render_view_context_menu_base.cc \
      chrome/browser/ui/views/overlay/video_overlay_window_views.cc \
      chrome/browser/chrome_content_browser_client_navigation_throttles.cc \
      content/browser/renderer_host/render_frame_host_impl.cc \
      content/browser/web_contents/web_contents_impl.cc \
      third_party/blink/renderer/core/html/html_anchor_element.cc
    ;;
  --check)
    excludes=()
    while IFS= read -r name; do excludes+=(-x "${name%%/*}"); done < <(copied_names)
    diff -r "${excludes[@]}" "$here/src/ardia/mac" "$src/ardia/mac" >/dev/null 2>&1 || { echo "apply.sh --check: $src/ardia/mac differs from the repo" >&2; exit 1; }
    python3 -c "$edits" --check "$src"
    ;;
  --revert)
    python3 -c "$edits" --revert "$src"
    rm -rf "$src/ardia/mac"
    rmdir "$src/ardia" 2>/dev/null || true
    ;;
  *) echo "usage: $0 [--dev|--check|--paths|--revert]" >&2; exit 64 ;;
esac
