import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
LINUX = ROOT / 'src' / 'ardia' / 'linux'
CORE = ROOT / 'src' / 'ardia' / 'core'
REPO = ROOT.parents[1]


def between(text, start, end):
    begin = text.index(start)
    return text[begin:text.index(end, begin)]


class LoginItemGuardTests(unittest.TestCase):
    def test_the_mac_refuses_to_touch_the_login_item_from_a_scratch_data_directory(self):
        swift = (REPO / 'packages' / 'shell' / 'ios' / 'SystemModule.swift').read_text()
        guard = between(swift, 'AsyncFunction("setLaunchAtLogin")', 'SMAppService.mainApp.register()')
        self.assertIn('LaunchConfig.shared.background', guard)
        self.assertIn('LaunchConfig.shared.isolated', guard)
        self.assertIn('not changing launch at login', guard)
        self.assertIn('return', guard)
        self.assertEqual(swift.count('SMAppService.mainApp.register()'), 1)
        self.assertEqual(swift.count('SMAppService.mainApp.unregister()'), 1)

    def test_linux_refuses_to_touch_the_autostart_entry_from_a_scratch_data_directory(self):
        glue = (LINUX / 'ac_linux_system.cc').read_text()
        route = between(glue, 'if (method == "ArdiaSystem.setLaunchAtLogin") {', 'ChangeLaunchAtLogin')
        self.assertIn('BackgroundInstance()', route)
        self.assertIn('LinuxIsolatedInstance()', route)
        self.assertIn('isolated instance: not changing launch at login', route)
        self.assertLess(route.index('LinuxIsolatedInstance()'), route.index('Worker()'))

    def test_the_linux_check_matches_the_hosts_idea_of_an_isolated_instance(self):
        header = (LINUX / 'ac_linux_launch_config.h').read_text()
        self.assertIn('bool LinuxIsolatedInstance();', header)
        switches = (CORE / 'ac_launch_switches_linux.cc').read_text()
        definition = switches[switches.index('bool LinuxIsolatedInstance() {'):]
        definition = definition[:definition.index('\n}\n')]
        self.assertRegex(
            definition,
            r'if \(CommandLine\(\)\.HasSwitch\(switches::kUserDataDir\)\) return true;\n'
            r'\s*return !base::Environment::Create\(\)->GetVar\("ARDIA_DATA_DIR"\)\.value_or\(""\)\.empty\(\);$',
        )
        host = (LINUX / 'ac_linux_host.cc').read_text()
        hosts = between(host, 'bool IsolatedInstance() {', '\n}\n')
        self.assertEqual(
            hosts.replace('base::CommandLine::ForCurrentProcess()->', 'CommandLine().').split('{', 1)[1],
            definition.split('{', 1)[1],
        )


if __name__ == '__main__':
    unittest.main()
