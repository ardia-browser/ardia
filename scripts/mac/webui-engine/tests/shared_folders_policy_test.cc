#include "ardia/mac/ac_mac_shared_folders_policy.h"

#include <cmath>
#include <limits>
#include <string>
#include <vector>

#include "check.h"

namespace policy = ardia_mac::shared_folders_policy;

TEST(relative_parts_stay_inside_the_folder) {
  const auto parts = policy::RelativeParts("Reading/Essay.webloc");
  CHECK(parts && parts->size() == 2 && (*parts)[0] == "Reading" && (*parts)[1] == "Essay.webloc");
  CHECK(policy::RelativeParts("a//b.webloc")->size() == 2);
  CHECK(!policy::RelativeParts(""));
  CHECK(!policy::RelativeParts("/etc/passwd"));
  CHECK(!policy::RelativeParts("../escape.webloc"));
  CHECK(!policy::RelativeParts("a/../b.webloc"));
  CHECK(!policy::RelativeParts("./a.webloc"));
  CHECK(!policy::RelativeParts("a/./b"));
  CHECK(!policy::RelativeParts("///"));
  CHECK(!policy::RelativeParts(std::string("a\0b", 3)));
  CHECK(!policy::RelativeParts(std::string(256, 'a')));
  std::string deep;
  for (int i = 0; i < 40; ++i) deep += "d/";
  CHECK(!policy::RelativeParts(deep + "x.webloc"));
}

TEST(links_and_the_manifest_are_the_only_writable_names) {
  CHECK(policy::IsLinkName("GitHub.webloc"));
  CHECK(policy::IsLinkName("GitHub.WEBLOC"));
  CHECK(!policy::IsLinkName(".webloc"));
  CHECK(!policy::IsLinkName("GitHub.webloc.txt"));
  CHECK(!policy::IsLinkName("webloc"));
  CHECK(policy::WritableName(".ardia-folder.json"));
  CHECK(!policy::WritableName("notes.txt"));
}

TEST(placeholders_name_their_file) {
  CHECK(policy::PlaceholderTarget(".Docs.webloc.icloud") == "Docs.webloc");
  CHECK(policy::PlaceholderTarget("..ardia-folder.json.icloud") == ".ardia-folder.json");
  CHECK(!policy::PlaceholderTarget(".icloud"));
  CHECK(!policy::PlaceholderTarget("Docs.webloc.icloud"));
  CHECK(policy::PlaceholderFor("Docs.webloc") == ".Docs.webloc.icloud");
  CHECK(policy::IsHousekeeping(".DS_Store"));
  CHECK(policy::IsHousekeeping(policy::PlaceholderFor(policy::kManifestName)));
  CHECK(!policy::IsHousekeeping("Docs.webloc"));
}

TEST(folder_names_follow_the_swift_rules) {
  CHECK(policy::FolderName("Team Links") == "Team Links");
  CHECK(policy::FolderName("a/b:c") == "a-b-c");
  CHECK(policy::FolderName("  ..hidden  ") == "hidden");
  CHECK(policy::FolderName("") == "Shared Folder");
  CHECK(policy::FolderName("...") == "Shared Folder");
  CHECK(policy::FolderName(std::string(300, 'a')).size() == 200);
  std::string accents;
  for (int i = 0; i < 150; ++i) accents += "\xc3\xa9";
  const std::string capped = policy::FolderName(accents);
  CHECK(capped.size() == 200);
  CHECK(policy::NumberedName("Links", 1) == "Links");
  CHECK(policy::NumberedName("Links", 3) == "Links 3");
}

TEST(system_and_home_folders_are_refused) {
  CHECK(policy::RefusedFolder("/", "/Users/me"));
  CHECK(policy::RefusedFolder("/Users", "/Users/me"));
  CHECK(policy::RefusedFolder("/Users/me", "/Users/me"));
  CHECK(policy::RefusedFolder("/Users/other", "/Users/me"));
  CHECK(policy::RefusedFolder("/private/var", "/Users/me"));
  CHECK(!policy::RefusedFolder("/Users/me/Shared", "/Users/me"));
  CHECK(!policy::RefusedFolder("/Volumes/NAS/Links", "/Users/me"));
}

TEST(identities_are_whole_numbers) {
  CHECK((policy::IdentityFrom(16777231, 1234) == policy::Identity{16777231, 1234}));
  CHECK(!policy::IdentityFrom(-1, 1));
  CHECK(!policy::IdentityFrom(1.5, 1));
  CHECK(!policy::IdentityFrom(std::numeric_limits<double>::quiet_NaN(), 1));
  CHECK(!policy::IdentityFrom(1, 1e300));
}

TEST(watch_hits_cover_parents_and_children) {
  CHECK(policy::WatchHit("/a/b", "/a/b"));
  CHECK(policy::WatchHit("/a/b", "/a/b/c.webloc"));
  CHECK(policy::WatchHit("/a/b", "/a"));
  CHECK(!policy::WatchHit("/a/b", "/a/bc"));
  CHECK(!policy::WatchHit("/a/bc", "/a/b"));
  CHECK(!policy::WatchHit("", "/a"));
  CHECK(policy::WatchedPathsValid({"/a", "/b"}));
  CHECK(!policy::WatchedPathsValid({"relative"}));
  CHECK(!policy::WatchedPathsValid(std::vector<std::string>(policy::kMaxWatched + 1, "/a")));
}

TEST(ops_come_from_a_fixed_list) {
  CHECK(policy::OpNamed("write") == policy::OpKind::kWrite);
  CHECK(policy::OpNamed("rmdir") == policy::OpKind::kRmdir);
  CHECK(policy::OpNamed("Write") == policy::OpKind::kUnknown);
  CHECK(policy::OpNamed("") == policy::OpKind::kUnknown);
}

TEST(hostile_sinks) {
  for (const char* path : {"..", ".", "a/..", "\x01", "a/\n/b"}) {
    if (const auto parts = policy::RelativeParts(path)) {
      for (const std::string& part : *parts) CHECK(part != ".." && part != "." && part.find('/') == std::string::npos);
    }
  }
  const double inf = std::numeric_limits<double>::infinity();
  for (double value : {inf, -inf, 1e20, -0.0, 4.9e-324, 9007199254740992.0}) {
    if (const auto identity = policy::IdentityFrom(value, value)) CHECK(identity->device >= 0 && identity->inode >= 0);
  }
  CHECK(!policy::ValidAbsolutePath(std::string("/a\0b", 4)));
  CHECK(!policy::ValidAbsolutePath(std::string(policy::kMaxPathBytes + 1, '/')));
}

TEST(a_stalled_coordinator_times_out_and_never_starts_late) {
  policy::CoordinationGate stalled;
  CHECK(stalled.Expire());
  CHECK(!stalled.Begin());
  CHECK(stalled.GaveUp() && !stalled.Started());
  CHECK(policy::CoordinationOutcome(false, stalled) == policy::Coordination::kTimedOut);
  CHECK(!stalled.Expire());
}

TEST(a_started_coordinator_is_never_cancelled) {
  policy::CoordinationGate started;
  CHECK(started.Begin());
  CHECK(!started.Expire());
  CHECK(started.Begin());
  CHECK(started.Started() && !started.GaveUp());
  CHECK(policy::CoordinationOutcome(true, started) == policy::Coordination::kRan);
}

TEST(a_coordinator_error_is_a_failure_not_a_timeout) {
  policy::CoordinationGate refused;
  CHECK(policy::CoordinationOutcome(false, refused) == policy::Coordination::kFailed);
  CHECK(policy::kCoordinationTimeoutSeconds == 20);
}

TEST(a_failed_rename_announces_no_move) {
  CHECK(policy::MovedTo(true));
  CHECK(!policy::MovedTo(false));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
