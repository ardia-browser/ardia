from pathlib import Path
import json
import re
import shutil
import subprocess
import tempfile
import unittest

from support import method


ROOT = Path(__file__).resolve().parents[3]


class ExtensionContractTests(unittest.TestCase):
    def test_production_wrapper_options_reach_the_native_backend(self):
        compiler = shutil.which('clang++') or shutil.which('c++')
        if compiler is None:
            self.skipTest('C++ compiler is unavailable')
        loader = ROOT / 'apps/linux/scripts/host-contract-loader.mjs'
        probe = ROOT / 'apps/linux/scripts/host-contract-extension.mjs'
        result = subprocess.run(['node', '--experimental-strip-types', '--import', str(loader), str(probe), '{"pinned":true,"fileAccess":true,"siteAccess":"onClick","userScripts":true}'], capture_output=True, text=True, check=True)
        payload = json.loads(result.stdout)
        extension = 'a' * 32
        self.assertEqual(payload, {'id': extension, 'options': {'pinned': True, 'fileAccess': True, 'siteAccess': 'onClick', 'userScripts': True}})
        helper = (ROOT / 'engine/ardiacore-linux/src/ardia/linux/ac_linux_extensions.cc').read_text()
        limit = re.search(r'^constexpr size_t kMaxSitePatternLength = \d+;$', helper, re.M).group(0)
        transform = ('#include <algorithm>\n#include <string_view>\n' + limit + '\n' + method(helper, 'bool ValidExtensionId(') + '\n' +
                     method(helper, 'std::optional<base::DictValue> Configuration(') +
                     '\nstd::optional<base::DictValue> ExtensionConfiguration(const base::DictValue& input) { return Configuration(input); }')
        backend_source = (ROOT / 'engine/chromium/src/chrome/browser/ardia/ac_extensions.cc').read_text()
        backend = method(backend_source, 'AC_PROFILE_CALL(ac_extensions_configure)').replace('AC_PROFILE_CALL(ac_extensions_configure) {', 'void Backend() {\n  Call call;', 1)
        code = r'''
#include <cassert>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>
namespace base {
struct DictValue;
struct Value {
  enum Kind { kNone, kString, kBool, kInt, kDict } kind = kNone;
  std::string text;
  bool flag = false;
  int number = 0;
  std::shared_ptr<DictValue> dict;
  Value() = default;
  Value(std::string value) : kind(kString), text(std::move(value)) {}
  Value(const char* value) : Value(std::string(value)) {}
  Value(bool value) : kind(kBool), flag(value) {}
  Value(int value) : kind(kInt), number(value) {}
  Value(DictValue value);
  bool is_bool() const { return kind == kBool; }
  bool is_string() const { return kind == kString; }
  bool is_int() const { return kind == kInt; }
  int GetInt() const { return number; }
  const std::string& GetString() const { return text; }
  Value Clone() const { return *this; }
};
struct DictValue {
  std::map<std::string, Value> values;
  DictValue& Set(const char* key, Value value) { values[key] = std::move(value); return *this; }
  DictValue& Set(std::string_view key, Value value) { values[std::string(key)] = std::move(value); return *this; }
  const std::string* FindString(const char* key) const {
    auto found = values.find(key);
    return found != values.end() && found->second.is_string() ? &found->second.text : nullptr;
  }
  std::optional<bool> FindBool(const char* key) const {
    auto found = values.find(key);
    return found != values.end() && found->second.is_bool() ? std::optional(found->second.flag) : std::nullopt;
  }
  std::optional<int> FindInt(const char* key) const {
    auto found = values.find(key);
    return found != values.end() && found->second.is_int() ? std::optional(found->second.number) : std::nullopt;
  }
  const DictValue* FindDict(const char* key) const {
    auto found = values.find(key);
    return found != values.end() ? found->second.dict.get() : nullptr;
  }
  auto begin() const { return values.begin(); }
  auto end() const { return values.end(); }
  size_t size() const { return values.size(); }
  bool empty() const { return values.empty(); }
  bool contains(const char* key) const { return values.count(key) > 0; }
};
Value::Value(DictValue value) : kind(kDict), dict(std::make_shared<DictValue>(std::move(value))) {}
}
ARDIA_TRANSFORM
struct Profile {
  bool IsOffTheRecord() const { return false; }
};
Profile profile;
base::DictValue args;
bool pinned = false;
bool files = false;
bool withheld = false;
bool scripts = false;
bool ok = false;
std::string error;
struct Reply {
  void Error(std::string_view text) { error = std::string(text); }
  void Ok() { ok = true; }
};
struct Call {
  Profile* profile() { return &::profile; }
  const base::DictValue& args() { return ::args; }
  std::string String(const char* key) { const auto* value = ::args.FindString(key); return value ? *value : ""; }
  Reply TakeReply() { return {}; }
};
namespace extensions {
struct Extension {};
namespace util {
void SetAllowFileAccess(const std::string&, Profile*, bool value) { files = value; }
void SetIsIncognitoEnabled(const std::string&, Profile*, bool) {}
}
struct PermissionsManager {
  static PermissionsManager* Get(Profile*) { static PermissionsManager value; return &value; }
  bool CanAffectExtension(const Extension&) { return true; }
  bool HasBroadGrantedHostPermissions(const Extension&) { return false; }
};
struct UserScriptManager {
  static bool IsUserScriptsAPIPermissionAvailable(const Extension&) { return true; }
  void SetUserScriptPrefEnabled(const std::string&, bool value) { scripts = value; }
};
struct ExtensionSystem {
  static ExtensionSystem* Get(Profile*) { static ExtensionSystem value; return &value; }
  UserScriptManager* user_script_manager() { static UserScriptManager value; return &value; }
};
struct ScriptingPermissionsModifier {
  ScriptingPermissionsModifier(Profile*, const Extension*) {}
  void SetWithholdHostPermissions(bool value) { withheld = value; }
  void RemoveAllGrantedHostPermissions() {}
  void RemoveBroadGrantedHostPermissions() {}
};
}
namespace ardia {
const extensions::Extension* Find(Profile*, const std::string&) { static extensions::Extension value; return &value; }
}
struct ToolbarActionsModel {
  static ToolbarActionsModel* Get(Profile*) { static ToolbarActionsModel value; return &value; }
  bool HasAction(const std::string&) { return true; }
  bool IsActionPinned(const std::string&) { return pinned; }
  void SetActionVisibility(const std::string&, bool value) { pinned = value; }
  std::vector<std::string> order = {"first", "second", std::string(32, 'a')};
  const std::vector<std::string>& pinned_action_ids() const { return order; }
  void MovePinnedAction(const std::string& id, size_t index) {
    order.erase(std::find(order.begin(), order.end(), id));
    order.insert(order.begin() + static_cast<std::ptrdiff_t>(index), id);
  }
};
int site_changes = 0;
std::string site_problem;
std::string last_site;
namespace ardia::extension_sites_internal {
std::string SiteProblem(Profile*, const extensions::Extension&, const std::string&, bool) { return site_problem; }
void ChangeSite(Profile*, const extensions::Extension&, const std::string& site, bool, Reply reply) { ++site_changes; last_site = site; reply.Ok(); }
}
ARDIA_BACKEND
int main() {
  base::DictValue input = ARDIA_INPUT;
  const auto prepared = ExtensionConfiguration(input);
  assert(prepared);
  args = *prepared;
  Backend();
  assert(ok && error.empty());
  assert(pinned && files && withheld && scripts);
  base::DictValue reorder;
  reorder.Set("id", std::string(32, 'a')).Set("options", base::DictValue().Set("pinnedIndex", 0));
  const auto moved = ExtensionConfiguration(reorder);
  assert(moved);
  args = *moved;
  ok = false;
  Backend();
  assert(ok && error.empty());
  assert(ToolbarActionsModel::Get(&profile)->pinned_action_ids().front() == std::string(32, 'a'));
  base::DictValue misplaced;
  misplaced.Set("id", std::string(32, 'a')).Set("options", base::DictValue().Set("pinnedIndex", -1));
  assert(!ExtensionConfiguration(misplaced));
  misplaced.Set("options", base::DictValue().Set("pinnedIndex", "0"));
  assert(!ExtensionConfiguration(misplaced));
  base::DictValue invalid;
  invalid.Set("id", std::string(32, 'a')).Set("options", base::DictValue().Set("future", true));
  assert(!ExtensionConfiguration(invalid));
  invalid.Set("options", base::DictValue().Set("pinned", "true"));
  assert(!ExtensionConfiguration(invalid));
  invalid.Set("options", base::DictValue().Set("userScripts", "on"));
  assert(!ExtensionConfiguration(invalid));
  invalid.Set("options", base::DictValue().Set("siteAccess", "unknown"));
  assert(!ExtensionConfiguration(invalid));
  invalid.Set("options", base::DictValue());
  assert(!ExtensionConfiguration(invalid));
  invalid.Set("id", "extension").Set("options", base::DictValue().Set("pinned", true));
  assert(!ExtensionConfiguration(invalid));
  base::DictValue grant;
  grant.Set("id", std::string(32, 'a')).Set("options", base::DictValue().Set("siteAccess", "specificSites").Set("grantSite", "https://example.com/*"));
  const auto granted = ExtensionConfiguration(grant);
  assert(granted);
  args = *granted;
  ok = false;
  withheld = false;
  site_problem = "That covers every site. Choose On all sites instead";
  Backend();
  assert(!ok && error == site_problem && !withheld && site_changes == 0);
  site_problem.clear();
  error.clear();
  Backend();
  assert(ok && error.empty() && withheld && site_changes == 1);
  args = base::DictValue().Set("id", std::string(32, 'a')).Set("options", base::DictValue().Set("revokeSite", "https://example.com/*"));
  ok = false;
  Backend();
  assert(ok && site_changes == 2);
  args = base::DictValue().Set("id", std::string(32, 'a')).Set("options", base::DictValue().Set("grantSite", "https://a.example/*").Set("revokeSite", "https://b.example/*"));
  ok = false;
  Backend();
  assert(!ok && !error.empty() && site_changes == 2);
  args = base::DictValue().Set("id", std::string(32, 'a')).Set("options", base::DictValue().Set("siteAccess", "specificSites").Set("grantSite", true));
  ok = false;
  withheld = false;
  error.clear();
  Backend();
  assert(!ok && !error.empty() && !withheld && site_changes == 2);
  for (const std::string& hostile : ARDIA_HOSTILE) {
    for (const char* key : {"grantSite", "revokeSite"}) {
      base::DictValue request;
      request.Set("id", std::string(32, 'a')).Set("options", base::DictValue().Set("siteAccess", "specificSites").Set(key, hostile));
      const auto accepted = ExtensionConfiguration(request);
      assert(static_cast<bool>(accepted) == (!hostile.empty() && hostile.size() <= kMaxSitePatternLength));
      if (!accepted) continue;
      args = *accepted;
      const int before = site_changes;
      site_problem = "That isn't a site an extension can be given";
      ok = false;
      withheld = false;
      error.clear();
      Backend();
      assert(!ok && error == site_problem && !withheld && site_changes == before);
      site_problem.clear();
      Backend();
      assert(ok && site_changes == before + 1 && last_site == hostile);
    }
  }
  invalid.Set("id", std::string(32, 'a')).Set("options", base::DictValue().Set("grantSite", ""));
  assert(!ExtensionConfiguration(invalid));
}
'''
        def value(item):
            if isinstance(item, dict):
                return 'base::DictValue()' + ''.join('.Set(' + json.dumps(key) + ', ' + value(val) + ')' for key, val in item.items())
            return json.dumps(item)
        hostile_source = ("const { HOSTILE_STRINGS } = await import(process.argv[1]); "
                          "console.log(JSON.stringify(HOSTILE_STRINGS.map((h) => h.value)))")
        hostile_list = json.loads(subprocess.run(['node', '--input-type=module', '-e', hostile_source,
                                                  str(ROOT / 'scripts/security/hostile-inputs.mjs')],
                                                 capture_output=True, text=True, check=True).stdout)
        literal = lambda text: 'std::string("' + ''.join('\\%03o' % byte for byte in text.encode('utf-8', 'surrogatepass')) + '", ' + str(len(text.encode('utf-8', 'surrogatepass'))) + ')'
        hostile = 'std::vector<std::string>{' + ', '.join(literal(text) for text in hostile_list) + ', std::string(4096, \'a\')}'
        with tempfile.TemporaryDirectory(prefix='ardia-extension-contract-') as scratch:
            cpp = Path(scratch) / 'extension.cc'
            binary = Path(scratch) / 'extension'
            cpp.write_text(code.replace('ARDIA_TRANSFORM', transform).replace('ARDIA_BACKEND', backend).replace('ARDIA_INPUT', value(payload)).replace('ARDIA_HOSTILE', hostile))
            result = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', str(cpp), '-o', str(binary)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            result = subprocess.run([str(binary)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
