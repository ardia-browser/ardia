import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
LINUX = SOURCE / 'ardia/linux'
REPO = ROOT.parents[1]

CALL = 'ardia::linux_window_picture::kSnapshotCall'


def host_source():
    return (LINUX / 'ac_linux_host.cc').read_text()


class WindowSnapshotTests(unittest.TestCase):
    def handler(self):
        host = host_source()
        start = f'if (method == {CALL}) {{'
        if start not in host:
            self.fail('the Linux host serves no ArdiaApp.devSnapshotWindow')
        body = host[host.index(start):]
        return body[:body.index('if (method == "ArdiaShell.windowFrame" ||')]

    def test_the_request_is_parsed_exactly_and_only_an_absolute_file_path_is_taken(self):
        with tempfile.TemporaryDirectory(prefix='ardia-window-picture-') as directory:
            binary = Path(directory) / 'window-picture'
            subprocess.run([os.environ.get('CXX', 'c++'), '-std=c++20', '-Wall', '-Wextra', '-Werror', '-g',
                            '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-I', str(SOURCE),
                            str(ROOT / 'tests/window_picture_test.cc'), '-o', str(binary)],
                           check=True, text=True, timeout=180)
            result = subprocess.run([str(binary)], text=True, timeout=60, capture_output=True,
                                    env={**os.environ, 'UBSAN_OPTIONS': 'halt_on_error=1'})
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(result.stdout, 'ok\n')

    def test_the_call_is_the_one_the_dev_tools_make_on_the_mac(self):
        core = (LINUX / 'ac_linux_window_picture.h').read_text()
        self.assertIn('kSnapshotCall[] = "ArdiaApp.devSnapshotWindow"', core)
        self.assertIn('kWindowPictureCapabilities[] = {"ArdiaApp.devSnapshotWindow"}', core)
        self.assertIn('"ac_linux_window_picture.h"', (LINUX / 'BUILD.gn').read_text())
        mac = (REPO / 'packages/shell/ios/DevModule.swift').read_text()
        self.assertIn('AsyncFunction("devSnapshotWindow") { (windowId: String, path: String, transparent: Bool?) -> Bool in', mac)

    def test_it_is_offered_only_to_an_isolated_instance_and_refused_again_when_called(self):
        host = host_source()
        bootstrap = host[host.index('ShellHostView::Bootstrap() const {'):]
        bootstrap = bootstrap[:bootstrap.index('\n}\n')]
        advertise = ('for (const char* capability : ardia::linux_window_picture::kWindowPictureCapabilities) '
                     'capabilities.Append(capability);')
        self.assertEqual(bootstrap.count(advertise), 1)
        gate = bootstrap.rindex('if (IsolatedInstance())', 0, bootstrap.index(advertise))
        self.assertLess(bootstrap.index(advertise) - gate, 120, 'the capability is not under the isolated-instance gate')
        body = self.handler()
        self.assertLess(body.index('if (!IsolatedInstance()) {'), body.index('ParseRequest('))
        self.assertIn('return std::move(done).Run(false, base::Value(', body[body.index('if (!IsolatedInstance()) {'):body.index('ParseRequest(')])

    def test_the_arguments_and_the_window_are_checked_before_anything_is_captured(self):
        body = self.handler()
        shaped = body.index('values[0].is_string() && values[1].is_string()')
        self.assertIn('values[2].is_bool() || values[2].is_none()', body)
        self.assertLess(shaped, body.index('ParseRequest('))
        self.assertLess(body.index('ParseRequest('), body.index('host->window_id() == request->window_id && Reaches(host)'))
        self.assertLess(body.index('Reaches(host)'), body.index('RequestCopyOfOutput('))
        refused = body[body.index('if (!root || !colors)'):body.index('RequestCopyOfOutput(')]
        self.assertIn('return std::move(done).Run(true, base::Value(false));', refused)

    def test_the_window_is_read_from_its_compositor_and_the_reply_is_never_left_pending(self):
        body = self.handler()
        self.assertIn('target->GetWidget()', body)
        self.assertIn('widget->GetCompositor()', body)
        self.assertIn('compositor->root_layer()', body)
        self.assertIn('root->RequestCopyOfOutput(std::make_unique<viz::CopyOutputRequest>(', body)
        self.assertIn('viz::CopyOutputRequest::ResultFormat::RGBA', body)
        self.assertIn('viz::CopyOutputRequest::ResultDestination::kSystemMemory', body)
        self.assertIn('mojo::WrapCallbackWithDefaultInvokeIfNotRun(std::move(done), true, base::Value(false))', body)
        self.assertLess(body.index('if (!result || result->IsEmpty())'), body.index('ScopedAccessSkBitmap()'))
        self.assertIn('FileRunner()->PostTaskAndReplyWithResult(', body)
        self.assertIn('std::move(reply).Run(true, base::Value(written))', body)

    def test_the_picture_is_flattened_onto_the_window_colour_unless_alpha_is_asked_for_and_written_atomically(self):
        host = host_source()
        if 'bool WriteWindowPicture(' not in host:
            self.fail('the Linux host writes no window picture')
        writer = host[host.index('bool WriteWindowPicture('):]
        writer = writer[:writer.index('\n}\n')]
        self.assertLess(writer.index('captured.drawsNothing()'), writer.index('tryAllocN32Pixels('))
        self.assertIn('if (background) {', writer)
        self.assertLess(writer.index('canvas.drawColor(*background)'), writer.index('canvas.drawImage('))
        self.assertLess(writer.index('canvas.drawImage('), writer.index('EncodeBGRASkBitmap('))
        self.assertLess(writer.index('EncodeBGRASkBitmap('), writer.index('WriteFileAtomically('))
        self.assertIn('return png &&', writer)
        body = self.handler()
        self.assertIn('request->transparent ? std::nullopt : std::optional<SkColor>(colors->GetColor(kColorWebContentsBackground))', body)


if __name__ == '__main__':
    unittest.main()
