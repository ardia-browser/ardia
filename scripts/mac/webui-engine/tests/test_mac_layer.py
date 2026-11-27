#!/usr/bin/env python3
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[2]
SOURCE = ROOT / 'src'
MAC = SOURCE / 'ardia/mac'
TESTS = ROOT / 'tests'
CXX = os.environ.get('CXX') or shutil.which('clang++') or shutil.which('c++') or 'c++'


def compiler_flags():
    version = subprocess.run([CXX, '--version'], capture_output=True, text=True).stdout
    flags = ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-Wconversion', '-g',
             '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-fno-sanitize-recover=all']
    if 'clang' in version:
        flags.append('-Wshorten-64-to-32')
    return flags


FLAGS = compiler_flags()
HOOKED_FILES = (
    'chrome/BUILD.gn',
    'chrome/browser/chrome_browser_main.cc',
    'content/app_shim_remote_cocoa/web_contents_view_cocoa.mm',
    'chrome/browser/ui/window_feature_controller/window_feature_controller.cc',
    'chrome/browser/ui/views/frame/browser_frame_view_mac.mm',
    'components/renderer_context_menu/render_view_context_menu_base.cc',
    'chrome/browser/ui/views/overlay/video_overlay_window_views.cc',
    'chrome/browser/chrome_content_browser_client_navigation_throttles.cc',
    'content/browser/renderer_host/render_frame_host_impl.cc',
    'content/browser/web_contents/web_contents_impl.cc',
    'third_party/blink/renderer/core/html/html_anchor_element.cc',
)


def compile_and_run(test, source, binary, defines=(), env=None):
    built = subprocess.run([CXX, *FLAGS, *defines, '-I', str(SOURCE), '-I', str(TESTS), '-I', str(ROOT / 'launcher'),
                            str(source), '-o', str(binary)],
                           capture_output=True, text=True, timeout=180)
    test.assertEqual(built.returncode, 0, built.stderr)
    ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=30,
                         env={**os.environ, 'UBSAN_OPTIONS': 'halt_on_error=1:print_stacktrace=1',
                              'ASAN_OPTIONS': 'detect_leaks=0', **(env or {})})
    test.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
    test.assertNotIn('FAIL', ran.stdout)
    return ran.stdout


class PureHeaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='ardia-mac-layer-')
        cls.out = pathlib.Path(cls.directory.name)

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def test_backdrop_theme(self):
        compile_and_run(self, TESTS / 'backdrop_theme_test.cc', self.out / 'backdrop-theme')

    def test_glass_layout(self):
        compile_and_run(self, TESTS / 'glass_layout_test.cc', self.out / 'glass')

    def test_popover_policy(self):
        compile_and_run(self, TESTS / 'popover_policy_test.cc', self.out / 'popover')

    def test_menu_and_window_layout(self):
        compile_and_run(self, TESTS / 'menu_window_test.cc', self.out / 'menu')

    def test_shell_policy(self):
        compile_and_run(self, TESTS / 'shell_policy_test.cc', self.out / 'shell-policy')

    def test_share_policy(self):
        compile_and_run(self, TESTS / 'share_policy_test.cc', self.out / 'share-policy')

    def test_shared_folders_policy(self):
        compile_and_run(self, TESTS / 'shared_folders_policy_test.cc', self.out / 'shared-folders-policy')

    def test_system_policy(self):
        compile_and_run(self, TESTS / 'system_policy_test.cc', self.out / 'system-policy')

    def test_extension_view_policy(self):
        compile_and_run(self, TESTS / 'extension_view_policy_test.cc', self.out / 'extension-view-policy')

    def test_link_policy(self):
        compile_and_run(self, TESTS / 'link_policy_test.cc', self.out / 'link-policy')

    def test_swipe_policy(self):
        compile_and_run(self, TESTS / 'swipe_policy_test.cc', self.out / 'swipe-policy')

    def test_pip_policy(self):
        compile_and_run(self, TESTS / 'pip_policy_test.cc', self.out / 'pip-policy')

    def test_dialog_policy(self):
        compile_and_run(self, TESTS / 'dialog_policy_test.cc', self.out / 'dialog-policy')

    def test_window_policy(self):
        compile_and_run(self, TESTS / 'window_policy_test.cc', self.out / 'window-policy')

    def test_page_policy(self):
        scripts = self.out / 'evaluation-scripts.txt'
        compile_and_run(self, TESTS / 'page_policy_test.cc', self.out / 'page-policy',
                        env={'ARDIA_EVALUATION_SCRIPTS': str(scripts)})
        node = shutil.which('node')
        if node is None:
            self.skipTest('node is unavailable to run the awaited evaluation scripts')
        ran = subprocess.run([node, str(TESTS / 'awaited-evaluation.mjs'), str(scripts)],
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        self.assertIn('awaited evaluation ok', ran.stdout)

    def test_shared_hostile_corpus_reaches_no_sink(self):
        node = shutil.which('node')
        if node is None:
            self.skipTest('node is unavailable to export scripts/security/hostile-inputs.mjs')
        corpus = self.out / 'corpus.txt'
        exported = subprocess.run([node, str(TESTS / 'hostile-corpus.mjs'), str(corpus)],
                                  capture_output=True, text=True, timeout=60)
        self.assertEqual(exported.returncode, 0, exported.stderr)
        compile_and_run(self, TESTS / 'hostile_corpus_test.cc', self.out / 'hostile-corpus',
                        env={'ARDIA_HOSTILE_CORPUS': str(corpus)})

    def test_launcher_arguments(self):
        compile_and_run(self, TESTS / 'launch_args_test.cc', self.out / 'launcher')

    def test_webui_policy_without_defines_is_release(self):
        compile_and_run(self, TESTS / 'webui_policy_test.cc', self.out / 'policy-release')

    def test_webui_policy_in_a_development_build(self):
        compile_and_run(self, TESTS / 'webui_policy_test.cc', self.out / 'policy-dev',
                        ['-DARDIA_MAC_WEBUI_DEV', '-DEXPECT_DEVELOPMENT'])

    def test_webui_policy_official_build_wins_over_the_dev_define(self):
        compile_and_run(self, TESTS / 'webui_policy_test.cc', self.out / 'policy-official',
                        ['-DARDIA_MAC_WEBUI_DEV', '-DOFFICIAL_BUILD'])

    def test_webui_policy_release_define_wins_over_the_dev_define(self):
        compile_and_run(self, TESTS / 'webui_policy_test.cc', self.out / 'policy-forced-release',
                        ['-DARDIA_MAC_WEBUI_DEV', '-DARDIA_MAC_WEBUI_RELEASE'])


class BuildGraphTests(unittest.TestCase):
    def setUp(self):
        self.gn = (MAC / 'BUILD.gn').read_text()

    def test_official_builds_compile_only_the_inert_stub(self):
        self.assertIn('if (is_official_build) {', self.gn)
        official = self.gn.split('if (is_official_build) {', 1)[1].split('} else {', 1)[0]
        self.assertIn('"ac_mac_webui_release.mm"', official)
        for heavy in ('ac_mac_shell_host.mm', 'ac_mac_glass.mm', 'ac_mac_popover.mm', 'ac_mac_menu.mm',
                      'ac_mac_webui.mm', 'ac_mac_window.mm', 'ac_mac_dialog.mm', 'ac_mac_shell_lifecycle.mm',
                      'ac_mac_window_events.mm', 'ac_mac_page_commands.mm', 'ac_mac_page_events.mm',
                      'ac_mac_page_delegate.mm', 'ac_mac_system.mm', 'ac_mac_extension_view.mm', 'ac_mac_pip.mm'):
            self.assertNotIn(heavy, official)

    def test_only_development_builds_define_the_dev_macro(self):
        self.assertEqual(self.gn.count('ARDIA_MAC_WEBUI_DEV'), 1)
        development = self.gn.split('} else {', 1)[1]
        self.assertIn('ARDIA_MAC_WEBUI_DEV', development)

    def test_every_listed_source_exists(self):
        copied = {line.split('\t')[1] for line in (ROOT / 'dev-copies.tsv').read_text().splitlines() if line}
        for name in re.findall(r'"([A-Za-z0-9_./]+\.(?:h|mm|cc))"', self.gn):
            if name.startswith('generated/') or name.startswith('shared/'):
                self.assertIn(f'ardia/mac/{name}', copied, name)
                continue
            self.assertTrue((MAC / name).is_file(), name)

    def test_release_stub_never_starts_the_shell(self):
        stub = (MAC / 'ac_mac_webui_release.mm').read_text()
        self.assertIn('return false;', stub)
        self.assertNotIn('StartWebUIShellImpl', stub)
        self.assertNotIn('AddWebUIConfig', stub)

    def test_development_entry_asks_the_policy(self):
        entry = (MAC / 'ac_mac_webui.mm').read_text()
        self.assertIn('webui_policy::Decide(', entry)
        self.assertIn('webui_policy::CompiledBuild()', entry)
        self.assertRegex(entry, r'if \(!WebUIShellRequested\(\)\) \{\n\s+return;')


class ApplyTests(unittest.TestCase):
    def fake_tree(self, root):
        files = {
            'chrome/BUILD.gn': '  deps = [\n      "//ardia/core",  # Ardia: ArdiaCore (engine/ardiacore)\n  ]\n',
            'chrome/browser/chrome_browser_main.cc':
                '#include "build/build_config.h"\nvoid F() {\n'
                '  TRACE_EVENT0("startup", "ChromeBrowserMainParts::PostBrowserStart");\n}\n',
            'content/app_shim_remote_cocoa/web_contents_view_cocoa.mm':
                '@implementation WebContentsViewCocoa {\n  int x;\n}\n- (void)dealloc {\n}\n@end\n',
            'chrome/browser/ui/window_feature_controller/window_feature_controller.cc':
                '#include "build/build_config.h"\n'
                '#include "chrome/browser/ui/web_applications/app_browser_controller.h"\n\n'
                'bool WindowFeatureController::SupportsWindowFeatureImpl(\n'
                '    WindowFeature feature,\n    bool check_can_support) const {\n'
                '  switch (browser_type_) {\n  }\n}\n',
            'chrome/browser/ui/views/frame/browser_frame_view_mac.mm':
                '#include "chrome/browser/ui/views/frame/browser_frame_view_mac.h"\n\n'
                'void BrowserFrameViewMac::OnPaint(gfx::Canvas* canvas) {\n'
                '  if (!GetBrowserView()->GetIsNormalType() &&\n'
                '      !GetBrowserView()->GetIsWebAppType()) {\n    return;\n  }\n}\n',
            'content/browser/renderer_host/render_frame_host_impl.cc':
                '#include "build/build_config.h"\n\nnamespace content {\n\n'
                'void RenderFrameHostImpl::DownloadURL(\n'
                '    blink::mojom::DownloadURLParamsPtr blink_parameters) {\n'
                '  std::unique_ptr<download::DownloadUrlParameters> parameters =\n'
                '      CreateDownloadUrlParameters(blink_parameters->url, traffic_annotation);\n'
                '  StartDownload(std::move(parameters), nullptr);\n}\n\n}\n',
            'content/browser/web_contents/web_contents_impl.cc':
                '#include "build/build_config.h"\n\nnamespace content {\n\n'
                'FrameTree* WebContentsImpl::CreateNewWindow(\n'
                '    RenderFrameHostImpl* opener, const mojom::CreateNewWindowParams& params) {\n'
                '  content::ChildProcessId render_process_id = opener->GetProcess()->GetID();\n'
                '  if (!params.opener_suppressed) {\n    return nullptr;\n  }\n\n'
                '  bool was_blocked = false;\n'
                '  base::WeakPtr<WebContentsImpl> weak_new_contents =\n'
                '      new_contents_impl->weak_factory_.GetWeakPtr();\n  return nullptr;\n}\n\n}\n',
            'third_party/blink/renderer/core/html/html_anchor_element.cc':
                '#include "third_party/blink/renderer/core/html/html_anchor_element.h"\n\n'
                'void HTMLAnchorElementBase::HandleClick(MouseEvent& event) {\n'
                '  ResourceRequest request(completed_url);\n'
                '  NavigationPolicy navigation_policy = NavigationPolicyFromEvent(&event);\n\n'
                '  if (FastHasAttribute(html_names::kDownloadAttr)) {\n  }\n}\n',
            'chrome/browser/chrome_content_browser_client_navigation_throttles.cc':
                '#include "build/build_config.h"\n\n}\n\n'
                'void CreateAndAddChromeThrottlesForNavigation(\n'
                '    content::NavigationThrottleRegistry& registry) {\n'
                '  if (handle.IsInMainFrame()) {\n'
                '    page_load_metrics::MetricsNavigationThrottle::CreateAndAdd(registry);\n  }\n}\n',
            'components/renderer_context_menu/render_view_context_menu_base.cc':
                '#include "build/build_config.h"\n#include "url/origin.h"\n\n'
                'RenderViewContextMenuBase::~RenderViewContextMenuBase() {\n}\n\n'
                'void RenderViewContextMenuBase::Init() {\n  InitMenu();\n  if (toolkit_delegate_)\n'
                '    toolkit_delegate_->Init(&menu_model_);\n}\n',
            'chrome/browser/ui/views/overlay/video_overlay_window_views.cc':
                '#include "build/build_config.h"\n\n'
                'std::unique_ptr<content::VideoOverlayWindow> CreateVideoOverlayWindow(\n'
                '    content::VideoPictureInPictureWindowController* controller) {\n'
                '  return VideoOverlayWindowViews::Create(controller);\n}\n',
        }
        originals = {}
        for path, text in files.items():
            full = root / path
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(text)
            originals[path] = text
        return originals

    def run_apply(self, root, *args):
        return subprocess.run([str(ROOT / 'apply.sh'), *args], capture_output=True, text=True, timeout=60,
                              env={**os.environ, 'CHROMIUM_SRC': str(root)})

    def test_apply_check_and_revert_round_trip(self):
        with tempfile.TemporaryDirectory(prefix='ardia-mac-apply-') as scratch:
            root = pathlib.Path(scratch)
            originals = self.fake_tree(root)
            self.assertNotEqual(self.run_apply(root, '--check').returncode, 0)
            applied = self.run_apply(root)
            self.assertEqual(applied.returncode, 0, applied.stderr)
            for path in HOOKED_FILES:
                self.assertNotEqual((root / path).read_text(), originals[path], path)
            self.assertTrue((root / 'ardia/mac/BUILD.gn').is_file())
            self.assertFalse((root / 'ardia/mac/bootstrap.js').exists())
            dev = self.run_apply(root, '--dev')
            self.assertEqual(dev.returncode, 0, dev.stderr)
            self.assertTrue((root / 'ardia/mac/bootstrap.js').is_file())
            self.assertTrue((root / 'ardia/mac/generated/ac_desktop_routes.h').is_file())
            checked = self.run_apply(root, '--check')
            self.assertEqual(checked.returncode, 0, checked.stderr)
            hooked = {path: (root / path).read_text() for path in HOOKED_FILES}
            again = self.run_apply(root)
            self.assertEqual(again.returncode, 0, again.stderr)
            for path in HOOKED_FILES:
                text = (root / path).read_text()
                self.assertEqual(text, hooked[path], path)
                self.assertLessEqual(text.count('g_ardia_mac_'), 8, path)
            reverted = self.run_apply(root, '--revert')
            self.assertEqual(reverted.returncode, 0, reverted.stderr)
            for path in HOOKED_FILES:
                self.assertEqual((root / path).read_text(), originals[path], path)
            self.assertFalse((root / 'ardia/mac').exists())

    def test_apply_migrates_reformatted_link_hooks_and_collapses_copies(self):
        throttles = 'chrome/browser/chrome_content_browser_client_navigation_throttles.cc'
        download = 'content/browser/renderer_host/render_frame_host_impl.cc'
        windows = 'content/browser/web_contents/web_contents_impl.cc'
        anchor_file = 'third_party/blink/renderer/core/html/html_anchor_element.cc'
        menu = 'components/renderer_context_menu/render_view_context_menu_base.cc'
        overlay = 'chrome/browser/ui/views/overlay/video_overlay_window_views.cc'
        linked = (throttles, download, windows, anchor_file, menu, overlay)
        guard = '#if BUILDFLAG(IS_MAC) && !defined(OFFICIAL_BUILD)\n'
        with tempfile.TemporaryDirectory(prefix='ardia-mac-apply-') as scratch:
            root = pathlib.Path(scratch)
            originals = self.fake_tree(root)
            self.assertEqual(self.run_apply(root).returncode, 0)
            hooked = {path: (root / path).read_text() for path in linked}
            self.assertIn('CONTENT_EXPORT void SetArdiaMacDownloadUrlHook(', hooked[download])
            self.assertIn('CONTENT_EXPORT void SetArdiaMacNewWindowInPlaceHook(', hooked[windows])
            self.assertIn('namespace {\nbool (*g_ardia_mac_download_url)(', hooked[download])
            self.assertIn('request.SetSuggestedFilename(', hooked[anchor_file])
            reformatted = {
                throttles: hooked[throttles]
                .replace('    if (g_ardia_mac_add_navigation_throttles) {\n',
                         '    if ( g_ardia_mac_add_navigation_throttles ) {\n')
                .replace(guard + 'void (*g_ardia_mac_add_navigation_throttles)(\n',
                         '#if  BUILDFLAG(IS_MAC)  &&  !defined(OFFICIAL_BUILD)\nvoid (* g_ardia_mac_add_navigation_throttles)(\n'),
                download: hooked[download].replace(guard + '  if (g_ardia_mac_download_url &&\n',
                                                   '# if BUILDFLAG(IS_MAC) && !defined(OFFICIAL_BUILD)\n'
                                                   '  if (g_ardia_mac_download_url  &&\n'),
                windows: hooked[windows].replace('    return nullptr;\n  }\n#endif\n',
                                                 '    return nullptr;\n  }\n#endif  \n'),
                anchor_file: hooked[anchor_file].replace('#if !defined(OFFICIAL_BUILD)\n',
                                                         '#if   !defined( OFFICIAL_BUILD )\n'),
                menu: hooked[menu]
                .replace('RenderViewContextMenuObserver* (*g_ardia_mac_page_menu_observer)(\n',
                         'RenderViewContextMenuObserver* ( *g_ardia_mac_page_menu_observer )(\n')
                .replace('  if (g_ardia_mac_page_menu_observer) {\n', '  if ( g_ardia_mac_page_menu_observer) {\n')
                .replace('  if (g_ardia_mac_page_menu_destroyed) {\n', '  if (g_ardia_mac_page_menu_destroyed ) {\n'),
                overlay: hooked[overlay]
                .replace('(*g_ardia_mac_video_overlay)(\n', '(* g_ardia_mac_video_overlay)(\n')
                .replace('  if (g_ardia_mac_video_overlay) {\n', '  if (g_ardia_mac_video_overlay ) {\n'),
            }
            for path, text in reformatted.items():
                self.assertNotEqual(text, hooked[path], path)
                (root / path).write_text(text)
            self.assertNotEqual(self.run_apply(root, '--check').returncode, 0)
            migrated = self.run_apply(root)
            self.assertEqual(migrated.returncode, 0, migrated.stderr)
            for path in linked:
                self.assertEqual((root / path).read_text(), hooked[path], path)
            self.assertEqual(self.run_apply(root, '--check').returncode, 0)
            for path, text in reformatted.items():
                (root / path).write_text(text)
            reverted = self.run_apply(root, '--revert')
            self.assertEqual(reverted.returncode, 0, reverted.stderr)
            for path in linked:
                self.assertEqual((root / path).read_text(), originals[path], path)
            earlier = (guard + 'bool (*g_ardia_mac_download_url)(RenderFrameHost* frame,\n'
                       '                                 const GURL& url,\n'
                       '                                 bool follows_redirects,\n'
                       '                                 bool names_file,\n'
                       '                                 bool user_gesture) = nullptr;\n#endif\n\n')
            function = 'void RenderFrameHostImpl::DownloadURL(\n'
            (root / download).write_text(originals[download].replace(function, earlier + function, 1))
            self.assertNotEqual(self.run_apply(root, '--check').returncode, 0)
            self.assertEqual(self.run_apply(root).returncode, 0)
            upgraded = (root / download).read_text()
            self.assertEqual(upgraded.count('g_ardia_mac_download_url)('), 1)
            self.assertIn('SetArdiaMacDownloadUrlHook', upgraded)
            self.assertEqual(self.run_apply(root, '--check').returncode, 0)
            call = hooked[download].split('blink_parameters) {\n', 1)[1].split('  std::unique_ptr', 1)[0]
            self.assertTrue(call.startswith('#if ') and call.endswith('#endif\n'), call)
            spaced = call.replace(guard, '#if BUILDFLAG(IS_MAC)  && !defined(OFFICIAL_BUILD)\n')
            doubled = hooked[download].replace(
                '  std::unique_ptr<download::DownloadUrlParameters> parameters =\n',
                spaced + '  std::unique_ptr<download::DownloadUrlParameters> parameters =\n', 1)
            self.assertEqual(doubled.count('if (g_ardia_mac_download_url &&'), 2)
            (root / download).write_text(doubled)
            self.assertNotEqual(self.run_apply(root, '--check').returncode, 0)
            collapsed = self.run_apply(root)
            self.assertEqual(collapsed.returncode, 0, collapsed.stderr)
            self.assertEqual((root / download).read_text(), hooked[download])
            (root / download).write_text(doubled)
            self.assertEqual(self.run_apply(root, '--revert').returncode, 0)
            self.assertEqual((root / download).read_text(), originals[download])
            for path in (menu, overlay):
                (root / path).write_text(reformatted[path])
            self.assertEqual(self.run_apply(root).returncode, 0)
            for path in (menu, overlay):
                self.assertEqual((root / path).read_text(), hooked[path], path)
            moved = (guard + '  if (g_ardia_mac_new_window_in_place &&\n'
                     '      g_ardia_mac_new_window_in_place(\n'
                     '          this, params.target_url, params.disposition,\n'
                     '          params.is_form_submission || params.form_submission_post_data,\n'
                     '          has_user_gesture)) {\n    return nullptr;\n  }\n#endif\n')
            late = '  bool was_blocked = false;\n'
            early = hooked[windows].split('CreateNewWindowParams& params) {\n', 1)[1].split('  content::ChildProcessId', 1)[0]
            self.assertTrue(early.startswith(guard) and early.endswith('#endif\n'), early)
            (root / windows).write_text(hooked[windows].replace(early, '', 1).replace(late, moved + late, 1))
            self.assertEqual((root / windows).read_text().count('g_ardia_mac_new_window_in_place &&'), 1)
            self.assertNotEqual(self.run_apply(root, '--check').returncode, 0)
            self.assertEqual(self.run_apply(root).returncode, 0)
            relocated = (root / windows).read_text()
            self.assertEqual(relocated, hooked[windows])
            self.assertLess(relocated.index('params.opener_suppressed && g_ardia_mac_new_window_in_place'),
                            relocated.index('content::ChildProcessId render_process_id'))

    def test_apply_touches_only_the_hook_block_inside_an_outer_guard(self):
        download = 'content/browser/renderer_host/render_frame_host_impl.cc'
        with tempfile.TemporaryDirectory(prefix='ardia-mac-apply-') as scratch:
            root = pathlib.Path(scratch)
            originals = self.fake_tree(root)
            self.assertEqual(self.run_apply(root).returncode, 0)
            hooked = (root / download).read_text()
            call = hooked.split('blink_parameters) {\n', 1)[1].split('  std::unique_ptr', 1)[0]
            respaced = call.replace('  if (g_ardia_mac_download_url &&\n', '  if (g_ardia_mac_download_url   &&\n')
            sibling = '  int ardia_sibling_kept = 1;\n'
            outer = '#if !defined(OFFICIAL_BUILD)\n' + sibling + respaced + sibling.replace('1', '2') + '#endif\n'
            nested = hooked.replace(call, outer, 1)
            (root / download).write_text(nested)
            self.assertNotEqual(self.run_apply(root, '--check').returncode, 0)
            self.assertEqual(self.run_apply(root).returncode, 0)
            applied = (root / download).read_text()
            self.assertIn(sibling, applied)
            self.assertIn(sibling.replace('1', '2'), applied)
            self.assertEqual(applied.count('g_ardia_mac_download_url &&'), 1)
            self.assertNotIn('g_ardia_mac_download_url   &&', applied)
            self.assertEqual(self.run_apply(root, '--check').returncode, 0)
            (root / download).write_text(nested)
            self.assertEqual(self.run_apply(root, '--revert').returncode, 0)
            reverted = (root / download).read_text()
            self.assertIn('#if !defined(OFFICIAL_BUILD)\n' + sibling + sibling.replace('1', '2') + '#endif\n', reverted)
            self.assertNotIn('g_ardia_mac_download_url', reverted)
            self.assertNotIn('SetArdiaMacDownloadUrlHook', reverted)
            self.assertEqual(reverted.replace('#if !defined(OFFICIAL_BUILD)\n' + sibling + sibling.replace('1', '2')
                                              + '#endif\n', '', 1), originals[download])

    def test_apply_upgrades_an_earlier_page_menu_hook_and_reverts_it(self):
        target = 'components/renderer_context_menu/render_view_context_menu_base.cc'
        earlier = ('\n#if BUILDFLAG(IS_MAC) && !defined(OFFICIAL_BUILD)\n'
                   '#include "ardia/mac/ac_mac_hooks.h"  // nogncheck\n\n'
                   'RenderViewContextMenuObserver* (*g_ardia_mac_page_menu_observer)(\n'
                   '    RenderViewContextMenuBase* menu,\n    ui::SimpleMenuModel* model) = nullptr;\n#endif\n')
        with tempfile.TemporaryDirectory(prefix='ardia-mac-apply-') as fresh_dir, \
                tempfile.TemporaryDirectory(prefix='ardia-mac-upgrade-') as old_dir:
            fresh, old = pathlib.Path(fresh_dir), pathlib.Path(old_dir)
            originals = self.fake_tree(fresh)
            self.fake_tree(old)
            self.assertEqual(self.run_apply(fresh).returncode, 0)
            expected = (fresh / target).read_text()
            anchor = '#include "url/origin.h"\n'
            (old / target).write_text(originals[target].replace(anchor, anchor + earlier, 1))
            stale = self.run_apply(old, '--check')
            self.assertNotEqual(stale.returncode, 0)
            upgraded = self.run_apply(old)
            self.assertEqual(upgraded.returncode, 0, upgraded.stderr)
            text = (old / target).read_text()
            self.assertEqual(text, expected)
            self.assertEqual(text.count('(*g_ardia_mac_page_menu_observer)('), 1)
            self.assertEqual(self.run_apply(old, '--check').returncode, 0)
            self.assertEqual(self.run_apply(old).returncode, 0)
            self.assertEqual((old / target).read_text(), expected)
            doubled = expected.replace(anchor, anchor + earlier, 1)
            (old / target).write_text(doubled)
            self.assertEqual(self.run_apply(old).returncode, 0)
            self.assertEqual((old / target).read_text(), expected)
            duplicated = expected.replace('  InitMenu();\n', '  InitMenu();\n' + expected.split('  InitMenu();\n', 1)[1].split('  if (toolkit_delegate_)', 1)[0], 1)
            (old / target).write_text(duplicated)
            self.assertNotEqual(self.run_apply(old, '--check').returncode, 0)
            self.assertEqual(self.run_apply(old).returncode, 0)
            self.assertEqual((old / target).read_text(), expected)
            twice_earlier = originals[target].replace(anchor, anchor + earlier + earlier, 1)
            (old / target).write_text(twice_earlier)
            self.assertNotEqual(self.run_apply(old, '--check').returncode, 0)
            upgraded_twice = self.run_apply(old)
            self.assertEqual(upgraded_twice.returncode, 0, upgraded_twice.stderr)
            self.assertEqual((old / target).read_text(), expected)
            self.assertEqual(self.run_apply(old, '--check').returncode, 0)
            (old / target).write_text(expected.replace(anchor, anchor + earlier, 1) + earlier)
            self.assertEqual(self.run_apply(old).returncode, 0)
            self.assertEqual((old / target).read_text(), expected)
            (old / target).write_text(twice_earlier)
            self.assertEqual(self.run_apply(old, '--revert').returncode, 0)
            self.assertEqual((old / target).read_text(), originals[target])
            (old / target).write_text(doubled)
            reverted = self.run_apply(old, '--revert')
            self.assertEqual(reverted.returncode, 0, reverted.stderr)
            self.assertEqual((old / target).read_text(), originals[target])

    def test_apply_refuses_a_missing_anchor(self):
        with tempfile.TemporaryDirectory(prefix='ardia-mac-apply-') as scratch:
            root = pathlib.Path(scratch)
            self.fake_tree(root)
            (root / 'chrome/browser/chrome_browser_main.cc').write_text('int main() {}\n')
            failed = self.run_apply(root)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn('anchor', failed.stderr)

    def test_paths_lists_every_hooked_file(self):
        listed = subprocess.run([str(ROOT / 'apply.sh'), '--paths'], capture_output=True, text=True, timeout=30)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        lines = listed.stdout.split()
        self.assertIn('ardia/mac/', lines)
        for path in HOOKED_FILES:
            self.assertIn(path, lines)

    def test_dev_copies_exist_and_stay_out_of_the_engine_key(self):
        copies = [line.split('\t') for line in (ROOT / 'dev-copies.tsv').read_text().splitlines() if line]
        self.assertTrue(copies)
        for source, target in copies:
            self.assertTrue((REPO / source).is_file(), source)
            self.assertTrue(target.startswith('ardia/mac/'), target)
        self.assertFalse((ROOT / 'copies.tsv').exists())
        self.assertIn('dev-copies.tsv', (ROOT / 'apply.sh').read_text())
        official = (MAC / 'BUILD.gn').read_text().split('} else {', 1)[0]
        for source, target in copies:
            self.assertNotIn(target.removeprefix('ardia/mac/'), official)


class EngineKeyTests(unittest.TestCase):
    def test_the_layer_is_not_in_the_engine_series(self):
        series = (REPO / 'engine/patches/series').read_text()
        self.assertNotIn('webui-engine', series)
        self.assertNotIn('ardiacore-mac', series)
        self.assertFalse((REPO / 'engine/ardiacore-mac').exists())

    def test_no_engine_key_reads_the_layer(self):
        for platform in ('macos', 'linux', 'win'):
            listed = subprocess.run([str(REPO / 'engine/engine-key.sh'), '--platform', platform, '--paths'],
                                    capture_output=True, text=True, timeout=120)
            self.assertEqual(listed.returncode, 0, listed.stderr)
            for spec in listed.stdout.splitlines():
                path = spec.split(')', 1)[-1]
                self.assertFalse(path.startswith('scripts/mac'), f'{platform}: {spec}')
                self.assertFalse(path.startswith('scripts') and 'webui-engine' in path, f'{platform}: {spec}')

    def test_shared_engine_scripts_leave_ardia_mac_to_this_layer(self):
        self.assertNotIn('webui-engine', (REPO / 'scripts/agent/engine-build').read_text())
        self.assertNotIn('ardiacore-mac', (REPO / 'scripts/agent/engine-build').read_text())


class ContractTests(unittest.TestCase):
    def read(self, name):
        return (MAC / name).read_text()

    def test_glass_regions_emit_presented_after_the_commit(self):
        glass = self.read('ac_mac_glass.mm')
        host = self.read('ac_mac_shell_host.mm')
        apply = glass.split('base::Value GlassRegions::Apply(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(apply.index('[CATransaction commit];'), apply.index('PostTask('))
        self.assertIn('glass::PresentableGeneration', glass)
        self.assertRegex(host, r'Emit\("ArdiaGlass", "presented",\s*base::Value\(base::DictValue\(\)\.Set\("generation", generation\)\)\)')
        desktop = (REPO / 'apps/desktop/src/glassRegions.ts').read_text()
        self.assertIn('export const GLASS_MODULE = "ArdiaGlass"', desktop)
        shell = (REPO / 'apps/desktop/src/shellGlass.ts').read_text()
        self.assertIn('event === "presented" && typeof value.generation === "number"', shell)

    def test_background_honours_the_environment(self):
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('webui_policy::kBackgroundEnvironment', host)
        self.assertIn('webui_policy::Background(', host)
        self.assertIn('getenv("ARDIA_BACKGROUND")', (ROOT / 'launcher/main.c').read_text())

    def test_popovers_keep_beyond_window_across_updates(self):
        popover = self.read('ac_mac_popover.mm')
        self.assertIn('popover::ResolveBeyondWindow(args.FindBool("beyondWindow"), panel.beyond_window)', popover)
        self.assertIn('panel.beyond_window = beyond;', popover)

    def test_context_menus_never_install_app_menus(self):
        menu = self.read('ac_mac_menu.mm')
        self.assertIn('BuildMenu(root, target, false)', menu)
        self.assertIn('BuildItem(top, MainTarget(), true)', menu)
        self.assertIn('menu::InstallsAppMenu(item.role, app_menus)', menu)

    def test_background_never_orders_the_window_onscreen(self):
        entry = self.read('ac_mac_webui.mm')
        self.assertIn('window::PresentationFor(BackgroundInstance())', entry)
        for call in ('ShowInactive', 'orderBack:', 'orderFront:', 'makeKeyAndOrderFront'):
            self.assertNotIn(call, entry)
        self.assertRegex(entry, r'if \(presentation\.show && opening\.activate\) \{\n\s+browser->GetWindow\(\)->Show\(\);')
        self.assertRegex(entry, r'\} else if \(presentation\.show && opening\.show\) \{\n\s+ShowWithoutActivating\(')
        self.assertIn('if (presentation.show && opening.maximize) {', entry)

    def test_presented_is_posted_and_gated_by_clear(self):
        glass = self.read('ac_mac_glass.mm')
        self.assertNotIn('setCompletionBlock', glass)
        self.assertIn('gate_.Issue(*presentable)', glass)
        self.assertIn('gate_.Live(ticket)', glass)
        clear = glass.split('void GlassRegions::Clear() {', 1)[1].split('\n}\n', 1)[0]
        for step in ('gate_.Invalidate();', 'weak_factory_.InvalidateWeakPtrs();', 'regions_.clear();', 'backdrops_.clear();'):
            self.assertIn(step, clear)
        self.assertIn('glass::MountedGlass(mounted)', glass)
        relayout = glass.split('glass::Layout GlassRegions::Relayout() {', 1)[1]
        self.assertRegex(relayout, r'if \(!content \|\| !frame\) \{\n\s+return glass::Layout\{\};')
        self.assertIn('region.source = glass::Source::kBackdrop;', glass)
        self.assertIn('glass::MountablePages(pages, with_native_view)', relayout)
        self.assertIn('glass::Layout mounted = glass::KeepAttached(layout, attached);', relayout)
        self.assertIn('placed_ = mounted.placements;', relayout)
        self.assertNotIn('placed_ = layout.placements;', relayout)
        self.assertIn('glass_->Clear();', self.read('ac_mac_shell_host.mm'))

    def test_queued_context_menu_binds_no_view(self):
        menu = self.read('ac_mac_menu.mm')
        self.assertNotIn('__weak', menu)
        self.assertIn('base::BindOnce(&PopUpContextMenu, std::move(live_view)', menu)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('GetWeakPtr(), renderer_document_, renderer_generation_)', host)
        self.assertIn('menu::ContextMenuLive(true, generation, renderer_generation_, current)', host)

    def test_mac_ci_runs_this_suite(self):
        workflow = (REPO / '.github/workflows/mac.yml').read_text()
        self.assertIn('python3 scripts/mac/webui-engine/tests/test_mac_layer.py', workflow)
        self.assertIn('"scripts/mac/webui-engine/**"', workflow)
        trigger = workflow.split('paths: &native', 1)[1].split('push:', 1)[0]
        webui_filter = workflow.split('            webui:', 1)[1].split('\n\n', 1)[0]
        for path in re.findall(r'- "([^"]+)"', webui_filter):
            self.assertIn(f'- "{path}"', trigger, path)
        self.assertIn('runs-on: blacksmith-6vcpu-macos-27', workflow.split('webui-engine:', 1)[1].split('\n\n', 1)[0])

    def test_dialogs_are_sheets_that_background_runs_never_show(self):
        dialog = self.read('ac_mac_dialog.mm')
        present = dialog.split('void DialogSheets::Present(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(present.index('if (background_ || !window) {'), present.index('beginSheetModalForWindow:'))
        self.assertIn('dialog_policy::Response{.forced = true}', present)
        self.assertNotIn('runModal', dialog)
        self.assertIn('dialog_policy::Parse(RequestFrom(request), window_id_)', dialog)
        self.assertIn('[parent endSheet:shown returnCode:NSModalResponseAbort];', dialog)
        self.assertIn('.Set("name", dialog_policy::kResolvedEvent)', dialog)
        self.assertIn('kResolvedEvent = "shell.dialogResolved"', self.read('ac_mac_dialog_policy.h'))
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        for capability in ('"ArdiaShell.beginDialog",', '"ArdiaShell.cancelDialog",'):
            self.assertIn(capability, lifecycle.split('kAdvertised[] = {', 1)[1].split('};', 1)[0])
        self.assertIn('base::DictValue().Set("accepted", true)', lifecycle)
        desktop = (REPO / 'apps/desktop/src/hostDialogs.ts').read_text()
        self.assertIn('"ArdiaShell.beginDialog"', desktop)
        self.assertIn('envelope?.name !== "shell.dialogResolved"', desktop)

    def test_quit_menu_item_runs_the_shell_quit_flow(self):
        model = self.read('ac_mac_menu_model.h')
        self.assertIn('command("Quit " + app, "quit", "q", kCommand)', model)
        self.assertNotIn('role("Quit " + app, Role::kQuit', model)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('if (command == "quit" && !shell_policy::ShellTakesQuit(RendererLive(), shell_ready_generation_, renderer_generation_)) {', host)
        self.assertIn('shell_ready_generation_ = renderer_generation_;', self.read('ac_mac_shell_calls.mm').split('if (method == "ArdiaShell.shellPainted") {', 1)[1].split('\n  }\n', 1)[0])
        self.assertEqual((REPO / 'apps/desktop/src/quit.ts').read_text().count('export const QUIT_COMMAND = "quit";'), 1)
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        quit = lifecycle.split('void StartQuit(const window_policy::DownloadAsker& asker) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('RequestWindowClose(generation)', quit)
        self.assertIn('window_policy::kQuitDeadlineSeconds', quit)
        self.assertIn('Quit().Expired(generation)', quit)
        self.assertIn('window_policy::BlocksShutdown(item->IsTransient(),', lifecycle)

    def test_a_confirmed_quit_cancels_downloads_before_it_exits(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        finish = lifecycle.split('void FinishShellQuit(window_policy::DownloadAuthorization authorized) {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(finish.index('window_policy::DownloadsToCancel(true, UnloadHandlersPending(), authorized, ActiveDownloadIds())'),
                        finish.index('item->Cancel(false);'))
        self.assertLess(finish.index('item->Cancel(false);'), finish.index('chrome::AttemptExit();'))
        self.assertNotIn('QuitDownloadAuthorization()', finish)
        exit_decision = lifecycle.split('void ExitSoon(bool shell_confirmed) {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(exit_decision.index('std::exchange(QuitDownloadAuthorization(), {})'), exit_decision.index('PostTask('))
        self.assertIn('base::BindOnce(&FinishShellQuit, std::move(authorized))', exit_decision)
        self.assertIn('FinishShellQuit(std::exchange(QuitDownloadAuthorization(), {}));', lifecycle)
        opened = lifecycle.split('void NoteDialogOpened(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ShownDownloads().Opened(asker, *dialog);', opened)
        self.assertIn('NoteDialogOpened(window_policy::DownloadAsker{window_id_, live}, *request);', lifecycle)
        self.assertNotIn('CancelAllDownloads', lifecycle)
        pending = lifecycle.split('bool UnloadHandlersPending() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ForEachCurrentBrowserWindowInterfaceOrderedByActivation(', pending)
        self.assertIn('UnloadController::From(browser)', pending)
        self.assertIn('TabsNeedBeforeUnloadFired()', pending)
        self.assertNotIn('Hosts()', pending)
        shown = lifecycle.split('if (method == "ArdiaShell.downloadsInProgress") {', 1)[1].split('return std::move(done)', 1)[0]
        self.assertIn('std::set<std::string> shown = ActiveDownloadIds();', shown)
        self.assertIn('const int count = static_cast<int>(shown.size());', shown)
        self.assertIn('ShownDownloads().Shown(', shown)
        self.assertNotIn('BlockingShutdownCountAllProfiles', lifecycle)
        start = lifecycle.split('void StartQuit(const window_policy::DownloadAsker& asker) {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(start.index('ShownDownloads().Take(asker)'), start.index('if (Quit().running())'))
        self.assertLess(start.index('ShownDownloads().Take(asker)'), start.index('ExitSoon(true)'))
        answer = lifecycle.split('void NoteDialogAnswer(const base::Value& envelope) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ShownDownloads().Declined(', answer)
        self.assertIn('NoteDialogAnswer(envelope);', lifecycle.split('void ShellHostView::StartLifecycle() {', 1)[1].split('\n}\n', 1)[0])
        exit_soon = lifecycle.split('void ExitSoon(bool shell_confirmed) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('shell_confirmed ? base::BindOnce(&FinishShellQuit, std::move(authorized))', exit_soon)
        self.assertIn(': base::BindOnce(&chrome::AttemptExit)', exit_soon)
        self.assertIn('ExitSoon(false);', lifecycle.split('void QuitWithoutShell() {', 1)[1].split('\n}\n', 1)[0])
        quit = lifecycle.split('void StartQuit(const window_policy::DownloadAsker& asker) {', 1)[1].split('\n}\n', 1)[0]
        self.assertNotIn('ExitSoon(false)', quit)
        self.assertNotIn('chrome::AttemptExit()', quit)
        self.assertIn('FinishShellQuit(std::exchange(QuitDownloadAuthorization(), {}));', quit)
        self.assertEqual(lifecycle.count('chrome::AttemptExit();'), 1)

    def test_a_late_quit_acknowledgment_cancels_its_close_instead_of_exiting(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        acknowledge = lifecycle.split('void ShellHostView::AcknowledgeWindowClose(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('Quit().Acknowledged(window_id_, quit_generation_)', acknowledge)
        stale = acknowledge.split('if (step == window_policy::QuitStep::kStale) {', 1)[1].split('}', 1)[0]
        self.assertIn('CancelWindowClose(*identity', stale)
        self.assertNotIn('ExitSoon', stale)
        self.assertNotIn('!Quit().running()', acknowledge)
        self.assertNotIn('close_quitting_', lifecycle + self.read('ac_mac_shell_host.h'))

    def test_a_newer_quit_reissues_an_in_flight_close(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        request = lifecycle.split('base::DictValue ShellHostView::RequestWindowClose(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(request.index('window_policy::PlanCloseRequest('), request.index('close_.Request(renderer_generation_)'))
        reissue = request.split('case window_policy::CloseRequestPlan::kReissue:', 1)[1].split('break;', 1)[0]
        self.assertIn('CancelWindowClose(close_.identity()', reissue)
        self.assertNotIn('quit_generation_ = quit_generation;\n  }\n  const bool fresh', request)

    def test_the_sidebar_edge_polls_while_over_outside_the_window(self):
        events = self.read('ac_mac_window_events.mm')
        poll = events.split('void WindowEvents::PollPointer(bool on) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('[state_->pointer_poll invalidate];', poll)
        self.assertIn('scheduledTimerWithTimeInterval:kPointerPollSeconds', poll)
        self.assertIn('kPointerPollSeconds = 0.1', events)
        self.assertIn('PollPointer(false);', events.split('void WindowEvents::WatchPointer(bool on) {', 1)[1].split('\n}\n', 1)[0])
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        self.assertIn('window_policy::PollsOutside(edge_.over(), pointer->x, pointer->y, pointer->width, pointer->height)', lifecycle)
        watch = lifecycle.split('void ShellHostView::SidebarEdgeCall(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(watch.index('window_events_->LivePointer()'), watch.index('edge_.Watch(hold, side, while_pressed)'))
        self.assertLess(watch.index('edge_.Place('), watch.index('edge_.Watch(hold, side, while_pressed)'))
        self.assertLess(watch.index('edge_.Watch(hold, side, while_pressed)'), watch.index('ReconcilePointerPoll(live);'))
        self.assertIn('ReconcilePointerPoll(pointer);', lifecycle.split('void ShellHostView::OnPointerMoved(', 1)[1].split('\n}\n', 1)[0])

    def test_the_sidebar_edge_lets_go_when_another_window_covers_the_pointer(self):
        events = self.read('ac_mac_window_events.mm')
        self.assertIn('NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways | NSTrackingInVisibleRect', events)
        self.assertIn('NSApplicationDidResignActiveNotification', events)
        self.assertIn('windowNumberAtPoint:screen belowWindowWithWindowNumber:0', events)
        self.assertIn('removeTrackingArea:state_->pointer_area', events)
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        self.assertIn('ReportSidebarEdge(edge_.Covered());', lifecycle.split('void ShellHostView::OnPointerMoved(', 1)[1].split('\n}\n', 1)[0])

    def test_live_documents_use_the_shared_canonical_store(self):
        calls = self.read('ac_mac_shell_calls.mm')
        documents = self.read('ac_mac_documents.mm')
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('if (DocumentSession::Handles(name)) {', calls)
        self.assertIn('documents_->Call(name, args, renderer_generation_, std::move(done));', calls)
        self.assertIn('!DocumentSession::Reserved(name)', calls)
        self.assertNotIn('kBootstrapDocumentLimit', calls)
        self.assertIn('ReadFileToStringWithMaxSize(path, &text, kDocumentLimit)', calls)
        self.assertIn('&LinuxDocumentService::DispatchTracked', documents)
        self.assertIn('ardia::kLinuxLiveMaxBytes', documents)
        self.assertIn('.Set("name", "documents.changed")', host)
        self.assertIn('documents_->RendererRetired();', host)
        copied = (ROOT / 'dev-copies.tsv').read_text()
        for name in ('ac_linux_documents', 'ac_linux_document_reducer', 'ac_linux_document_service'):
            self.assertIn(f'ardia/mac/shared/{name}.cc', copied)
            self.assertIn(f'ardia/mac/shared/ardia/linux/{name}.h', copied)
        self.assertIn('ardia/mac/shared/ac_linux_document_schema.cc', copied)
        gn = (MAC / 'BUILD.gn').read_text()
        for source in ('shared/ac_linux_documents.cc', 'shared/ac_linux_document_service.cc', 'ac_mac_documents.mm'):
            self.assertIn(f'"{source}"', gn)

    def test_startup_engine_calls_are_answered_not_failed(self):
        calls = self.read('ac_mac_shell_calls.mm')
        invoked = calls.split('constexpr std::string_view kInvokedEngineCalls[] = {', 1)[1].split('};', 1)[0]
        inert = calls.split('constexpr std::string_view kInertEngineCalls[] = {', 1)[1].split('};', 1)[0]
        for name in ('engine.info', 'tabs.strips', 'search.setEngineName'):
            self.assertIn(f'"{name}"', invoked)
        for name in ('engine.memorySaver', 'engine.systemState', 'webKit.setFraudWarnings', 'webView.setSelectionPopover'):
            self.assertIn(f'"{name}"', inert)
        engine = calls.split('void ShellHostView::EngineCall(', 1)[1]
        self.assertLess(engine.index('kInvokedEngineCalls'), engine.index('"This engine call is not in the Mac WebUI shell"'))

    def test_native_backdrop_sits_between_vibrancy_and_glass(self):
        glass = self.read('ac_mac_glass.mm')
        self.assertIn('for (ArdiaMacGlassSlotView* __strong* plane : {&views_->vibrancy, &views_->theme, &views_->glass}) {', glass)
        self.assertIn('if (glass::EffectFor(placement.material, liquid) != glass::Effect::kLiquidGlass) return views_->vibrancy;', glass)
        self.assertIn('LayOutThemes(layout);', glass)
        self.assertNotIn('backdrops_[index].rect', glass)
        self.assertIn('NSView* plane = views_->glass;', glass)
        self.assertIn(': views_->glass;', glass)
        self.assertNotIn(': views_->behind;', glass)
        self.assertIn('themes.push_back(ThemeOf(dict->FindDict("theme")));', glass)
        self.assertIn('[CATransaction setDisableActions:YES];', glass.split('void GlassRegions::LayOutThemes(const glass::Layout& layout) {', 1)[1])
        self.assertIn('"shell.windowBackdrop",', self.read('ac_mac_shell_calls.mm'))

    def test_tab_strips_and_search_engines_answer_for_real(self):
        calls = self.read('ac_mac_shell_calls.mm')
        strips = calls.split('if (method == "tabs.strips") {', 1)[1].split('\n  }\n', 1)[0]
        self.assertIn('.Set("rev", 0)', strips)
        self.assertIn('.Set("strips", base::ListValue())', strips)
        search = calls.split('if (method == "search.setEngineName") {', 1)[1].split('\n  }\n', 1)[0]
        self.assertIn('ardiacore::SetLinuxDefaultSearchEngine(text(0), text(1), text(2))', search)
        copied = (ROOT / 'dev-copies.tsv').read_text()
        self.assertIn('ardia/mac/shared/ac_linux_search_engines.cc', copied)
        self.assertIn('ardia/mac/shared/ardia/desktop/ac_desktop_search_engine_policy.h', copied)
        self.assertIn('"//components/search_engines",', (MAC / 'BUILD.gn').read_text())

    def test_generic_document_routes_never_touch_live_documents(self):
        calls = self.read('ac_mac_shell_calls.mm')
        for route in ('if (method == "ArdiaShell.writeDocument" ||', 'if (method == "ArdiaShell.removeDocument") {'):
            body = calls.split(route, 1)[1][:600]
            self.assertIn('if (DocumentSession::Reserved(name)) {', body)
        self.assertIn('return shell_policy::ReservedLiveDocument(name);', self.read('ac_mac_documents.mm'))

    def test_popover_panels_clip_their_page_and_leave_no_square_rim(self):
        popover = self.read('ac_mac_popover.mm')
        embed = popover.split('void Embed(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('content.layer.cornerRadius = kPanelRadius;', embed)
        self.assertIn('content.layer.masksToBounds = YES;', embed)
        self.assertIn('window.hasShadow = !LiquidGlassAvailable();', popover)
        self.assertIn('[panel.panel invalidateShadow];', popover)

    def test_window_close_runs_the_shared_close_protocol(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        for name in ('shell.closeRequested', 'shell.closeCancelled'):
            self.assertIn(f'"{name}"', lifecycle)
        for capability in ('requestWindowClose', 'beginWindowCloseDrain', 'acknowledgeWindowClose', 'rejectWindowClose'):
            self.assertIn(f'"ArdiaShell.{capability}",', lifecycle)
        acknowledge = lifecycle.split('void ShellHostView::AcknowledgeWindowClose(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(acknowledge.index('close_.Acknowledge('), acknowledge.index('held_departure_ = HeldDeparture{'))
        self.assertIn('window_policy::ValidDeparture(', acknowledge)
        self.assertNotIn('AttemptExit', self.read('ac_mac_shell_calls.mm'))
        shell = (REPO / 'apps/desktop/src/shims/shell.tsx').read_text()
        for method in ('requestWindowClose', 'beginWindowCloseDrain', 'acknowledgeWindowClose', 'rejectWindowClose'):
            self.assertIn(f'"{method}"', shell)

    def test_window_state_is_real_and_reported(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertNotIn('.Set("maximized", false)', calls)
        self.assertIn('if (HandlesLifecycleCall(method)) {', calls)
        events = self.read('ac_mac_window_events.mm')
        for name in ('NSWindowDidBecomeKeyNotification', 'NSWindowDidResignKeyNotification',
                     'NSWindowDidResizeNotification', 'NSWindowDidEnterFullScreenNotification',
                     'NSWindowDidExitFullScreenNotification', 'NSWindowWillCloseNotification'):
            self.assertIn(name, events)
        self.assertIn('window_policy::StateOf(window.isZoomed, FullScreen(), window.isMiniaturized)', events)
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        self.assertIn('Emit("ArdiaShell", "windowState", base::Value(WindowStateValue()));', lifecycle)
        for kind in ('"focus"', '"blur"', '"frame"', '"fullScreen"', '"close"', '"sidebarEdge"'):
            self.assertIn(f'.Set("type", {kind})', lifecycle)
        window = self.read('ac_mac_window.mm')
        self.assertIn('window_policy::kMinWidth', window)
        self.assertIn('KeepMinimumSize(widget);', window.split('void ApplyShellWindowStyle(', 1)[1].split('\n}\n', 1)[0])
        policy = self.read('ac_mac_window_policy.h')
        self.assertIn('kMinWidth = 720', policy)
        self.assertIn('kMinHeight = 460', policy)
        swift = (REPO / 'apps/browser/macos/Ardia-macOS/BrowserWindow.swift').read_text()
        self.assertIn('NSSize(width: 720, height: 460)', swift)

    def test_background_never_moves_the_window_into_view(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        for skipped in ('full screen toggle skipped (background)', 'minimize skipped (background)',
                        'skipped (background)'):
            self.assertIn(skipped, lifecycle)

    def test_shortcut_recording_and_switcher_capture_are_served(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        self.assertIn('focus_manager_->set_shortcut_handling_suspended(on);', lifecycle)
        self.assertIn('RestoreSwitcherSource();', lifecycle)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('if (command == "tabSwitcher" && !switcher_capture_) {', host)
        runtime = (REPO / 'apps/desktop/src/shortcutsRuntime.ts').read_text()
        for method in ('ArdiaShell.setShortcutRecording', 'ArdiaShell.setSwitcherCapture', 'ArdiaShell.restoreShortcutFocus'):
            self.assertIn(f'"{method}"', runtime)

    def test_caption_double_click_is_served_and_advertised(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertIn('"ArdiaShell.captionDoubleClick",', calls)
        self.assertIn('return CaptionDoubleClick(std::move(done));', calls)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('AppleActionOnDoubleClick', host)
        self.assertIn('[ns_window performZoom:nil];', host)
        self.assertIn('[ns_window performMiniaturize:nil];', host)
        routes = (REPO / 'apps/desktop/src/windowDrag.ts').read_text()
        self.assertIn('"ArdiaShell.captionDoubleClick"', routes)

    def test_reused_effects_take_new_materials_and_corner_masks(self):
        style = self.read('ac_mac_glass.mm').split('void Style(NSView* view, const glass::Placement& placement) {', 1)[1]
        style = style.split('\n}\n', 1)[0]
        self.assertIn('vibrancy.material = VibrancyMaterial(placement.material);', style)
        self.assertIn('glass::GlassStyle(placement.material)', style)
        self.assertEqual(style.count('ApplyMask(view, shape, slice);'), 2)
        apply = self.read('ac_mac_glass.mm').split('void ApplyMask(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ApplyCornerMask(view, shape);', apply)
        self.assertIn('ApplySliceMask(view, slice);', apply)
        mask = self.read('ac_mac_glass.mm').split('void ApplyCornerMask(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('view.layer.mask = mask;', mask)
        self.assertIn('view.layer.mask = nil;', mask)

    def test_sessions_and_documents_use_the_shell_policy(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertIn('return shell_policy::ValidDocumentName(name);', calls)
        write = calls.split('bool WriteSessionFile(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(write.index('shell_policy::SessionFitsOnDisk(json->size())'), write.index('WriteFileAtomically'))
        self.assertIn('base::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION, ardia::kLinuxSessionMaxDepth', write)
        self.assertIn('static_assert(shell_policy::kMergeableSessionBytes == ardia::kLinuxSessionMaxBytes);', calls)
        merge = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_session.cc').read_text()
        self.assertIn('base::OPTIONS_OMIT_DOUBLE_TYPE_PRESERVATION', merge)
        self.assertIn('json->size() > kLinuxSessionMaxBytes', merge)

    def test_cross_profile_replacement_opens_before_it_retires(self):
        host = self.read('ac_mac_shell_host.mm')
        create = host.split('void ShellHostView::CreateTabIn(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(create.index('shell_policy::PlanCreate(request)'), create.index('existing->claim = claim;'))
        self.assertNotIn('NeedToFireBeforeUnloadOrUnloadEvents', create)
        self.assertNotIn('CloseWebContentsAt(', create)
        self.assertLess(create.index('Navigate(&params);'), create.index('DetachAndDeleteWebContentsAt(old_index);'))
        self.assertLess(create.index('bindings_.erase(existing->id());'), create.index('DetachAndDeleteWebContentsAt(old_index);'))
        self.assertNotIn('bindings_.erase(replaced_id);', create)
        self.assertIn('args.Find("adoptId")', create)

    def test_nonuniform_liquid_glass_drops_the_native_radius(self):
        style = self.read('ac_mac_glass.mm').split('void Style(NSView* view, const glass::Placement& placement) {', 1)[1]
        self.assertIn('glass::NativeCornerRadius(shape)', style.split('\n}\n', 1)[0])
        self.assertIn('glass::ShapeFor(placement.radii)', style)

    def test_window_drag_accepts_a_left_drag(self):
        host = self.read('ac_mac_shell_host.mm')
        move = host.split('void ShellHostView::StartWindowMove(Done done) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('NSEventTypeLeftMouseDragged', move)
        self.assertIn('window::WindowDragFor(', move)
        self.assertIn('current.window == ns_window', move)
        self.assertIn('start.use_retained_down ? retained : current', move)
        watch = host.split('void ShellHostView::WatchWindowDrag() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('event.window == watched', watch)
        self.assertIn('NSWindowDidResignKeyNotification', watch)
        self.assertIn('StopWatchingWindowDrag();', host.split('void ShellHostView::DetachBrowser() {', 1)[1].split('\n}\n', 1)[0])

    def test_browser_created_tabs_are_offered_and_adopted(self):
        host = self.read('ac_mac_shell_host.mm')
        changed = host.split('void ShellHostView::OnTabStripModelChanged(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('TabStripModelChange::kInserted', changed)
        self.assertIn('NoteUnclaimedTab(', changed)
        self.assertIn('Emit("ArdiaTabs", "unclaimed", base::Value(OfferTab(contents, active)));', host)
        self.assertIn('.Set("adoptId", "tab:" + base::NumberToString(TabId(contents)))', host)
        self.assertIn('shell_policy::OfferedProfile(', host)
        create = host.split('void ShellHostView::CreateTabIn(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(create.index('shell_policy::CheckAdoption('), create.index('Navigate(&params);'))
        self.assertLess(create.index('shell_policy::CheckAdoption('), create.index('existing->claim = claim;'))
        self.assertIn('return ListUnclaimedTabs(std::move(done));', self.read('ac_mac_shell_calls.mm'))
        desktop = (REPO / 'apps/desktop/src/unclaimedTabs.ts').read_text()
        self.assertIn('/^tab:\\d+$/', desktop)
        self.assertIn('module === "ArdiaTabs" && event === "unclaimed"', desktop)

    def test_popover_panels_are_advertised_once_the_renderer_ships(self):
        policy = self.read('ac_mac_popover_policy.h')
        shipped = re.search(r'kPopoverRendererShipped = (true|false);', policy).group(1)
        calls = self.read('ac_mac_shell_calls.mm')
        listed = calls.split('constexpr std::string_view kCapabilities[] = {', 1)[1].split('};', 1)[0]
        self.assertNotIn('shell.popover', listed)
        self.assertIn('if (popover::kPopoverRendererShipped) {', calls)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('method == "shell.popover.open" && !popover::kPopoverRendererShipped', host)
        main = (REPO / 'apps/desktop/src/main.tsx').read_text()
        surface = (REPO / 'apps/desktop/src/popoverSurface.ts').read_text()
        if shipped == 'false':
            self.assertNotIn('entryKind(', main)
        else:
            self.assertIn('entryKind(ardiaHost, location.search)', main)
            self.assertIn('popoverBoot(host, search)', surface)
            self.assertIn('import("./popoverEntry")', main)
            self.assertIn('import("./shellEntry")', main)
            self.assertNotIn('browser/src', main)
            self.assertIn('bootstrap.popover', surface)
            self.assertIn('bootstrap.surface !== POPOVER_SURFACE', surface)
            self.assertIn('POPOVER_SURFACE = "popover"', surface)
            root = (REPO / 'apps/desktop/src/PopoverRoot.tsx').read_text()
            for method in ('shell.popover.close', 'shell.popover.message', 'shell.popover.props'):
                self.assertIn(method, root + surface)
            self.assertIn('POPOVER_MODULE = "ArdiaPopover"', surface)
            self.assertIn('module !== POPOVER_MODULE', surface)
        popover_host = (REPO / 'apps/desktop/src/popoverHost.ts').read_text()
        self.assertIn('POPOVER_CHILD_PANEL_METHODS.every((method) => hostSupports(method, host))', popover_host)
        self.assertIn('POPOVER_MESSAGE_EVENT', popover_host)

    def test_popover_bridge_stays_narrow(self):
        bridge = self.read('ac_mac_shell_bridge.cc')
        request = bridge.split('void PopoverBridge::Request(', 1)[1].split('\n}\n', 1)[0]
        methods = set(re.findall(r'method == "([^"]+)"', request))
        self.assertEqual(methods, {'shell.popover.close', 'shell.popover.props', 'shell.popover.message'})
        self.assertIn('popover::MessageFits(', request)
        deliver = bridge.split('void PopoverBridge::Deliver(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(deliver.index('if (!Trusted())'), deliver.index('CallJavascriptFunction('))
        popover = self.read('ac_mac_popover.mm')
        self.assertIn('.Append("shell.popover.props")', popover)
        self.assertIn('popover::PropsFit(', popover)

    def test_suppressed_shortcuts_are_consumed(self):
        host = self.read('ac_mac_shell_host.mm')
        pressed = host.split('bool ShellHostView::AcceleratorPressed(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(pressed.index('shell_policy::ShortcutAction::kConsume'), pressed.index('FocusShell();'))
        self.assertLess(pressed.index('shell_policy::ShortcutAction::kConsume'), pressed.index('"onCommand"'))
        self.assertIn('shell_policy::ShortcutAccepted(', host)

    def test_menu_state_and_bookmarks_are_real_and_advertised(self):
        calls = self.read('ac_mac_shell_calls.mm')
        listed = calls.split('constexpr std::string_view kCapabilities[] = {', 1)[1].split('};', 1)[0]
        self.assertIn('"ArdiaShell.setMenuState"', listed)
        self.assertIn('"ArdiaShell.setMenuBookmarks"', listed)
        self.assertIn('SetWindowMenuState(window_id_, (*values)[0])', calls)
        self.assertIn('SetWindowMenuBookmarks(window_id_, (*values)[0])', calls)
        menu = self.read('ac_mac_menu.mm')
        present = menu.split('void Present(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('FillBookmarks(record.bookmarks);', present)
        self.assertIn('ApplyState(NSApp.mainMenu, *record.state, 0);', present)
        self.assertIn('menu::BookmarkMenuItems(*known)', menu)
        for setter in ('SetWindowMainMenu', 'SetWindowMenuState', 'SetWindowMenuBookmarks'):
            body = menu.split('void ' + setter + '(' if setter == 'SetWindowMainMenu' else 'std::optional<std::string> ' + setter + '(', 1)[1].split('\n}\n', 1)[0]
            self.assertIn('ClaimsBar(window_id)', body)
        self.assertIn('return Owner().Claims(window_id, key == window_id, key.has_value());', menu)
        self.assertIn('NSWindowDidBecomeKeyNotification', menu)
        activate = menu.split('void ActivateKeyWindow(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('BuildBar(menu::MinimalMainMenu(', activate)
        handler = self.read('ac_mac_shell_host.mm').split('MenuCommandHandler MainMenuHandler() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('KeyMenuWindowId()', handler)

    def test_shortcut_recording_suppresses_menu_key_equivalents(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        keyboard = lifecycle.split('void ShellHostView::KeyboardCall(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('SetMenuKeysSuppressed(window_id_, on);', keyboard)
        self.assertNotIn('"ArdiaShell.setShortcutRecording"', self.read('ac_mac_shell_calls.mm'))
        menu = self.read('ac_mac_menu.mm')
        key = menu.split('- (BOOL)performKeyEquivalent:(NSEvent*)event {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(key.index('MenuKeysSuppressed()'), key.index('[super performKeyEquivalent:event]'))
        self.assertIn('[[ArdiaMacMainMenu alloc] initWithTitle:@""]', menu)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('SetMenuKeysSuppressed(window_id_, false);', host.split('void ShellHostView::RetireRenderer() {', 1)[1].split('\n}\n', 1)[0])
        self.assertIn('ForgetWindowMenu(window_id_);', host.split('void ShellHostView::DetachBrowser() {', 1)[1].split('\n}\n', 1)[0])
        self.assertIn('menu::AddStateEntry(', menu)
        self.assertIn('menu::AddStateTitle(', menu)
        desktop = (REPO / 'apps/desktop/src/nativeMenuBar.ts').read_text()
        self.assertIn('"ArdiaShell.setMainMenu"', desktop)
        self.assertIn('SetWindowMainMenu(window_id_, std::move(parsed.root), MainMenuHandler());', self.read('ac_mac_shell_host.mm'))
        self.assertIn('SetMenuWindowResolver(ShellMenuWindows());', self.read('ac_mac_webui.mm'))
        self.assertIn('"menu:Bookmarks": "bookmarksMenu"', desktop)

    def test_glass_regions_carry_tint_group_and_appearance(self):
        glass = self.read('ac_mac_glass.mm')
        region = glass.split('std::optional<glass::Region> RegionOf(', 1)[1].split('\n}\n', 1)[0]
        for key in ('"tint"', '"group"', '"appearance"'):
            self.assertIn(key, region)
        self.assertIn('glass::ColorFrom(', region)
        self.assertIn('glass::ValidGroup(', region)
        self.assertIn('@"tintColor"', glass)
        self.assertIn('NSGlassEffectContainerView', glass)
        self.assertIn('glass::Grouped(placement, groups_glass)', glass)
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertIn('"shell.glassBehindWindow"', calls)
        self.assertIn('.Set("isLiquidGlass", LiquidGlassAvailable())', calls)

    def test_offers_leave_with_their_tab_and_replay_active(self):
        host = self.read('ac_mac_shell_host.mm')
        changed = host.split('void ShellHostView::OnTabStripModelChanged(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('TabStripModelChange::kRemoved', changed)
        self.assertIn('offered_.Forget(id);', changed)
        listing = host.split('void ShellHostView::ListUnclaimedTabs(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('offer.active', listing)
        self.assertNotIn('OfferTab(contents, false)', listing)
        self.assertIn('offered_.Add(TabId(contents), contents->GetWeakPtr(), active);', host)

    def test_share_is_advertised_served_and_never_shown_in_background(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertIn('share::AppendCapabilities(capabilities);', calls)
        self.assertIn('return share::Invoke(*this, method, values, std::move(done));', calls)
        share = self.read('ac_mac_share.mm')
        for method in ('ArdiaApp.share', 'ArdiaApp.shareText', 'ArdiaApp.shareVia', 'ArdiaApp.shareServices',
                       'ArdiaApp.openSharingSettings'):
            self.assertIn(f'"{method}",', share)
        show = share.split('void ShowPicker(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(show.index('BackgroundInstance()'), show.index('showRelativeToRect'))
        via = share.split('void ShareVia(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(via.index('BackgroundInstance()'), via.index('performWithItems'))
        self.assertIn('share_policy::ClassifyUrl(url)', share)
        desktop = (REPO / 'apps/desktop/src/hostShare.ts').read_text()
        self.assertIn('isLinkShareService(service)', desktop)
        self.assertIn('"ArdiaApp.openSharingSettings"', desktop)

    def test_page_menus_share_through_the_shell(self):
        self.assertIn('share::InstallPageMenu();', self.read('ac_mac_webui.mm'))
        self.assertIn('g_ardia_mac_page_menu_observer', self.read('ac_mac_hooks.h'))
        apply = (ROOT / 'apply.sh').read_text()
        self.assertIn('observers_.AddObserver(observer);', apply)
        share = self.read('ac_mac_share.mm')
        self.assertIn('g_ardia_mac_page_menu_observer = &PageMenuObserver;', share)
        self.assertIn('g_ardia_mac_page_menu_destroyed = &PageMenuDestroyed;', share)
        self.assertIn('g_ardia_mac_page_menu_destroyed(this);', apply)
        self.assertIn('return MenuObservers().Attach(', share)
        self.assertIn('MenuObservers().Release(menu);', share)
        self.assertNotIn('CurrentObserver', share)
        observer = share.split('class PageShareObserver', 1)[1].split('\n};\n', 1)[0]
        self.assertIn('content::GlobalRenderFrameHostId frame_;', observer)
        self.assertNotIn('RenderViewContextMenuBase*', observer)
        self.assertIn('.Set("name", "command")', share)
        self.assertIn('Emit("ArdiaWebView"', share)

    def test_shared_folders_are_advertised_located_and_watched_per_window(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertIn('shared_folders::AppendCapabilities(capabilities);', calls)
        self.assertIn('->Set("location", shared_folders::Location());', calls)
        script = calls.split('std::optional<std::string> BootstrapScript(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('shared_folders::Location()', script)
        host = self.read('ac_mac_shell_host.mm')
        detach = host.split('void ShellHostView::DetachBrowser() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('shared_folder_watcher_.reset();', detach)
        folders = self.read('ac_mac_shared_folders.mm')
        self.assertIn('Emit("ArdiaSharedFolders", "onChange"', folders)
        self.assertNotIn('dispatch_sync', folders)
        teardown = folders.split('Watcher::~Watcher() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('dispatch_async(core->queue', teardown)
        self.assertIn('delete core;', teardown)
        self.assertIn('base::BindOnce(&Watcher::Deliver, watcher,', folders)
        retire = host.split('void ShellHostView::RetireRenderer() {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(retire.index('shared_folder_watcher_.reset();'), retire.index('if (!had_document)'))
        self.assertLess(retire.index('share::Retire(window_id_);'), retire.index('if (!had_document)'))
        modules = (REPO / 'apps/desktop/src/hostModules.ts').read_text()
        self.assertIn('host.bootstrap.nativeModules?.ArdiaSharedFolders?.location', modules)
        self.assertIn('"ArdiaSharedFolders.location",', folders)

    def test_shared_folder_writes_match_the_swift_directory(self):
        folders = self.read('ac_mac_shared_folders.mm')
        moving = folders.split('Coordinated CoordinateMoving(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('const bool renamed = (*run)();', moving)
        self.assertIn('didMoveToURL:policy::MovedTo(renamed) ? replacing : moving', moving)
        self.assertLess(moving.index('willMoveToURL:replacing'), moving.index('const bool renamed = (*run)();'))
        write = folders.split('Step Write(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('RENAME_EXCL', write)
        self.assertIn('NSFileCoordinatorWritingForReplacing', write)
        self.assertIn('LinkUrl(folder, name) != expect', write)
        self.assertIn('O_NOFOLLOW', folders.split('Opened OpenDirectoryIn(', 1)[1].split('\n}\n', 1)[0])
        self.assertIn('policy::RelativeParts(*path)', folders)
        self.assertIn('policy::RefusedFolder(*real, HomeDirectory())', folders)
        self.assertNotIn('DeletePathRecursively', folders)
        run = folders.split('Coordinated RunCoordinated(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('policy::kCoordinationTimeoutSeconds', run)
        self.assertIn('[coordinator cancel];', run)
        self.assertIn('gate->Expire()', run)
        self.assertIn('gate->Begin()', run)
        self.assertIn('dispatch_block_cancel(expire);', run)
        for helper in ('CoordinateReading', 'CoordinateWriting', 'CoordinateMoving'):
            body = folders.split(f'Coordinated {helper}(', 1)[1].split('\n}\n', 1)[0]
            self.assertIn('begin()', body)

    def test_each_share_owns_its_picker_window_and_file(self):
        share = self.read('ac_mac_share.mm')
        self.assertNotIn('PickerState', share)
        chose = share.split('void PickerChose(std::uint64_t id,', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('found->second.picker != picker', chose)
        self.assertIn('[[ArdiaMacShareRequest alloc] initWithRequest:id]', share)
        self.assertIn('__weak NSWindow* window', share)
        retire = share.split('void Retire(const std::string& owner) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('[picker close];', retire)
        self.assertIn('RevokeImages(', retire)
        revoke = share.split('void RevokeImages(Match match) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('Issued().RevokeUnheld(', revoke)
        self.assertIn('image.cancelled->store(true);', revoke)
        self.assertIn('for (const std::string& path : revoked.written) {', revoke)
        self.assertNotIn('revoked.writing', revoke)
        binding = share.split('void RetireBinding(const std::string& owner, int binding) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('origin.binding == binding', binding)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('share::RetireBinding(owner_->window_id(), id_);', host.split('PageBinding::~PageBinding() {', 1)[1].split('\n}\n', 1)[0])
        self.assertIn('share::RetireBinding(window_id_, old_id);', host.split('void ShellHostView::ReplaceBinding(', 1)[1].split('\n}\n', 1)[0])
        self.assertEqual(host.count('share::RetireBinding('), 4)
        services = share.split('std::vector<Service> LinkServices() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('!seen', services)
        self.assertLess(retire.index('share_policy::KeepsServiceAfterRetire(found->second.service != nil)'), retire.index('[picker close];'))
        self.assertIn('found->second.chosen ? nil : found->second.picker', retire)
        shareable = share.split('std::optional<SharedFile> ShareableFile(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('lstat(', shareable)
        self.assertIn('S_ISREG(info.st_mode)', shareable)
        self.assertIn('Issued().Take(path, issued_here)', shareable)
        self.assertIn('owner.origin.window_id == host->window_id() && StillCurrent(owner)', shareable)
        self.assertIn('InInstanceDirectory(path)', shareable)
        self.assertIn('share_policy::InstanceDirectoryName(', share)
        sweep = share.split('void ClaimAndSweep(', 1)[1].split('\n}\n', 1)[0]
        claim = share.split('bool ClaimInstance(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('".staging"', share)
        self.assertLess(claim.index('flock(fd.get(), LOCK_EX | LOCK_NB)'), claim.index('rename(staging.value().c_str(), own.value().c_str())'))
        self.assertIn('InstanceLock() = std::move(fd);', claim)
        self.assertEqual(claim.count('base::DeletePathRecursively(staging);'), 1)
        self.assertIn('InstanceClaimed() = ClaimInstance(root, own);', sweep)
        self.assertIn('share_policy::StagingPid(', sweep)
        self.assertIn('share_policy::SweepsStaging(', sweep)
        self.assertIn('InstanceLockState lock = LockOf(entry);', sweep)
        self.assertLess(sweep.index('InstanceLockState lock = LockOf(entry);'), sweep.index('base::DeletePathRecursively(entry);'))
        self.assertIn('share_policy::SweepsInstance(', sweep)
        self.assertIn('base::FileEnumerator::DIRECTORIES)', sweep)
        self.assertNotIn('DeleteFile(entry)', sweep)
        lock = share.split('InstanceLockState LockOf(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('LOCK_EX | LOCK_NB', lock)
        self.assertIn('O_NOFOLLOW', lock)
        for callback in ('bool PickerOwns(std::uint64_t id,', 'void ServiceFinished(std::uint64_t id,',
                         'NSWindow* SourceWindow(std::uint64_t id,'):
            body = share.split(callback, 1)[1].split('\n}\n', 1)[0]
            self.assertIn('service', body)
        self.assertIn('return ardia_mac::share::PickerOwns(_request, picker, service) ? self : nil;', share)
        remove = share.split('void RemoveTemporary(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(remove.index('Issued().Revoke(standard);'), remove.index('ScheduleUnlink('))
        unlinked = share.split('void Unlinked(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('share_policy::NextUnlinkStep(attempt, gone)', unlinked)
        self.assertIn('share_policy::UnlinkRetryDelayMs(attempt)', unlinked)
        self.assertIn('base::DeleteFile(path)', share.split('void ScheduleUnlink(base::FilePath path, std::string standard, int attempt, base::TimeDelta delay) {', 1)[1].split('\n}\n', 1)[0])
        image = share.split('void DeliverImage(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(image.index('StillBound(origin, contents.get(), &binding)'), image.index('Issued().Reserve('))
        self.assertLess(image.index('Issued().Reserve('), image.index('std::vector<uint8_t>(image)'))
        self.assertIn('if (cancelled->load() || !InstanceClaimed()) {', image)
        self.assertIn('Issued().Publish(standard)', image)
        self.assertNotIn('CreateDirectory', image)
        self.assertNotIn('Issued().Issue(', share)
        self.assertIn('constexpr int kShareFirst = share_policy::kShareCommandFirst;', share)
        self.assertNotIn('IDC_CONTENT_CONTEXT_CUSTOM_FIRST +', share)
        owns = share.split('bool PickerOwns(std::uint64_t id,', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('share_policy::SameChoice(', owns)
        chose = share.split('void PickerChose(std::uint64_t id,', 1)[1].split('\n}\n', 1)[0]
        self.assertNotIn('picker = nil', chose)
        deliver = share.split('void Deliver(const PageOrigin& origin,', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('StillBound(origin, contents, &binding)', deliver)
        bound = share.split('ShellHostView* StillBound(const PageOrigin& origin, content::WebContents* contents, PageBinding** binding) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('found->renderer_generation == origin.generation', bound)
        self.assertIn('found->claim == origin.claim', bound)
        self.assertIn('base::BindOnce(&DeliverImage, std::move(*origin),', share)
        link = share.split('void ShareLink(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('host == &caller ? ShareableFile(link, host)', link)

    def test_file_share_lists_the_system_services(self):
        model = self.read('ac_mac_menu_model.h')
        self.assertIn('Role::kShareServices)}),', model)
        menu = self.read('ac_mac_menu.mm')
        self.assertIn('submenu.delegate = ShareMenuFiller();', menu)
        self.assertIn('ardia_mac::share::LinkServices()', menu)
        self.assertIn('menu::FillsShareServices(item.role, app_menus)', menu)
        filler = menu.split('- (void)menuNeedsUpdate:(NSMenu*)menu {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('action:@selector(openSharingSettings:)', filler)
        self.assertIn('ardia_mac::share::OpenSharingSettingsFromMenu();', menu)
        actions = (REPO / 'apps/desktop/src/appMenuActions.ts').read_text()
        self.assertIn('isMoreShareChoice(choice.command, choice.arg)', actions)
        self.assertNotIn('return;', filler)
        self.assertIn('More', filler)
        app_menu = (REPO / 'apps/desktop/src/appMenu.ts').read_text()
        self.assertIn('shareServices().map(', app_menu)

    def test_download_watch_state_exists_before_its_notifier_calls_back(self):
        source = (MAC / 'ac_mac_system.mm').read_text()
        watch = source.split('class DownloadWatch', 1)[1].split('\n};', 1)[0]
        notifier = watch.index('download::AllDownloadItemNotifier notifier_;')
        for member in ('std::map<std::string, policy::ProgressMark> marks_;',
                       'policy::ReadyQueue<base::OnceCallback<void(bool)>> ready_;', 'raw_ptr<SystemServices> owner_;'):
            self.assertLess(watch.index(member), notifier, member)

    def test_in_window_pip_is_a_native_plane_between_pages_and_the_shell(self):
        source = (MAC / 'ac_mac_pip.mm').read_text()
        self.assertIn('std::make_unique<views::NativeViewHost>()', source)
        self.assertIn('ui::RecyclableCompositorMac', source)
        self.assertNotIn('SetPaintToLayer', source)
        self.assertNotIn('AddChildViewAt(std::make_unique<views::NativeViewHost>', source)

    def test_links_are_captured_from_webui_start(self):
        start = (MAC / 'ac_mac_webui.mm').read_text().split('void StartWebUIShell() {', 1)[1]
        self.assertLess(start.index('InstallOpenUrlsHook();'), start.index('WithProfile("", base::BindOnce(&OpenLaunchWindow));'))

    def test_companion_profiles_are_watched(self):
        host = (MAC / 'ac_mac_shell_host.mm').read_text()
        member = host.split('BrowserWindowInterface* ShellHostView::EnsureMember(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('system_->SyncWatches();', member)

    def test_install_prompts_wait_for_a_live_bridge(self):
        source = (MAC / 'ac_mac_extension_view.mm').read_text()
        live = source.split('bool ExtensionViews::ShellLive() const {', 1)[1].split('\n}', 1)[0]
        self.assertIn('handler_->Live()', live)
        hook = source.split('bool InstallPromptHook(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(hook.index('ShellLive()'), hook.index('PendingInstall{std::move(*done)'))

    def test_download_membership_counts_companion_tabs(self):
        source = (MAC / 'ac_mac_system.mm').read_text()
        members = source.split('std::set<Profile*> SystemServices::MemberProfiles() const {', 1)[1].split('\n}', 1)[0]
        self.assertIn('policy::DownloadMember(member == host_->browser(), tabs)', members)

    def test_queued_links_return_to_chrome_after_the_last_window(self):
        source = (MAC / 'ac_mac_system.mm').read_text()
        teardown = source.split('SystemServices::~SystemServices() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('HandOffOpenUrls', teardown)

    def test_pip_plane_follows_display_changes(self):
        source = (MAC / 'ac_mac_pip.mm').read_text()
        for needle in ('viewDidChangeBackingProperties', 'NSWindowDidChangeScreenNotification',
                       'OnDisplayMetricsChanged', 'display.id() != display_id_', 'GetDisplayNearestPoint'):
            self.assertIn(needle, source)

    def test_round_three_contracts(self):
        system = (MAC / 'ac_mac_system.mm').read_text()
        watch_teardown = system.split('~DownloadWatch() override {', 1)[1].split('\n  }', 1)[0]
        self.assertIn('Refuse(ready_.Drop())', watch_teardown)
        going_down = system.split('void OnManagerGoingDown(content::DownloadManager*) override {', 1)[1].split('\n  }', 1)[0]
        self.assertIn('Refuse(ready_.Close())', going_down)
        self.assertNotIn('Run(true)', going_down)
        handoff = system.split('void SystemServices::HandOffOpenUrls() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('browser_shutdown::IsTryingToQuit()', handoff)
        self.assertIn('browser_shutdown::HasShutdownStarted()', handoff)
        pip = (MAC / 'ac_mac_pip.mm').read_text()
        self.assertIn('ContentSettingsType::AUTO_PICTURE_IN_PICTURE', pip)
        self.assertIn('PresentationFor(intent, presenter != nullptr, permission)', pip)
        show = pip.split('void PipPlayer::ShowInactive() {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(show.index('PermissionOf(contents)'), show.index('KeepsVisibleWindow('))
        enter = pip.split('void PipPlayer::EnterWindow(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(enter.index('window_->ShowInactive();'), enter.index('window_->GetMinimumSize()'))

    def test_page_commands_are_the_shared_handle_names(self):
        policy = self.read('ac_mac_page_policy.h')
        listed = re.findall(r'"([A-Za-z]+)"', policy.split('kPageCommands[] = {', 1)[1].split('};', 1)[0])
        handle = (REPO / 'packages/ardiacore/src/pageTypes.ts').read_text()
        handle = handle.split('export type WebViewHandle = {', 1)[1].split('\n};', 1)[0]
        methods = set(re.findall(r'^\s+(\w+)\??(?:<[^>]*>)?\(', handle, re.M))
        edit = (REPO / 'engine/ardiacore-desktop/src/ardia/desktop/ac_desktop_window_commands.h').read_text()
        self.assertIn('kEditCommand[] = "edit"', edit)
        for command in listed:
            self.assertTrue(command in methods or command == 'edit', command)
        linux = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_host.cc').read_text()
        linux += (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_page_commands.cc').read_text()
        for command in listed:
            if command != 'edit':
                self.assertIn(f'command == "{command}"', linux, command)
        host = self.read('ac_mac_shell_host.mm')
        tab = host.split('void ShellHostView::TabCommand(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(tab.index('PageCommands::Handles(command)'), tab.index('"loadUrl"'))
        self.assertIn('Failure("ERR_PAGE_STALE_TARGET", "No such live tab")', tab)

    def test_page_events_use_the_shared_event_names(self):
        events = (REPO / 'packages/ardiacore/src/pageEvents.ts').read_text()
        table = events.split('const PAGE_EVENTS = {', 1)[1].split('} as const', 1)[0]
        names = set(re.findall(r': "(\w+)"', table))
        sent = set()
        for name in ('ac_mac_page_events.mm', 'ac_mac_page_commands.mm', 'ac_mac_shell_host.mm'):
            text = self.read(name)
            sent |= set(re.findall(r'(?:Send|Report|PageEvent)\(\s*"(\w+)"', text))
            sent |= set(re.findall(r'\? "(unresponsive)" : "(responsive)"', text)[0]) if 'unresponsive' in text else set()
        sent.discard('name')
        self.assertTrue({'favicon', 'media', 'fullscreen', 'crashed', 'loadError', 'security', 'zoom', 'status',
                         'popupBlocked', 'find', 'discarded', 'unresponsive', 'responsive'} <= sent, sent)
        for name in sent:
            self.assertIn(name, names, name)
        host = self.read('ac_mac_shell_host.mm')
        self.assertIn('PageThemeColor(contents)', host)
        self.assertIn('theme ? base::Value("meta") : base::Value()', host)
        self.assertIn('void PageBinding::DidChangeThemeColor() {\n  ReportNavigation();', host)
        self.assertIn('events_->AppendSnapshot(events);', host)

    def test_page_event_payloads_match_linux(self):
        events = self.read('ac_mac_page_events.mm')
        for shape in ('.Set("playing", audible).Set("muted", muted)', '.Set("fullscreen", entered)',
                      '.Set("status", code)', '.Set("reason", page_policy::CrashReason(', '.Set("code", code)',
                      '.Set("text", net::ErrorToShortString(error))', '.Set("pinchScale", *scale)',
                      '.Set("isDefault", zoom_->IsAtDefaultZoom())', '.Set("origin", blocked->origin)',
                      '.Set("urls", std::move(urls))'):
            self.assertIn(shape, events)
        commands = self.read('ac_mac_page_commands.mm')
        for shape in ('.Set("count", std::max(0, count))', '.Set("active", std::max(0, active))',
                      '.Set("final", final)', '"data:image/png;base64,"'):
            self.assertIn(shape, commands)
        theme = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_theme.cc').read_text()
        self.assertIn('"#%02x%02x%02x"', theme)
        self.assertIn('"#%02x%02x%02x"', self.read('ac_mac_page_policy.h'))

    def test_evaluate_runs_only_the_linux_allowlist_in_an_isolated_world(self):
        copies = (ROOT / 'dev-copies.tsv').read_text()
        self.assertIn('engine/ardiacore-linux/src/ardia/linux/ac_linux_page_operations.h\t'
                      'ardia/mac/generated/ac_linux_page_operations.h', copies)
        commands = self.read('ac_mac_page_commands.mm')
        self.assertIn('page_policy::MatchOperation(code, &Sha256, Operations())', commands)
        self.assertIn('ardiacore::kLinuxPageOperations', commands)
        self.assertIn('ISOLATED_WORLD_ID_CHROME_INTERNAL', commands)
        self.assertIn('"ERR_PAGE_EVALUATION_REFUSED"', commands)
        for unsafe in ('ExecuteJavaScriptForTests', 'ExecuteJavaScript(', 'ExecuteJavaScriptMethod'):
            self.assertNotIn(unsafe, commands)
        for name in MAC.iterdir():
            if name.suffix in ('.mm', '.cc') and name.name != 'ac_mac_page_commands.mm':
                self.assertNotIn('ExecuteJavaScript', name.read_text(), name.name)

    def test_background_page_ui_is_logged_not_shown(self):
        delegate = self.read('ac_mac_page_delegate.mm')
        for kind in ('" (background run, not shown): "', '"leave-page dialog (background run, not shown): "',
                     '" file dialog (background run, not shown)"', '"page context menu (background run, not shown) at "',
                     '"permission prompt (background run, not shown): "'):
            self.assertIn(kind, delegate)
        self.assertIn('listener->FileSelectionCanceled();', delegate)
        self.assertNotIn('message_text)', delegate.split('class BackgroundDialogs', 1)[1].split('};', 1)[0]
                         .replace('const std::u16string& message_text,', ''))
        self.assertIn('g_ardia_create_web_contents_delegate = &CreatePageDelegate;', delegate)
        self.assertIn('InstallPageDelegate();', self.read('ac_mac_webui.mm'))
        commands = self.read('ac_mac_page_commands.mm')
        for refused in ('"print dialog (background run, not shown)"', '"save page dialog (background run, not shown)"',
                        '"DevTools window (background run, not shown)"'):
            self.assertIn(refused, commands)

    def test_dictation_is_advertised_and_never_starts_in_background_mode(self):
        calls = self.read('ac_mac_shell_calls.mm')
        listed = calls.split('constexpr std::string_view kCapabilities[] = {', 1)[1].split('};', 1)[0]
        self.assertIn('"ArdiaShell.startDictation",', listed)
        call = calls.split('if (method == "ArdiaShell.startDictation") {', 1)[1].split('\n  }\n', 1)[0]
        self.assertLess(call.index('if (BackgroundInstance()) {'), call.index('sendAction:@selector(startDictation:)'))
        self.assertIn('Trace("dictation (background run, not started)");', call)
        self.assertIn('dispatch_async(dispatch_get_main_queue()', call)
        self.assertIn('Reply(std::move(done), base::Value(true));', call)

    def test_window_backdrop_uses_the_treatment_vibrancy_without_a_glass_rim(self):
        calls = self.read('ac_mac_shell_calls.mm')
        listed = calls.split('constexpr std::string_view kCapabilities[] = {', 1)[1].split('};', 1)[0]
        self.assertIn('"shell.backdropRegions.windowTreatment",', listed)
        layout = self.read('ac_mac_glass_layout.h')
        self.assertIn('if (name == "windowTreatment") return Material::kWindowTreatment;', layout)
        self.assertIn('return dark ? kTreatmentMaterialDark : kTreatmentMaterialLight;', layout)
        self.assertIn('constexpr int kTreatmentMaterialDark = 29;', layout)
        self.assertIn('constexpr int kTreatmentMaterialLight = 13;', layout)
        glass = self.read('ac_mac_glass.mm')
        treatment = glass.split('- (void)applyTreatment {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('self.emphasized = self.windowTreatment;', treatment)
        self.assertIn('ardia_mac::glass::TreatmentMaterial(dark)', treatment)
        self.assertIn('[self applyTreatment];', glass.split('- (void)viewDidChangeEffectiveAppearance {', 1)[1].split('\n}\n', 1)[0])
        self.assertIn('placement.material == glass::Material::kWindowTreatment;', glass)
        swift = (REPO / 'packages/shaders/ios/WindowTreatmentView.swift').read_text()
        self.assertIn('blur.isEmphasized = true', swift)
        self.assertIn('NSVisualEffectView.Material(rawValue: dark ? 29 : 13)', swift)

    def test_asset_paths_keep_the_allowlist_every_host_shares(self):
        webui = self.read('ac_mac_webui.mm')
        valid = webui.split('bool ValidAssetPath(std::string_view path) {', 1)[1].split('\n}\n', 1)[0]
        self.assertNotIn("'@'", valid)
        self.assertIn("c == '_' || c == '-' || c == '/')) {", valid)
        self.assertIn('path.find("..") != std::string_view::npos', valid)
        self.assertIn('hostSafeFileName', (REPO / 'apps/desktop/vite.shared.ts').read_text())

    def test_help_menu_offers_show_onboarding_like_the_mac_app(self):
        model = self.read('ac_mac_menu_model.h')
        self.assertIn('submenu("Help", {command("Show Onboarding", "showOnboarding", "", 0)}, Role::kHelpMenu)', model)
        self.assertIn('CommandItem(.showOnboarding)', (REPO / 'packages/shell/ios/MainMenu.swift').read_text())

    def test_page_capabilities_and_zoom_routes_are_served(self):
        calls = self.read('ac_mac_shell_calls.mm')
        listed = calls.split('constexpr std::string_view kCapabilities[] = {', 1)[1].split('};', 1)[0]
        self.assertIn('ardia::desktop_commands::kEditCapability', listed)
        self.assertIn('for (std::string_view route : page_policy::kZoomRoutes) {', calls)
        call = calls.split('void ShellHostView::EngineCall(', 1)[1]
        self.assertLess(call.index('page_policy::IsZoomRoute(name)'), call.index('desktop_routes::FindRoute(name)'))
        linux = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_history_zoom.h').read_text()
        self.assertIn('{"sites.zoomLevels", "sites.setZoom"}', linux)
        self.assertIn('kZoomRoutes[] = {"sites.zoomLevels",\n                                                   "sites.setZoom"}',
                      self.read('ac_mac_page_policy.h'))
        self.assertIn('ac_zoom_set', (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_history_zoom.cc').read_text())

    def test_link_gestures_and_page_options_are_advertised_and_wired(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertIn('AppendLinkCapabilities(capabilities);', calls)
        call = calls.split('void ShellHostView::EngineCall(', 1)[1]
        self.assertLess(call.index('HandlesLinkRoute(name)'), call.index('desktop_routes::FindRoute(name)'))
        policy = self.read('ac_mac_link_policy.h')
        capabilities = (REPO / 'apps/desktop/src/hostCapabilities.ts').read_text()
        for route in ('setPeekOtherSiteTabs', 'setLittleArdiaOpensNewTabLinks', 'setPopupsOpenAsTabs', 'setCommandScrollZoom'):
            self.assertIn(f'"webView.{route}"', policy)
            self.assertIn(f'has("webView.{route}")', capabilities)
        page_options = (REPO / 'apps/browser/src/platform/pageOptions.ts').read_text()
        for route in ('setPeekModifier', 'setSplitLinkModifier'):
            self.assertIn(f'"webView.{route}"', policy)
            self.assertIn(f'"webView.{route}"', page_options)
        delegate = self.read('ac_mac_page_delegate.mm')
        for wired in ('InterceptLinkOpen(source, params)', 'OpeningDisposition(source, params)',
                      'PopupDisposition(source, disposition)', 'NoteLinkTarget(source, url);'):
            self.assertIn(wired, delegate)
        self.assertNotIn('CanDownload', delegate)
        add = delegate.split('content::WebContents* AddNewContents(', 1)[1].split('\n  }\n', 1)[0]
        self.assertIn('std::move(new_contents)', add)
        install = delegate.split('void InstallPageDelegate() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('InstallLinkHooks();', install)
        host = self.read('ac_mac_shell_host.mm')
        rebind = host.split('void PageBinding::Rebind(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(rebind.index('links_.reset();'), rebind.index('Observe(contents);'))
        self.assertIn('links_ = std::make_unique<PageLinks>(this, contents);', rebind)
        destructor = host.split('PageBinding::~PageBinding() {', 1)[1].split('\n}\n', 1)[0]
        self.assertTrue(destructor.lstrip().startswith('links_.reset();'))
        gesture = self.read('ac_mac_link_gesture.mm')
        self.assertIn('"openWindow"', gesture)
        self.assertNotIn('ExecuteJavaScript', gesture)
        self.assertNotIn('->Stop()', gesture)
        self.assertNotIn('DidStartNavigation', gesture)
        throttle = gesture.split('class SitePeekThrottle', 1)[1].split('\n};\n', 1)[0]
        self.assertIn('ThrottleCheckResult WillStartRequest() override', throttle)
        self.assertIn('CANCEL_AND_IGNORE : PROCEED', throttle)
        peek = gesture.split('bool PageLinks::PeeksInsteadOf(', 1)[1].split('\n}\n', 1)[0]
        for required in ('handle.WasInitiatedByLinkClick()', 'handle.NavigationInputStart()', 'handle.IsPost()',
                         'lp::TargetMatches(release.target, url.spec())', 'handle.GetInitiatorFrameToken()',
                         'main->GetGlobalFrameToken()'):
            self.assertIn(required, peek)
        self.assertNotIn('EmitDecision', peek)
        self.assertNotIn('PostTask(', gesture)
        finish = gesture.split('void PageLinks::DidFinishNavigation(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('handle->GetNavigationId() != peek_navigation_', finish)
        self.assertLess(finish.index('lp::AnnouncesSitePeek(true, handle->HasCommitted(), !contents || contents->IsBeingDestroyed())'),
                        finish.index('EmitDecision('))
        self.assertIn('kInputMatchMicros = 0;', self.read('ac_mac_link_policy.h'))
        self.assertIn('content::SetArdiaMacDownloadUrlHook(&OptionClickDownloadIntercepted);', gesture)
        self.assertIn('content::SetArdiaMacNewWindowInPlaceHook(&NoOpenerWindowOpensInPlace);', gesture)
        self.assertNotIn('g_ardia_mac_download_url', gesture)
        in_place = gesture.split('bool PageLinks::OpensInPlace(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('link.post = form_submission;', in_place)
        self.assertIn("contents->IsBeingDestroyed()", finish)
        self.assertIn("lp::AnnouncesSitePeek(", finish)
        self.assertIn('g_ardia_mac_add_navigation_throttles = &AddLinkNavigationThrottles;', gesture)
        zoom = gesture.split('void InstallCommandScrollZoom() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('event.hasPreciseScrollingDeltas', zoom)
        self.assertIn('BindingUnder(event)', zoom)
        self.assertNotIn('mouseLocation', gesture)
        apply = (ROOT / 'apply.sh').read_text()
        self.assertIn('MetricsNavigationThrottle::CreateAndAdd(registry);', apply)
        self.assertIn('g_ardia_mac_add_navigation_throttles(registry);', apply)
        self.assertIn('network::mojom::RedirectMode::kFollow', apply)
        self.assertIn('blink_parameters->suggested_name.has_value()', apply)
        self.assertIn('params.is_form_submission || params.form_submission_post_data', apply)
        self.assertIn('FastHasAttribute(html_names::kDownloadAttr)', apply)

    def test_background_permission_prompts_get_a_nonvisual_prompt_after_ardiacore(self):
        delegate = self.read('ac_mac_page_delegate.mm')
        prompt = delegate.split('class BackgroundPermissionPrompt', 1)[1].split('\n};\n', 1)[0]
        self.assertIn('weak_factory_.GetWeakPtr()', prompt)
        self.assertIn('delegate_->GetCurrentPrompt() != this || delegate_->Requests().empty()', prompt)
        self.assertIn('PermissionPromptDisposition::NONE_VISIBLE', prompt)
        self.assertNotIn('delegate->GetWeakPtr()', delegate)
        self.assertIn('return std::make_unique<BackgroundPermissionPrompt>(delegate);', delegate)
        self.assertIn('page_policy::PromptHandlingFor(BackgroundInstance()', delegate)
        install = delegate.split('void InstallPageDelegate() {', 1)[1].split('\n}\n', 1)[0]
        self.assertEqual(install.count('PostTask('), 2)
        self.assertIn('base::BindOnce(&AssertPageHooks)', install)
        host = self.read('ac_mac_shell_host.mm')
        create = host.split('void ShellHostView::CreateTabIn(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(create.index('AssertPageHooks();'), create.index('shell_policy::PlanCreate(request)'))
        engine = (REPO / 'engine/ardiacore/src/ardia/core/ac_main_delegate.cc').read_text()
        self.assertIn('base::BindOnce(&OnEngineStarted)', engine)

    def test_discard_and_freeze_read_the_real_prompt_and_edit_state(self):
        commands = self.read('ac_mac_page_commands.mm')
        protection = commands.split('page_policy::Protection PageCommands::CurrentProtection() const {', 1)[1]
        protection = protection.split('\n}\n', 1)[0]
        for check in ('requests->IsRequestInProgress()', 'requests->has_pending_requests()',
                      'dialogs->IsDialogActive()', 'UnsavedInputOf(contents)', 'IsCapturingUserMedia(contents)',
                      'PictureInPictureWindowManager::GetInstance()->GetWebContents() == contents',
                      'content::Visibility::VISIBLE'):
            self.assertIn(check, protection)
        self.assertNotIn('pending_prompt = false', commands)
        unsaved = commands.split('std::optional<bool> UnsavedInputOf(', 1)[1].split('\n}\n', 1)[0]
        for check in ('ForEachRenderFrameHost', 'HadFormInteraction()', 'HadUserEdits()', 'page_policy::UnsavedInput('):
            self.assertIn(check, unsaved)

    def test_bindings_follow_replacement_and_leave_with_their_tab(self):
        host = self.read('ac_mac_shell_host.mm')
        changed = host.split('void ShellHostView::OnTabStripModelChanged(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('TabStripModelChange::kReplaced', changed)
        self.assertIn('ReplaceBinding(replace->old_contents, replace->new_contents);', changed)
        self.assertIn('&ShellHostView::DropDetachedBinding', changed)
        self.assertIn('TabRemovedReason::kDeleted', changed)
        replace = host.split('void ShellHostView::ReplaceBinding(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(replace.index('binding->Envelope("pageLifecycle")'), replace.index('binding->Rebind(contents);'))
        self.assertLess(replace.index('binding->Rebind(contents);'), replace.index('binding->binding_generation = *generation;'))
        self.assertIn('delivery.Set("action", "rebind");', replace)
        self.assertIn('Emit("ArdiaWebView", base::NumberToString(old_id)', replace)
        self.assertNotIn('ReportClosed', replace)
        self.assertIn('page_policy::RebindAllowed(', replace)
        drop = host.split('void ShellHostView::DropDetachedBinding(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('page_policy::StripExitFor(false, OwnerOf(contents.get()) != nullptr)', drop)
        self.assertNotIn('ReportClosed', drop)
        self.assertIn('.Set("bindingGeneration", base::NumberToString(binding_generation))', host)
        self.assertNotIn('"bindingGeneration", "1"', host)
        events = (REPO / 'apps/desktop/src/hostPageEvents.ts').read_text()
        self.assertIn('if (value.action === "rebind") return rebinding(value.creation);', events)

    def test_blocked_popups_clear_on_cross_document_commits(self):
        events = self.read('ac_mac_page_events.mm')
        finish = events.split('void PageEvents::DidFinishNavigation(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(finish.index('page_policy::ClearsBlockedPopups('), finish.index('blocked_.clear();'))
        self.assertIn('page_policy::kSnapshotEventsMax', events)

    def test_history_offsets_are_checked_in_64_bits(self):
        commands = self.read('ac_mac_page_commands.mm')
        offset = commands.split('if (command == "goToOffset") {', 1)[1].split('if (command == "evaluate")', 1)[0]
        self.assertLess(offset.index('page_policy::HistoryTarget('), offset.index('controller.CanGoToOffset('))
        self.assertIn('static_cast<int64_t>(current) + static_cast<int64_t>(offset)', self.read('ac_mac_page_policy.h'))

    def test_promise_operations_are_polled_with_a_host_token(self):
        commands = self.read('ac_mac_page_commands.mm')
        self.assertIn('page_policy::AwaitsResult(*match->operation)', commands)
        self.assertIn('SendEvaluation(id, page_policy::TakeEvaluation(id));', commands)
        self.assertIn('base::Milliseconds(page_policy::kEvaluationPollMilliseconds)', commands)
        self.assertNotIn('kEvaluationPollAttempts', commands)
        answered = commands.split('void PageCommands::EvaluationAnswered(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(answered.index('evaluations_.find(id)'), answered.index('page_policy::NextEvaluationStep('))

    def test_evaluations_have_a_wall_clock_deadline_and_settle_once(self):
        commands = self.read('ac_mac_page_commands.mm')
        evaluate = commands.split('void PageCommands::Evaluate(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('pending->deadline.Start(', evaluate)
        self.assertIn('base::Milliseconds(page_policy::kEvaluationDeadlineMilliseconds)', evaluate)
        self.assertLess(evaluate.index('pending->deadline.Start('), evaluate.index('SendEvaluation(id'))
        settle = commands.split('void PageCommands::SettleEvaluation(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(settle.index('evaluations_.erase(found);'), settle.index('std::move(pending->done).Run('))
        self.assertIn('page_policy::ForgetEvaluation(id)', settle)
        send = commands.split('void PageCommands::SendEvaluation(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('weak_factory_.GetWeakPtr()', send)
        policy = self.read('ac_mac_page_policy.h')
        self.assertIn('kEvaluationSlotTtlMilliseconds = 6000', policy)
        self.assertIn('setTimeout(() => { if (ardiaSlots.get(', policy)
        self.assertIn('!ardiaSlot.pending || ardiaSlots.get(', policy)

    def test_evaluations_belong_to_the_binding_that_asked(self):
        commands = self.read('ac_mac_page_commands.mm')
        frame = commands.split('content::RenderFrameHost* PageCommands::EvaluationFrame(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('Live() == pending.contents.get()', frame)
        document = commands.split('content::RenderFrameHost* PageCommands::EvaluationDocument(', 1)[1].split('\n}\n', 1)[0]
        self.assertNotRegex(document, r'\bLive\(\)')
        settle = commands.split('void PageCommands::SettleEvaluation(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('EvaluationDocument(*pending)', settle)
        reset = commands.split('void PageCommands::Reset() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('CancelEvaluations();', reset)
        host = self.read('ac_mac_shell_host.mm')
        release = host.split('void ShellHostView::ReleaseTab(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('binding->commands()->CancelEvaluations();', release)
        retire = host.split('void ShellHostView::RetireRenderer() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('binding->commands()->CancelEvaluations();', retire)
        create = host.split('void ShellHostView::CreateTabIn(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(create.index('existing->commands()->CancelEvaluations();'), create.index('existing->claim = claim;'))
        rebind = host.split('void PageBinding::Rebind(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('commands_->Reset();', rebind)

    def test_discard_reads_the_outcome_through_the_surviving_binding(self):
        commands = self.read('ac_mac_page_commands.mm')
        discard = commands.split('void PageCommands::Discard(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('alive_factory_.GetWeakPtr()', discard)
        self.assertIn('alive->binding_->contents()', discard)
        self.assertIn('page_policy::DiscardSucceeded(', discard)
        self.assertNotIn('contents->GetWeakPtr()', discard)
        host = self.read('ac_mac_shell_host.mm')
        rebind = host.split('void PageBinding::Rebind(', 1)[1].split('\n}\n', 1)[0]
        self.assertNotIn('commands_.reset()', rebind)
        self.assertNotIn('commands_ = ', rebind)
        self.assertIn('base::WeakPtrFactory<PageCommands> alive_factory_{this};', self.read('ac_mac_page_commands.h'))

    def test_playback_protection_reads_the_live_media_session(self):
        events = self.read('ac_mac_page_events.mm')
        playing = events.split('bool PageEvents::playing() const {', 1)[1].split('\n}\n', 1)[0]
        for check in ('content::MediaSession::GetIfExists(contents)', 'GetMediaSessionInfoSync()',
                      'GetCurrentlyPlayingVideoCount() > 0', 'page_policy::SessionPlaying(',
                      'MediaPlaybackState::kPlaying', 'SessionState::kInactive'):
            self.assertIn(check, playing)
        linux = (REPO / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_page_media.cc').read_text()
        self.assertIn('info->playback_state == media_session::mojom::MediaPlaybackState::kPlaying', linux)

    def test_each_window_boots_as_its_own_kind(self):
        calls = self.read('ac_mac_shell_calls.mm')
        boot = calls.split('std::string ShellHostView::BootstrapJson() const {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('bootstrap.Set("startup", startup_);', boot)
        self.assertIn('bootstrap.Set("windowKind", kind_);', boot)
        self.assertIn('bootstrap.Set("pageProfile", page_profile_);', boot)
        self.assertIn('bootstrap.Set("utility", utility_.Clone());', boot)
        desktop = (REPO / 'apps/desktop/src/utilityNavigation.ts').read_text()
        self.assertIn('"ArdiaShell.utilityReady"', desktop)
        self.assertIn('event !== "onUtilityNavigation"', desktop)

    def test_native_traffic_lights_replace_drawn_window_buttons(self):
        calls = self.read('ac_mac_shell_calls.mm')
        self.assertIn('.Set("layout", "")', calls)
        host = self.read('ac_mac_shell_host.mm')
        lights = host.split('void ShellHostView::SetTrafficLights(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ShellZoom());', lights.split('window::LightsFrom(', 1)[1])
        chrome = (REPO / 'apps/browser/src/lib/platformChrome.mac.ts').read_text()
        self.assertIn('export { applyWindowButtonStyle, WINDOW_BUTTON_STYLES, WINDOW_CHROME } from "./platformChrome.ts";', chrome)
        lights = (REPO / 'apps/desktop/src/nativeTrafficLights.ts').read_text()
        self.assertIn('export const NATIVE_TRAFFIC_LIGHTS = "shell.trafficLights";', lights)

    def test_open_window_is_served_advertised_and_checked_first(self):
        calls = self.read('ac_mac_shell_calls.mm')
        listed = calls.split('constexpr std::string_view kCapabilities[] = {', 1)[1].split('};', 1)[0]
        for method in ('ArdiaShell.openWindow', 'ArdiaShell.focusWindow', 'ArdiaShell.windowIds'):
            self.assertIn(f'"{method}"', listed)
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        ready = lifecycle.split('if (method == "ArdiaShell.utilityReady") {', 1)[1].split('\n  }\n', 1)[0]
        self.assertIn('utility_ready_ = true;', ready)
        self.assertIn('utility_.Clone()', ready)
        ends = lifecycle.split('bool ShellHostView::ClosingEndsSession() const {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('host->is_utility()', ends)
        self.assertLess(ends.index('if (is_utility()) {'), ends.index('for (const ShellHostView* host : Hosts())'))
        self.assertIn('return OpenWindow(values, std::move(done));', calls)
        host = self.read('ac_mac_shell_host.mm')
        opening = host.split('void ShellHostView::OpenWindow(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(opening.index('shell_policy::CheckWindowRequest('), opening.index('HostForWindow(id)'))
        self.assertLess(opening.index('HostForWindow(id)'), opening.index('OpenShellWindow('))
        self.assertIn('existing->NavigateUtility(std::move(place));', opening)
        self.assertIn('existing->ActivateWindow();', opening)
        self.assertIn('Emit("ArdiaShell", "onUtilityNavigation"', host)
        entry = self.read('ac_mac_webui.mm')
        self.assertIn('ShellHostView* OpenShellWindow(Profile* profile,', entry)
        self.assertIn('OpenShellWindow(profile, std::move(spec), launch.frame);', entry)

    def test_page_glass_sits_between_the_pages_and_the_shell(self):
        glass = self.read('ac_mac_glass.mm')
        self.assertNotIn('page_slots', glass)
        self.assertNotIn('[host addSubview:', glass)
        mount = glass.split('bool GlassRegions::MountUnderShell(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('under_shell_->layer()', mount)
        self.assertIn('SetBackgroundBlur(', mount)
        self.assertIn('SetMasksToBounds(true)', mount)
        relayout = glass.split('glass::Layout GlassRegions::Relayout() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('glass::MountsUnderShell(placement.plane)', relayout)
        self.assertIn('[frame addSubview:views_->behind positioned:NSWindowBelow relativeTo:content];', relayout)
        host = self.read('ac_mac_shell_host.mm')
        restack = host.split('void ShellHostView::Restack() {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(restack.index('ReorderChildView(under_shell_, children().size());'),
                        restack.index('ReorderChildView(shell_, children().size());'))
        self.assertIn('under_shell_->SetPaintToLayer(ui::LAYER_NOT_DRAWN);', host)
        self.assertIn('browser_view_->GetWidget(), under_shell_.get(),', host)

    def test_recording_hands_key_equivalents_to_the_shell(self):
        host = self.read('ac_mac_shell_host.mm')
        record = host.split('void ShellHostView::WatchRecordedKeys(bool recording) {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown', record)
        self.assertIn('shell_policy::RecordingRouteFor(', record)
        self.assertIn('return nil;', record)
        self.assertIn('ForwardKeyboardEvent(event)', host)
        keys = host.split('bool ShellHostView::HandleKeyboardEvent(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(keys.index('shortcut_recording_ && source == shell_contents()'), keys.index('unhandled_keys_'))
        keyboard = self.read('ac_mac_shell_lifecycle.mm').split('void ShellHostView::KeyboardCall(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(keyboard.index('focus_manager_->set_shortcut_handling_suspended(on);'), keyboard.index('WatchRecordedKeys(on);'))
        self.assertIn('recording_keys_.reset();', host.split('void ShellHostView::RetireRenderer() {', 1)[1].split('\n}\n', 1)[0])

    def test_released_tabs_take_their_glass_with_them(self):
        host = self.read('ac_mac_shell_host.mm')
        release = host.split('void ShellHostView::ReleaseTab(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(release.index('binding->viewport->SetVisible(false);'), release.index('UpdateGlassSurface();'))
        glass = self.read('ac_mac_glass.mm')
        relayout = glass.split('glass::Layout GlassRegions::Relayout() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('return !page_rects.contains(entry.first.page);', relayout)

    def test_session_writes_merge_and_reach_every_window(self):
        host = self.read('ac_mac_shell_host.mm')
        write = host.split('void ShellHostView::WriteSession(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(write.index('ardia::ValidLinuxSession(*base)'), write.index('SessionFiles()'))
        self.assertIn('window_policy::ClosePhase::kAcknowledged', write)
        self.assertIn('BroadcastSession(merged, window, &source);', write)
        calls = self.read('ac_mac_shell_calls.mm')
        merge = calls.split('MergedSession MergeAndWriteSession(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(merge.index('ReadSessionForMerge()'), merge.index('shell_policy::SessionWritable(read.load)'))
        self.assertLess(merge.index('result.blocked = true;'), merge.index('ardia::MergeLinuxSession(base, local, result.previous)'))
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        ack = lifecycle.split('void ShellHostView::AcknowledgeWindowClose(', 1)[1].split('\n}\n', 1)[0]
        commit = lifecycle.split('void ShellHostView::CommitHeldDeparture() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('base::BindOnce(&MergeAndWriteSession, std::move(departure.base), std::move(departure.session))', commit)
        self.assertIn('BroadcastSession(merged, window, nullptr);', commit)
        self.assertNotIn('WriteSessionInBackground', lifecycle)
        broadcast = calls.split('void BroadcastSession(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('for (ShellHostView* host : Hosts())', broadcast)
        self.assertIn('host->Emit("ArdiaHost", "session",', broadcast)
        self.assertIn('return WriteSession(args, std::move(done));', calls)
        copies = (ROOT / 'dev-copies.tsv').read_text()
        self.assertIn('engine/ardiacore-linux/src/ardia/linux/ac_linux_session.cc\tardia/mac/shared/ac_linux_session.cc', copies)
        gn = (MAC / 'BUILD.gn').read_text()
        self.assertIn('public_deps = [ ":session" ]', gn)
        self.assertIn('"-Wno-range-loop-bind-reference"', gn)
        desktop = (REPO / 'apps/desktop/src/hostSession.ts').read_text()
        self.assertIn('module !== "ArdiaHost" || event !== "session"', desktop)

    def test_shortcuts_beat_chromiums_own_table_but_leave_caret_keys_to_text(self):
        host = self.read('ac_mac_shell_host.mm')
        table = host.split('void ShellHostView::SetKeyboardShortcuts(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('shell_policy::ShortcutTimingFor(', table)
        self.assertIn('binding.FindBool("notInText")', table)
        self.assertIn('ui::AcceleratorManager::kHighPriority', table)
        self.assertIn('ui::AcceleratorManager::kNormalPriority', table)
        mac = (REPO / 'apps/desktop/src/platform/shortcutKeys.mac.ts').read_text()
        self.assertIn('command: 16, control: 4', mac)
        self.assertIn('export const COMMAND_PRESSED = (event: Pick<KeyboardEvent, "ctrlKey" | "metaKey">) => event.metaKey;', mac)
        desktop = (REPO / 'apps/desktop/src/platform/shortcutKeys.desktop.ts').read_text()
        self.assertIn('command: 4, control: 16', desktop)

    def test_the_dev_app_carries_ardias_icon(self):
        assemble = (ROOT / 'assemble.sh').read_text()
        self.assertIn('<key>CFBundleIconFile</key><string>AppIcon</string>', assemble)
        self.assertIn('iconutil -c icns "$iconset" -o "$app/Contents/Resources/AppIcon.icns"', assemble)
        self.assertIn("trap 'rm -rf \"$scratch\"' EXIT", assemble)
        self.assertLess(assemble.index('trap '), assemble.index('iconutil -c icns'))
        icons = REPO / 'apps/browser/macos/Ardia-macOS/Assets.xcassets/AppIcon.appiconset'
        self.assertIn('apps/browser/macos/Ardia-macOS/Assets.xcassets/AppIcon.appiconset', assemble)
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                self.assertTrue((icons / f'icon_{size}x{size}_{scale}x.png').is_file(), f'{size}@{scale}x')

    def test_session_quarantine_shares_the_session_runner_and_never_clobbers(self):
        calls = self.read('ac_mac_shell_calls.mm')
        reader = calls.split('SessionRead ReadSessionForMerge() {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(reader.index('base::GetFileSize(path)'), reader.index('ReadFileToStringWithMaxSize'))
        self.assertIn('ardia::ValidLinuxSession(parsed->GetDict())', reader)
        self.assertIn('shell_policy::SessionLoadFor(file, moved)', reader)
        aside = calls.split('bool MoveSessionAside(const base::FilePath& path) {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(aside.index('base::PathExists(backup)'), aside.index('base::Move(path, backup)'))
        self.assertIn('shell_policy::SetAsideSessionName(now, attempt)', aside)
        self.assertIn('return false;', aside)
        self.assertIn('return SessionFiles();', calls.split('scoped_refptr<base::SequencedTaskRunner> FileRunner() {', 1)[1].split('\n}\n', 1)[0])
        entry = self.read('ac_mac_webui.mm')
        request = entry.split('void StartDataRequest(', 1)[1].split('\n  }\n', 1)[0]
        self.assertIn('webui_policy::ReadsSession(path)', request)
        self.assertIn('scoped_refptr<base::TaskRunner>(SessionFiles())', request)
        self.assertIn('constexpr bool ReadsSession(std::string_view asset) {', self.read('ac_mac_webui_policy.h'))

    def test_departures_are_saved_only_after_chromium_closes_the_window(self):
        lifecycle = self.read('ac_mac_shell_lifecycle.mm')
        ack = lifecycle.split('void ShellHostView::AcknowledgeWindowClose(', 1)[1].split('\n}\n', 1)[0]
        self.assertNotIn('MergeAndWriteSession', ack)
        self.assertNotIn('BroadcastSession', ack)
        self.assertLess(ack.index('held_departure_ = HeldDeparture{'), ack.rindex('CloseAcknowledgedWindow(*identity);'))
        cancel = lifecycle.split('void ShellHostView::CancelWindowClose(', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(cancel.index('held_departure_.reset();'), cancel.index('if (!close_.Cancel(identity)) {'))
        commit = lifecycle.split('void ShellHostView::CommitHeldDeparture() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('shell_policy::DepartureStepFor(held, close_.phase() == window_policy::ClosePhase::kClosing,', commit)
        self.assertLess(commit.index('base::BindOnce(&MergeAndWriteSession'), commit.index('BroadcastSession(merged, window, nullptr);'))
        detach = self.read('ac_mac_shell_host.mm').split('void ShellHostView::DetachBrowser() {', 1)[1].split('\n}\n', 1)[0]
        self.assertLess(detach.index('CommitHeldDeparture();'), detach.index('RetireRenderer();'))

    def test_new_windows_take_their_frame_focus_behind_and_maximized(self):
        host = self.read('ac_mac_shell_host.mm')
        opening = host.split('void ShellHostView::OpenWindow(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('options->FindList("frame")', opening)
        self.assertIn('window_policy::FrameFrom(', opening)
        self.assertIn('window::PlacedOnScreens(', opening)
        self.assertIn('placement.focus = !options || options->FindBool("focus").value_or(true);', opening)
        self.assertIn('options->FindBool("maximized")', opening)
        self.assertIn('options->FindString("behind")', opening)
        self.assertIn('placement)) {', opening)
        entry = self.read('ac_mac_webui.mm')
        self.assertIn('window::PresentationForOpen(', entry)
        window = self.read('ac_mac_window.mm').split('void ShowWithoutActivating(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('widget->ShowInactive();', window)
        self.assertIn('orderWindow:NSWindowBelow relativeTo:behind_window.windowNumber', window)
    def test_download_entry_point_refuses_through_one_route(self):
        system = (MAC / 'ac_mac_system.mm').read_text()
        call = system.split('void SystemServices::DownloadsCall(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('policy::RouteDownloadRequest(', call)
        self.assertIn('RefuseQueued(std::move(done))', call)
        self.assertNotIn('ERR_PROFILE_UNAVAILABLE', system.split('void SystemServices::EngineCall(', 1)[1].split('\n}\n', 1)[0])

    def test_no_unbounded_integer_narrowing(self):
        for path in MAC.glob('*.mm'):
            self.assertNotIn('std::lround(', path.read_text(), path.name)


class SwipeContractTests(unittest.TestCase):
    def setUp(self):
        self.source = (MAC / 'ac_mac_swipe.mm').read_text()

    def test_the_scroll_monitor_is_scoped_to_its_window_and_removed_with_it(self):
        self.assertIn('addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel', self.source)
        self.assertNotIn('addGlobalMonitorForEvents', self.source)
        handle = self.source.split('bool Handle(NSEvent* event) {', 1)[1].split('\n  }\n', 1)[0]
        self.assertIn('event.window != own', handle)
        teardown = self.source.split('ScrollGestures::~ScrollGestures() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('[NSEvent removeMonitor:state_->monitor]', teardown)
        self.assertLess(teardown.index('removeMonitor'), teardown.index('InvalidateWeakPtrs'))
        self.assertIn('state_->watch->Stop()', teardown)

    def test_phases_come_from_appkit_not_timers(self):
        for needle in ('event.phase', 'event.momentumPhase', 'event.hasPreciseScrollingDeltas',
                       'event.scrollingDeltaX', 'event.scrollingDeltaY', 'event.timestamp'):
            self.assertIn(needle, self.source)
        for banned in ('NSTimer', 'PostDelayedTask', 'dispatch_after', 'performSelector'):
            self.assertNotIn(banned, self.source)

    def test_chrome_history_swiping_is_off_for_hosted_and_shell_contents(self):
        self.assertIn('history_swiper::HistorySwipingControl::CreateForWebContents', self.source)
        hit = self.source.split('Hit HitAt(NSEvent* event) const {', 1)[1].split('\n  }\n', 1)[0]
        self.assertEqual(hit.count('KeepChromeHistorySwiperOff('), 2)
        build = (MAC / 'BUILD.gn').read_text()
        self.assertIn('"//chrome/browser/renderer_host:history_swiping_control"', build)

    def test_page_swipes_follow_the_page_ack_and_system_setting(self):
        start = self.source.split('void StartPage(const Hit& hit, NSEvent* event) {', 1)[1].split('\n  }\n', 1)[0]
        for needle in ('NSEvent.isSwipeTrackingFromScrollEventsEnabled', 'binding->presented', 'binding->visible',
                       'watch->Watch(contents, view->GetRenderWidgetHost())',
                       'page.Begin(enabled, ++next_gesture, EventMicros(ui::EventTimeStampFromSeconds(event.timestamp)))'):
            self.assertIn(needle, start)
        self.assertIn('blink::mojom::GestureDevice::kTouchpad', self.source)
        self.assertIn('InertialPhaseState::kMomentum', self.source)
        self.assertIn('RenderWidgetHostDestroyed', self.source)
        self.assertIn('contents->ForEachRenderFrameHost(', self.source)
        watch = self.source.split('class PageWatch', 1)[1].split('\n};\n', 1)[0]
        for needle in ('public content::WebContentsObserver', 'void RenderFrameCreated(', 'void RenderFrameHostChanged(',
                       'void PrimaryPageChanged(content::Page& page) override { Lost(); }', 'void WebContentsDestroyed() override { Lost(); }'):
            self.assertIn(needle, watch)
        self.assertNotIn('kWidgetsMax', self.source)
        self.assertIn('(time - base::TimeTicks()).InMicroseconds()', self.source)
        self.assertIn('EventMicros(ui::EventTimeStampFromSeconds(event.timestamp))', self.source)
        self.assertIn('"//ui/events:events_base"', (MAC / 'BUILD.gn').read_text())
        ack = self.source.split('void OnInputEventAck(', 1)[1].split('\n  }\n', 1)[0]
        self.assertIn('sp::AckEvent{ack, time, &host == main_}', ack)

    def test_only_tracked_page_motion_is_swallowed(self):
        gesture = self.source.split('bool PageGesture(', 1)[1].split('\n  }\n', 1)[0]
        self.assertEqual(gesture.count('return page.Swallows();'), 1)
        self.assertIn('case sp::Phase::kChanged:\n        Scroll(dx, dy);\n        return page.Swallows();', gesture)
        handle = self.source.split('bool Handle(NSEvent* event) {', 1)[1].split('\n  }\n', 1)[0]
        shell = handle.split('if (route == sp::Route::kShell) {', 1)[1].split('}', 1)[0]
        self.assertIn('return false;', shell)

    def test_the_host_builds_tears_down_and_advertises_the_bridge(self):
        lifecycle = (MAC / 'ac_mac_shell_lifecycle.mm').read_text()
        start = lifecycle.split('void ShellHostView::StartLifecycle() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('scroll_gestures_ = std::make_unique<ScrollGestures>(this, widget);', start)
        stop = lifecycle.split('void ShellHostView::StopLifecycle() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('scroll_gestures_.reset();', stop)
        calls = (MAC / 'ac_mac_shell_calls.mm').read_text()
        self.assertIn('ScrollGestures::AppendCapabilities(capabilities);', calls)
        policy = (MAC / 'ac_mac_swipe_policy.h').read_text()
        swipe = (REPO / 'apps/desktop/src/shims/web/motion/swipe.ts').read_text()
        for name in ('onScrollGesture', 'onPageSwipe', 'shell.scrollGestures'):
            self.assertIn(f'"{name}"', policy)
            self.assertIn(f'"{name}"', swipe)

    def test_a_page_gesture_stays_bound_to_its_tab_document_and_widget(self):
        live = self.source.split('bool PageLive() const {', 1)[1].split('\n  }\n', 1)[0]
        for needle in ('host->bindings_.find(page_binding)', 'binding->binding_generation != page_generation',
                       'binding->key() != page_key', '!binding->presented', '!binding->visible',
                       'page_document.AsRenderFrameHostIfValid()', 'contents->GetPrimaryMainFrame()',
                       'view->GetRenderWidgetHost() == watch->host()'):
            self.assertIn(needle, live)
        for name in ('void Scroll(double dx, double dy) {', 'void Acknowledged(const sp::AckEvent& ack) {', 'bool Claim(const base::DictValue& args) {'):
            body = self.source.split(name, 1)[1].split('\n  }\n', 1)[0]
            self.assertIn('KeepPage()', body, name)
        forward = self.source.split('void ForwardPage(', 1)[1].split('\n  }\n', 1)[0]
        self.assertIn('.Set("tabId", page_key)', forward)
        self.assertIn('.Set("gesture"', forward)
        host = (MAC / 'ac_mac_shell_host.mm').read_text()
        reattach = host.split('void ShellHostView::ReattachViewports() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('scroll_gestures_->Revalidate();', reattach)
        gone = host.split('void ShellHostView::BindingGone(PageBinding* binding) {', 1)[1].split('\n}', 1)[0]
        self.assertIn('scroll_gestures_->Revalidate();', gone)
        self.assertGreaterEqual(host.count('scroll_gestures_->Revalidate();'), 4)

    def test_the_shell_claims_a_page_swipe_before_the_host_swallows_it(self):
        calls = (MAC / 'ac_mac_shell_calls.mm').read_text()
        self.assertIn('if (scroll_gestures_ && ScrollGestures::Handles(method)) {', calls)
        claim = self.source.split('bool Claim(const base::DictValue& args) {', 1)[1].split('\n  }\n', 1)[0]
        for needle in ('sp::GestureId(args.FindDouble("gesture"))', 'args.FindString("tabId")', 'args.FindBool("claimed")',
                       '*tab != page_key', 'page.Claim(*gesture, *claimed)'):
            self.assertIn(needle, claim)
        policy = (MAC / 'ac_mac_swipe_policy.h').read_text()
        swallows = policy.split('bool Swallows() const {', 1)[1].split('\n  }', 1)[0]
        self.assertIn('claimed_', swallows)
        self.assertIn('HorizontalIntent(', swallows)

    def test_a_retargeted_or_deactivated_gesture_cancels_the_route_it_left(self):
        handle = self.source.split('bool Handle(NSEvent* event) {', 1)[1].split('\n  }\n', 1)[0]
        self.assertIn('Abandon(routes.TakeAbandoned(), event.timestamp);', handle)
        start = self.source.split('ScrollGestures::ScrollGestures(', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('NSWindowDidResignKeyNotification', start)
        self.assertIn('NSApplicationDidResignActiveNotification', start)
        self.assertIn('state->Interrupt();', start)
        teardown = self.source.split('ScrollGestures::~ScrollGestures() {', 1)[1].split('\n}', 1)[0]
        self.assertIn('removeObserver:observer', teardown)
        self.assertLess(teardown.index('removeObserver:observer'), teardown.index('InvalidateWeakPtrs'))


class BoundaryTests(unittest.TestCase):
    def test_every_bridge_handler_has_a_boundary_row(self):
        import json
        rows = json.loads((REPO / 'apps/browser/src/boundaries.json').read_text())['rows']
        mac = [row for row in rows if any('scripts/mac/webui-engine' in check for check in row.get('checks', []))]
        guards = ' '.join(row['guard'] for row in mac)
        for method in ('shell.glassRegions', 'shell.backdropRegions', 'shell.trafficLights', 'shell.popover.open',
                       'ArdiaTabs.unclaimedTabs', 'adoptId',
                       'shell.popover.update', 'shell.popover.close', 'ArdiaShell.setMainMenu',
                       'ArdiaShell.setMenuState', 'ArdiaShell.setMenuBookmarks', 'shell.popover.props',
                       'ArdiaShell.setShortcutRecording',
                       'shell.showContextMenu', 'ardiaRequest', 'ArdiaShell.captionDoubleClick',
                       'session.write', 'ArdiaShell.writeDocument', 'ArdiaApp.share', 'ArdiaApp.shareVia',
                       'ArdiaApp.shareText', 'ArdiaSharedFolders.apply', 'ArdiaSharedFolders.read',
                       'ArdiaSharedFolders.watch', 'ArdiaShell.pickFolder', 'tab.command', 'evaluate',
                       'sites.setZoom', 'sites.zoomLevels', 'downloadImage', 'openBlockedPopup', 'background runs',
                       'ArdiaShell.openWindow', 'MergeLinuxSession',
                       'downloads.remove', 'downloads.clear', 'ArdiaSystem.openFile', 'ArdiaApp.openExternalURL',
                       'application:openURLs:', 'ArdiaShell.listenForOpenURLs', 'extensionView.create',
                       'extensions.resolveInstallPrompt', 'executeExtensionAction', 'pip.command',
                       'webView.setAutoPictureInPicture', 'onScrollGesture', 'onPageSwipe', 'shell.pageSwipeClaim'):
            self.assertIn(method, guards)
        cited = {check.split('#', 1)[0] for row in mac for check in row['checks']}
        for test in ('glass_layout_test.cc', 'popover_policy_test.cc', 'menu_window_test.cc', 'launch_args_test.cc',
                     'hostile_corpus_test.cc', 'shell_policy_test.cc', 'page_policy_test.cc', 'system_policy_test.cc',
                     'extension_view_policy_test.cc', 'pip_policy_test.cc', 'share_policy_test.cc',
                     'shared_folders_policy_test.cc', 'swipe_policy_test.cc'):
            self.assertIn(f'scripts/mac/webui-engine/tests/{test}', cited)


class HardRuleTests(unittest.TestCase):
    COMMENT = re.compile(r'(^|[^:"\'])//(?!/)|/\*')

    def strip_strings(self, line):
        return re.sub(r'"(?:[^"\\]|\\.)*"', '""', re.sub(r"'(?:[^'\\]|\\.)'", "''", line))

    def test_no_comments_in_sources(self):
        allowed = ('// nogncheck',)
        for path in sorted([*MAC.iterdir(), *TESTS.glob('*.cc'), *TESTS.glob('*.h'), *(ROOT / 'launcher').iterdir()]):
            if path.suffix not in ('.h', '.mm', '.cc', '.c', '.gn'):
                continue
            for number, line in enumerate(path.read_text().splitlines(), 1):
                stripped = self.strip_strings(line)
                if path.suffix == '.gn':
                    self.assertNotIn('#', stripped, f'{path.name}:{number}')
                    continue
                if any(token in line for token in allowed):
                    continue
                self.assertIsNone(self.COMMENT.search(stripped), f'{path.name}:{number}: {line}')

    def test_no_comments_in_scripts(self):
        for path in sorted([*ROOT.glob('*.sh'), *TESTS.glob('*.py')]):
            lines = path.read_text().splitlines()
            for number, line in enumerate(lines, 1):
                if number == 1 and line.startswith('#!'):
                    continue
                self.assertFalse(line.lstrip().startswith('#') and not line.lstrip().startswith('#!'),
                                 f'{path.name}:{number}: {line}')


if __name__ == '__main__':
    unittest.main()
