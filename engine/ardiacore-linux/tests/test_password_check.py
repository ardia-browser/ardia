import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'src'
LINUX = SOURCE / 'ardia' / 'linux'

SCENARIOS = r'''#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <string>
#include "ardia/linux/ac_linux_password_check.h"
#include "ardia/linux/ac_linux_secret_text.h"
using namespace ardia::linux_password;

int main(int, char** argv) {
  const std::string helper = argv[1];
  const std::string sleeper = argv[2];
  std::map<std::string, FileFacts> disk = {
      {"/", {false, true, 0, 040755}},
      {"/usr", {false, true, 0, 040755}},
      {"/usr/sbin", {false, true, 0, 040755}},
      {"/usr/sbin/unix_chkpwd", {true, false, 0, 0102755}},
      {"/home", {false, true, 0, 040755}},
      {"/home/me", {false, true, 1000, 040700}},
      {"/home/me/unix_chkpwd", {true, false, 0, 0100755}},
      {"/tmp", {false, true, 0, 041777}},
      {"/tmp/unix_chkpwd", {true, false, 0, 0100755}},
      {"/usr/sbin/writable", {true, false, 0, 0100777}},
      {"/usr/sbin/mine", {true, false, 1000, 0100755}},
      {"/usr/sbin/plain", {true, false, 0, 0100644}},
  };
  auto stat = [&disk](const std::string& path) -> std::optional<FileFacts> {
    auto found = disk.find(path);
    if (found == disk.end()) return std::nullopt;
    return found->second;
  };
  assert(TrustedHelperAt("/usr/sbin/unix_chkpwd", stat) == "/usr/sbin/unix_chkpwd");
  assert(!TrustedHelperAt("/home/me/unix_chkpwd", stat));
  assert(!TrustedHelperAt("/tmp/unix_chkpwd", stat));
  assert(!TrustedHelperAt("/usr/sbin/writable", stat));
  assert(!TrustedHelperAt("/usr/sbin/mine", stat));
  assert(!TrustedHelperAt("/usr/sbin/plain", stat));
  assert(!TrustedHelperAt("/usr/sbin/missing", stat));
  assert(!TrustedHelperAt("relative/unix_chkpwd", stat));
  assert(!TrustedHelperAt("", stat));

  assert(VerdictForExit(0) == Verdict::kMatch);
  assert(VerdictForExit(kWrongPasswordExit) == Verdict::kMismatch);
  assert(VerdictForExit(1) == Verdict::kFailed);
  assert(VerdictForExit(std::nullopt) == Verdict::kFailed);

  HelperContext sandboxed;
  sandboxed.no_new_privs = true;
  HelperContext nosuid;
  nosuid.nosuid_mount = true;
  HelperContext both;
  both.no_new_privs = true;
  both.nosuid_mount = true;
  HelperContext root;
  root.root = true;
  root.no_new_privs = true;
  root.nosuid_mount = true;
  assert(!WhyUnverifiable(HelperContext()));
  assert(!WhyUnverifiable(root));
  assert(WhyUnverifiable(sandboxed) == "no_new_privs");
  assert(WhyUnverifiable(nosuid) == "nosuid_mount");
  assert(WhyUnverifiable(both) == "no_new_privs, nosuid_mount");
  assert(VerdictForExit(kWrongPasswordExit, HelperContext()) == Verdict::kMismatch);
  assert(VerdictForExit(kWrongPasswordExit, root) == Verdict::kMismatch);
  assert(VerdictForExit(kWrongPasswordExit, sandboxed) == Verdict::kUnverifiable);
  assert(VerdictForExit(kWrongPasswordExit, nosuid) == Verdict::kUnverifiable);
  assert(VerdictForExit(kWrongPasswordExit, both) == Verdict::kUnverifiable);
  assert(VerdictForExit(0, both) == Verdict::kMatch);
  assert(VerdictForExit(1, both) == Verdict::kFailed);
  assert(VerdictForExit(std::nullopt, both) == Verdict::kFailed);
  assert(NoNewPrivsIn("Name:\tardia\nNoNewPrivs:\t1\nSeccomp:\t0\n"));
  assert(NoNewPrivsIn("NoNewPrivs: 1"));
  assert(!NoNewPrivsIn("Name:\tardia\nNoNewPrivs:\t0\nSeccomp:\t0\n"));
  assert(!NoNewPrivsIn("Name:\tNoNewPrivs:\t1\n"));
  assert(!NoNewPrivsIn("Name:\tardia\n"));
  assert(!NoNewPrivsIn(""));

  assert(UnusablePassword(""));
  assert(UnusablePassword(std::string(kMaxPasswordBytes + 1, 'a')));
  assert(UnusablePassword(std::string("a\0b", 3)));
  assert(!UnusablePassword(std::string(kMaxPasswordBytes, 'a')));
  assert(!UnusablePassword("correct horse"));

  Throttle throttle;
  assert(throttle.WaitMs(0) == 0);
  throttle.NoteWrong(1000);
  assert(throttle.WaitMs(1000) == 0);
  throttle.NoteWrong(1000);
  assert(throttle.WaitMs(1000) == 2000 && throttle.WaitMs(2500) == 500);
  throttle.NoteWrong(5000);
  assert(throttle.WaitMs(5000) == 5000);
  throttle.NoteWrong(10000);
  assert(throttle.WaitMs(10000) == 30000);
  for (int i = 0; i < 4; ++i) throttle.NoteWrong(50000);
  assert(throttle.WaitMs(50000) == 60000 && throttle.wrong() == 8);
  throttle.NoteRight();
  assert(throttle.WaitMs(50000) == 0 && throttle.wrong() == 0);

  SecretText typed(kMaxPasswordBytes);
  assert(typed.Insert(u"correct horse"));
  std::unique_ptr<SecretBytes> right = typed.Utf8();
  assert(right && right->view() == "correct horse");
  const std::optional<HelperContext> usual = HelperContext();
  std::string detail;
  assert(RunHelper(helper, "me", right->view(), kHelperDeadlineMs, usual, &detail) == Verdict::kMatch && detail == "exit 0");
  assert(RunHelper(helper, "me", "wrong horse", kHelperDeadlineMs, usual, &detail) == Verdict::kMismatch && detail == "exit 7");
  assert(RunHelper(helper, "me", "correct", kHelperDeadlineMs, usual) == Verdict::kMismatch);
  assert(RunHelper(helper, "someone", right->view(), kHelperDeadlineMs, usual, &detail) == Verdict::kFailed && detail == "exit 9");
  assert(RunHelper(sleeper, "me", right->view(), 300, usual, &detail) == Verdict::kFailed && detail == "timed out");
  assert(RunHelper("/nonexistent/unix_chkpwd", "me", "x", kHelperDeadlineMs, usual, &detail) == Verdict::kFailed);
  assert(detail.rfind("could not start", 0) == 0);
  assert(RunHelper(helper, "me", "wrong horse", kHelperDeadlineMs, sandboxed, &detail) == Verdict::kUnverifiable);
  assert(detail == "exit 7, no_new_privs");
  assert(RunHelper(helper, "me", right->view(), kHelperDeadlineMs, sandboxed) == Verdict::kMatch);
  assert(!ReadHelperContext("/nonexistent/unix_chkpwd").nosuid_mount);
  assert(ReadHelperContext("/proc/self/exe").root == (geteuid() == 0));
  assert(CurrentUser() && !CurrentUser()->empty());
  std::puts("password check scenarios passed");
}
'''

SANDBOXED = r'''#include <cassert>
#include <cstdio>
#include <string>
#include <sys/prctl.h>
#include <unistd.h>
#include "ardia/linux/ac_linux_password_check.h"
#include "ardia/linux/ac_linux_secret_text.h"
using namespace ardia::linux_password;

int main(int, char** argv) {
  const std::string helper = argv[1];
  SecretText typed(kMaxPasswordBytes);
  assert(typed.Insert(u"correct horse"));
  std::unique_ptr<SecretBytes> right = typed.Utf8();
  assert(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0);
  const Verdict expected = geteuid() == 0 ? Verdict::kMatch : Verdict::kUnverifiable;
  assert(RunHelper(helper, "me", right->view()) == expected);
  std::puts("a sandboxed check was not called a mismatch");
}
'''

FAKE_HELPER = '''#!/bin/bash
[ "$#" = 2 ] && [ "$2" = nonull ] || exit 3
[ -z "${HOME:-}${USER:-}${LD_PRELOAD:-}" ] || exit 4
[ "$1" = me ] || exit 9
IFS= read -r -d '' typed
nnp=
while read -r key value; do [ "$key" = NoNewPrivs: ] && nnp=$value; done < /proc/self/status
[ "$nnp" = 1 ] && [ "$EUID" != 0 ] && exit 7
[ "$typed" = "correct horse" ] && exit 0
exit 7
'''


class PasswordCheckTests(unittest.TestCase):
    def test_a_correct_password_is_not_called_wrong_when_the_helper_cannot_gain_its_privilege(self):
        compiler = shutil.which('clang++') or shutil.which('c++')
        if compiler is None:
            self.skipTest('C++ compiler is unavailable')
        with tempfile.TemporaryDirectory(prefix='ardia-password-check-') as scratch:
            scratch = pathlib.Path(scratch)
            (scratch / 'sandboxed.cc').write_text(SANDBOXED)
            helper = scratch / 'unix_chkpwd'
            helper.write_text(FAKE_HELPER)
            helper.chmod(0o755)
            binary = scratch / 'sandboxed'
            compiled = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-g', '-I', str(SOURCE),
                                       str(scratch / 'sandboxed.cc'), str(LINUX / 'ac_linux_password_check.cc'),
                                       str(LINUX / 'ac_linux_secret_text.cc'), '-o', str(binary)], capture_output=True, text=True, timeout=180)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            result = subprocess.run([str(binary), str(helper)], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('a sandboxed check was not called a mismatch', result.stdout)

    def test_the_login_password_is_checked_by_a_trusted_root_helper_on_stdin_and_never_on_the_command_line(self):
        compiler = shutil.which('clang++') or shutil.which('c++')
        if compiler is None:
            self.skipTest('C++ compiler is unavailable')
        with tempfile.TemporaryDirectory(prefix='ardia-password-check-') as scratch:
            scratch = pathlib.Path(scratch)
            (scratch / 'scenarios.cc').write_text(SCENARIOS)
            helper = scratch / 'unix_chkpwd'
            helper.write_text(FAKE_HELPER)
            helper.chmod(0o755)
            sleeper = scratch / 'sleeper'
            sleeper.write_text('#!/bin/bash\nsleep 30\n')
            sleeper.chmod(0o755)
            binary = scratch / 'scenarios'
            compiled = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-g', '-fsanitize=address,undefined',
                                       '-I', str(SOURCE), str(scratch / 'scenarios.cc'), str(LINUX / 'ac_linux_password_check.cc'),
                                       str(LINUX / 'ac_linux_secret_text.cc'), '-o', str(binary)], capture_output=True, text=True, timeout=180)
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            result = subprocess.run([str(binary), str(helper), str(sleeper)], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn('password check scenarios passed', result.stdout)

    def test_the_prompt_is_native_installed_at_startup_and_hands_reauth_its_answer(self):
        prompt = (LINUX / 'ac_linux_password_prompt.cc').read_text()
        for needle in ['PasswordField>(u"Login password")', 'ModalType::kWindow', 'ForEachCurrentBrowserWindowInterfaceOrderedByActivation(',
                       'ardia::SetReauthFallback(', 'base::MayBlock()', 'field_->TakeUtf8()', 'std::unique_ptr<SecretBytes> password',
                       'TheThrottle().WaitMs(NowMs())']:
            self.assertIn(needle, prompt)
        for needle in ['LOG(', 'Textfield', 'SetPromptField', 'GetText(', 'UTF16ToUTF8(', 'std::string password']:
            self.assertNotIn(needle, prompt)
        answered = prompt[prompt.index('void Answered('):prompt.index('raw_ptr<Profile> profile_;')]
        self.assertEqual(answered.count('TheThrottle().NoteWrong('), 1)
        self.assertLess(answered.index('Verdict::kMismatch'), answered.index('LogUnansweredCheck(result.detail)'))
        self.assertLess(answered.index('LogUnansweredCheck(result.detail)'), answered.index('Verdict::kUnverifiable'))
        self.assertIn("Ardia can't check your login password in this session", answered)
        self.assertIn("Ardia couldn't check your login password", answered)
        self.assertEqual(answered.count('Your Recovery Kit, if you saved one when you turned sync on, has the same'), 2)
        self.assertLess(answered.index('unanswered_.reset();'), answered.index('Verdict::kMatch'))
        self.assertLess(answered.index('unanswered_ = reauth_linux::Outcome::kUnverifiable;'), answered.index("Ardia can't check your login password"))
        self.assertLess(answered.index('unanswered_ = reauth_linux::Outcome::kHelperFailed;'), answered.index("Ardia couldn't check your login password"))
        finish = prompt[prompt.index('void Finish(Profile* profile, reauth_linux::Outcome outcome) {'):prompt.index('void Confirm(')]
        self.assertIn('confirmation->Ended(outcome)', finish)
        self.assertIn('std::move(done).Run(ended);', finish)
        ended = prompt[prompt.index('reauth_linux::Outcome Ended('):prompt.index('void Show(')]
        self.assertIn('outcome != reauth_linux::Outcome::kGranted && unanswered_ ? *unanswered_ : outcome', ended)
        self.assertNotIn('void(bool, bool)', prompt)
        policy = (ROOT.parent / 'chromium' / 'src' / 'chrome' / 'browser' / 'ardia' / 'ac_reauth_linux_policy.h').read_text()
        self.assertIn('return "unverifiable";', policy)
        self.assertIn('return "helperFailed";', policy)
        log = (LINUX / 'ac_linux_password_log.cc').read_text()
        self.assertIn('LOG(WARNING)', log)
        self.assertIn('<< detail;', log)
        for needle in ['SecretBytes', 'view()', 'password->']:
            self.assertNotIn(needle, log)
        host = (LINUX / 'ac_linux_host.cc').read_text()
        self.assertIn('ardia::linux_password::InstallReauthFallback();', host)
        build = (LINUX / 'BUILD.gn').read_text()
        for name in ['"ac_linux_password_check.cc"', '"ac_linux_password_field.cc"', '"ac_linux_password_prompt.cc"',
                     '"ac_linux_password_log.cc"', '"ac_linux_secret_text.cc"']:
            self.assertIn(name, build)


if __name__ == '__main__':
    unittest.main()
