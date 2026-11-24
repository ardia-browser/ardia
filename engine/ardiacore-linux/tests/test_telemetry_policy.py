import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
DESKTOP_SOURCE = SOURCE.parents[1] / 'ardiacore-desktop' / 'src'
LINUX = SOURCE / 'ardia' / 'linux'
DESKTOP = LINUX.parents[3] / 'ardiacore-desktop' / 'src' / 'ardia' / 'desktop'
HOSTILE = ROOT.parents[1] / 'scripts' / 'security' / 'hostile-inputs.mjs'
REQUEST_ID = re.compile(r'[A-Za-z0-9_-]{1,64}')


class TelemetryPolicyTests(unittest.TestCase):
    def test_only_bounded_json_bodies_with_app_keys_post_to_the_fixed_endpoint(self):
        compiler = shutil.which('clang++') or shutil.which('c++')
        if compiler is None:
            self.skipTest('C++ compiler is unavailable')
        code = r'''#include <cassert>
#include <string>
#include "ardia/desktop/ac_desktop_telemetry_policy.h"
int main() {
  using namespace ardia::desktop_telemetry_policy;
  assert(kEndpoint == "https://ardia.dev/otel/v1/logs");
  assert(IngestKeyAcceptable("ak_app_41b5d0762fd8ade6949ac2ac"));
  assert(IngestKeyAcceptable("ak_cli_0123456789abcdef01234567"));
  assert(IngestKeyAcceptable("ak_x_0123456789abcdef01234567"));
  assert(!IngestKeyAcceptable(""));
  assert(!IngestKeyAcceptable("ak__0123456789abcdef01234567"));
  assert(!IngestKeyAcceptable("ak_0123456789abcdef01234567"));
  assert(!IngestKeyAcceptable("ak_App_41b5d0762fd8ade6949ac2ac"));
  assert(!IngestKeyAcceptable("ak_a1_41b5d0762fd8ade6949ac2ac"));
  assert(!IngestKeyAcceptable("ak_a_b_41b5d0762fd8ade6949ac2ac"));
  assert(!IngestKeyAcceptable("ak_app_41B5D0762FD8ADE6949AC2AC"));
  assert(!IngestKeyAcceptable("ak_app_41b5d0762fd8ade6949ac2a"));
  assert(!IngestKeyAcceptable("ak_app_41b5d0762fd8ade6949ac2acd"));
  assert(!IngestKeyAcceptable("ak_app_41b5d0762fd8ade6949ac2ag"));
  assert(!IngestKeyAcceptable("xk_app_41b5d0762fd8ade6949ac2ac"));
  assert(!IngestKeyAcceptable(" ak_app_41b5d0762fd8ade6949ac2ac"));
  assert(!IngestKeyAcceptable("ak_app_41b5d0762fd8ade6949ac2ac\n"));
  assert(!IngestKeyAcceptable("ak_app_41b5d0762fd8ade6949ac2ac\r\nX-Evil: 1"));
  assert(!IngestKeyAcceptable(std::string("ak_app\0_41b5d0762fd8ade6949ac2ac", 31)));
  assert(BodyAcceptable("{\"resourceLogs\":[]}"));
  assert(BodyAcceptable("{"));
  assert(BodyAcceptable("{" + std::string(kMaxBodyBytes - 1, ' ')));
  assert(!BodyAcceptable("{" + std::string(kMaxBodyBytes, ' ')));
  assert(!BodyAcceptable(""));
  assert(!BodyAcceptable(" {}"));
  assert(!BodyAcceptable("[]"));
  assert(kMaxBodyBytes == 524288);
  assert(PostAcceptable("{}", "ak_app_41b5d0762fd8ade6949ac2ac"));
  assert(!PostAcceptable("{}", "ak_app_nope"));
  assert(!PostAcceptable("[]", "ak_app_41b5d0762fd8ade6949ac2ac"));
  for (int i = 0; i < kMaxInFlight; ++i) assert(AdmitPost(i));
  assert(kMaxInFlight == 4);
  assert(!AdmitPost(kMaxInFlight));
  assert(!AdmitPost(-1));
  assert(ReportedStatus(true, 200) == 200);
  assert(ReportedStatus(true, 204) == 204);
  assert(ReportedStatus(true, 400) == 400);
  assert(ReportedStatus(true, 429) == 429);
  assert(ReportedStatus(true, 503) == 503);
  assert(ReportedStatus(false, 200) == 0);
  assert(ReportedStatus(false, 0) == 0);
  assert(ReportedStatus(true, 301) == 0);
  assert(ReportedStatus(true, 307) == 0);
  assert(ReportedStatus(true, 100) == 0);
  assert(ReportedStatus(true, 600) == 0);
  assert(kTimeoutSeconds == 30);
}
'''
        with tempfile.TemporaryDirectory(prefix='ardia-telemetry-policy-test-') as scratch:
            scratch = pathlib.Path(scratch)
            cpp = scratch / 'telemetry.cc'
            cpp.write_text(code, encoding='latin-1')
            binary = scratch / 'telemetry'
            compiled = subprocess.run([compiler, '-std=c++20', '-Wall', '-Werror', '-I', str(SOURCE), '-I', str(DESKTOP_SOURCE), str(cpp), '-o', str(binary)], capture_output=True, text=True)
            if compiled.returncode != 0:
                raise AssertionError(compiled.stderr)
            subprocess.run([str(binary)], check=True)

    def test_the_post_omits_credentials_refuses_redirects_and_uses_the_system_network_context(self):
        fetcher = (LINUX / 'ac_linux_telemetry.cc').read_text()
        for needle in ['GURL(policy::kEndpoint)', 'request->method = "POST"', 'CredentialsMode::kOmit', 'RedirectMode::kError',
                       'system_network_context_manager()', 'GetSharedURLLoaderFactory()', 'DownloadHeadersOnly(', 'SetAllowHttpErrorResults(true)',
                       'base::Seconds(policy::kTimeoutSeconds)', '"X-Ardia-Key"', 'policy::AdmitPost(InFlight())', 'cookies_allowed: NO']:
            self.assertIn(needle, fetcher)
        self.assertNotIn('GetDefaultStoragePartition', fetcher)
        self.assertNotIn('Profile', fetcher)

    def test_no_hostile_string_is_a_request_id_outside_the_plain_alphabet(self):
        compiler = shutil.which('clang++') or shutil.which('c++')
        node = shutil.which('node')
        if compiler is None or node is None:
            self.skipTest('A C++ compiler and node are needed to run scripts/security/hostile-inputs.mjs through the rule')
        listed = subprocess.run([node, '--input-type=module', '-e',
                                 f'import {{ HOSTILE_STRINGS }} from {json.dumps(HOSTILE.as_uri())};'
                                 'process.stdout.write(JSON.stringify(HOSTILE_STRINGS));'],
                                capture_output=True, text=True, timeout=120)
        self.assertEqual(listed.returncode, 0, listed.stderr)
        hostile = json.loads(listed.stdout)
        self.assertGreater(len(hostile), 50)
        ids = [(entry['id'], shape, text.encode('utf-8', 'surrogatepass'))
               for entry in hostile
               for shape, text in [('alone', entry['value']), ('after the prefix', f'telemetry-{entry["value"]}'), ('before the counter', f'{entry["value"]}-1')]]
        ids += [('plain', 'longest', b'x' * 64), ('plain', 'too long', b'x' * 65), ('plain', 'empty', b'')]
        code = r'''#include <iostream>
#include <string>
#include "ardia/desktop/ac_desktop_suggest_policy.h"
int main() {
  for (std::string line; std::getline(std::cin, line);) {
    std::string id;
    for (size_t at = 0; at + 1 < line.size(); at += 2) id.push_back(static_cast<char>(std::stoi(line.substr(at, 2), nullptr, 16)));
    std::cout << (ardia::desktop_suggest_policy::ValidRequestId(id) ? '1' : '0');
  }
}
'''
        with tempfile.TemporaryDirectory(prefix='ardia-telemetry-request-id-test-') as scratch:
            scratch = pathlib.Path(scratch)
            cpp = scratch / 'request_id.cc'
            cpp.write_text(code)
            binary = scratch / 'request_id'
            compiled = subprocess.run([compiler, '-std=c++20', '-Wall', '-Werror', '-I', str(DESKTOP_SOURCE), str(cpp), '-o', str(binary)], capture_output=True, text=True)
            if compiled.returncode != 0:
                raise AssertionError(compiled.stderr)
            verdicts = subprocess.run([str(binary)], input=''.join(raw.hex() + '\n' for _, _, raw in ids).encode(), capture_output=True, check=True, timeout=60).stdout.decode()
        self.assertEqual(len(verdicts), len(ids))
        for (name, shape, raw), verdict in zip(ids, verdicts):
            self.assertEqual(verdict == '1', REQUEST_ID.fullmatch(raw.decode('latin-1')) is not None, f'{name} {shape}')
        accepted = {name for (name, shape, _), verdict in zip(ids, verdicts) if verdict == '1' and shape == 'alone'}
        self.assertEqual(verdicts[-3:], '100')
        self.assertLess(len(accepted), len(hostile) // 4)

    def test_a_cancelled_post_gives_up_its_loader_and_answers_once(self):
        fetcher = (LINUX / 'ac_linux_telemetry.cc').read_text()
        self.assertRegex(fetcher, re.compile(r'bool RequestIdAcceptable\(std::string_view request_id\) \{\n  return ardia::desktop_suggest_policy::ValidRequestId\(request_id\);\n\}'))
        held = fetcher[fetcher.index('TelemetryClient::Posts::iterator TelemetryClient::Held('):fetcher.index('void TelemetryClient::Post(')]
        self.assertIn('owned->request_id() == request_id', held)
        post = fetcher[fetcher.index('void TelemetryClient::Post('):fetcher.index('void TelemetryClient::Cancel(')]
        for needle in ['const bool identified = !request_id.empty();', '!RequestIdAcceptable(request_id)', 'Held(request_id) != posts_.end()',
                       'std::make_unique<TelemetryPost>(this, std::move(request_id),']:
            self.assertIn(needle, post)
        self.assertLess(post.index('Held(request_id) != posts_.end()'), post.index('std::make_unique<TelemetryPost>'))
        cancel = fetcher[fetcher.index('void TelemetryClient::Cancel('):fetcher.index('void TelemetryClient::Finish(')]
        steps = ['if (!RequestIdAcceptable(request_id)) {', 'const auto found = Held(request_id);', 'if (found == posts_.end()) {',
                 'std::unique_ptr<TelemetryPost> cancelled = std::move(*found);', 'posts_.erase(found);', 'PostStatus(cancelled->TakeReply(), 0);']
        self.assertEqual(sorted(steps, key=cancel.index), steps)
        self.assertEqual(fetcher.count('TakeReply()'), 3)
        owner = fetcher[fetcher.index('class TelemetryPost {'):fetcher.index('bool RequestIdAcceptable(')]
        for needle in ['~TelemetryPost() { --InFlight(); }', 'std::unique_ptr<network::SimpleURLLoader> loader_;']:
            self.assertIn(needle, owner)

    def test_the_host_advertises_and_gates_the_route(self):
        host = (LINUX / 'ac_linux_host.cc').read_text()
        bootstrap = host[host.index('base::DictValue ShellHostView::Bootstrap() const {'):host.index('void ShellHostView::LayoutOverlay()')]
        self.assertIn('.Append("ArdiaTelemetry.post")', bootstrap)
        self.assertIn('.Set("isolatedInstance", IsolatedInstance())', bootstrap)
        route = host[host.index('if (method == "ArdiaTelemetry.post") {'):]
        route = route[:route.index('\n  if (method ==', 1)]
        self.assertIn('ERR_TELEMETRY_REFUSED', route)
        self.assertIn('PostAcceptable(values[0].GetString(), values[1].GetString())', route)
        self.assertIn('const bool identified = values.size() == 3;', route)
        self.assertIn('(values.size() != 2 && !identified)', route)
        self.assertIn('!values[2].is_string()', route)
        self.assertIn('RequestIdAcceptable(values[2].GetString())', route)
        self.assertIn('identified ? values[2].GetString() : std::string()', route)
        self.assertIn('.Append("ArdiaTelemetry.cancelPost")', bootstrap)
        cancel = host[host.index('if (method == "ArdiaTelemetry.cancelPost") {'):]
        cancel = cancel[:cancel.index('\n  if (method ==', 1)]
        for needle in ['values.size() != 1', '!values[0].is_string()', 'RequestIdAcceptable(values[0].GetString())',
                       'ERR_TELEMETRY_REFUSED', 'telemetry_->Cancel(values[0].GetString());', 'std::move(done).Run(true, base::Value());']:
            self.assertIn(needle, cancel)
        self.assertLess(cancel.index('ERR_TELEMETRY_REFUSED'), cancel.index('telemetry_->Cancel('))
        self.assertRegex(host, re.compile(r'bool IsolatedInstance\(\) \{\n.*switches::kUserDataDir.*\n.*"ARDIA_DATA_DIR"', re.M))
        build = (LINUX / 'BUILD.gn').read_text() + (DESKTOP / 'BUILD.gn').read_text()
        for name in ['"ac_linux_telemetry.cc"', '"ac_linux_telemetry.h"', '"ac_desktop_telemetry_policy.h"', '"//chrome/browser/net"']:
            self.assertIn(name, build)


if __name__ == '__main__':
    unittest.main()
