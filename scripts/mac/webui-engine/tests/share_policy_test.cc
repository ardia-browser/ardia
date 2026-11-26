#include "ardia/mac/ac_mac_share_policy.h"

#include <cmath>
#include <limits>
#include <memory>
#include <string>

#include "check.h"

namespace policy = ardia_mac::share_policy;

TEST(anchors_need_four_finite_coordinates) {
  const double good[] = {10, 20, 30, 40};
  const auto anchor = policy::AnchorFrom(4, good);
  CHECK(anchor && anchor->x == 10 && anchor->height == 40);
  CHECK(!policy::AnchorFrom(3, good));
  CHECK(!policy::AnchorFrom(4, nullptr));
  const double nan[] = {std::numeric_limits<double>::quiet_NaN(), 0, 1, 1};
  CHECK(!policy::AnchorFrom(4, nan));
  const double huge[] = {1e20, 0, 1, 1};
  CHECK(!policy::AnchorFrom(4, huge));
  const double negative[] = {0, 0, -1, 1};
  CHECK(!policy::AnchorFrom(4, negative));
}

TEST(default_anchor_sits_centred_below_the_toolbar) {
  const auto anchor = policy::DefaultAnchor(1000);
  CHECK_NEAR(anchor.x, 499);
  CHECK_NEAR(anchor.y, 40);
  CHECK_NEAR(anchor.width, 2);
  CHECK(policy::DefaultAnchor(std::numeric_limits<double>::infinity()).x == -1);
}

TEST(edges_face_the_middle_of_the_window) {
  CHECK(policy::EdgeFor(std::nullopt, 1000) == policy::Edge::kBelow);
  CHECK(policy::EdgeFor(policy::Anchor{10, 10, 20, 20}, 1000) == policy::Edge::kTrailing);
  CHECK(policy::EdgeFor(policy::Anchor{900, 10, 20, 20}, 1000) == policy::Edge::kLeading);
}

TEST(zoom_is_sanitized) {
  const auto scaled = policy::Scaled(policy::Anchor{10, 10, 10, 10}, 2);
  CHECK_NEAR(scaled.x, 20);
  CHECK_NEAR(policy::Scaled(policy::Anchor{10, 10, 10, 10}, std::numeric_limits<double>::quiet_NaN()).x, 10);
  CHECK_NEAR(policy::Scaled(policy::Anchor{10, 10, 10, 10}, 1e9).x, 10);
}

TEST(only_web_and_file_links_are_shared) {
  CHECK(policy::ClassifyUrl("https://ardia.dev/") == policy::UrlKind::kWeb);
  CHECK(policy::ClassifyUrl("HTTP://ardia.dev/") == policy::UrlKind::kWeb);
  CHECK(policy::ClassifyUrl("file:///Users/me/Shared") == policy::UrlKind::kFile);
  CHECK(policy::ClassifyUrl("file://host/share") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("javascript:alert(1)") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("data:text/html,x") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("chrome://ardia/") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("https://a.b/\nx") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("") == policy::UrlKind::kRefused);
  CHECK(policy::ClassifyUrl("https://" + std::string(policy::kMaxUrlBytes, 'a')) == policy::UrlKind::kRefused);
}

TEST(text_titles_and_services_are_bounded) {
  CHECK(policy::ShareableText("hello"));
  CHECK(!policy::ShareableText(""));
  CHECK(!policy::ShareableText(std::string(policy::kMaxTextBytes + 1, 'a')));
  CHECK(policy::ValidTitle(std::string(policy::kMaxTitleBytes, 'a')));
  CHECK(!policy::ValidTitle(std::string(policy::kMaxTitleBytes + 1, 'a')));
  CHECK(policy::ValidServiceName("AirDrop"));
  CHECK(!policy::ValidServiceName(""));
  CHECK(!policy::ValidServiceName("Air\nDrop"));
}

TEST(temporary_files_stay_inside_their_directory) {
  CHECK(policy::InsideDirectory("/tmp/images/a.png", "/tmp/images"));
  CHECK(policy::InsideDirectory("/tmp/images/a.png", "/tmp/images/"));
  CHECK(!policy::InsideDirectory("/tmp/images", "/tmp/images"));
  CHECK(!policy::InsideDirectory("/tmp/images/../secret", "/tmp/images"));
  CHECK(!policy::InsideDirectory("/tmp/images/sub/a.png", "/tmp/images"));
  CHECK(!policy::InsideDirectory("/tmp/imagesx/a.png", "/tmp/images"));
  CHECK(!policy::InsideDirectory("/tmp/images/./a.png", "/tmp/images"));
  CHECK(!policy::InsideDirectory("relative/a.png", "/tmp/images"));
  CHECK(!policy::CleanAbsolutePath("/a//b"));
  CHECK(policy::CleanAbsolutePath("/a/b/"));
}

TEST(page_shares_match_ardiacore) {
  policy::PageShareInput page;
  page.page_is_web = true;
  CHECK((policy::SharesFor(page) == std::vector{policy::PageShare::kPage}));
  policy::PageShareInput link = page;
  link.link_is_web = true;
  link.has_selection = true;
  link.selection_is_link_text = true;
  CHECK((policy::SharesFor(link) == std::vector{policy::PageShare::kLink}));
  link.selection_is_link_text = false;
  CHECK((policy::SharesFor(link) == std::vector{policy::PageShare::kText, policy::PageShare::kLink}));
  policy::PageShareInput image = page;
  image.media = policy::PageMedia::kImage;
  image.has_image_contents = true;
  CHECK((policy::SharesFor(image) == std::vector{policy::PageShare::kImage}));
  image.has_image_contents = false;
  CHECK(policy::SharesFor(image).empty());
  policy::PageShareInput editable = link;
  editable.editable = true;
  CHECK(policy::SharesFor(editable).empty());
  policy::PageShareInput video = page;
  video.media = policy::PageMedia::kVideo;
  CHECK(policy::SharesFor(video).empty());
  video.source_is_web = true;
  CHECK((policy::SharesFor(video) == std::vector{policy::PageShare::kVideo}));
}

TEST(page_share_titles_and_kinds) {
  CHECK(policy::ShareTitle(policy::PageShare::kLink, true) == "Share…");
  CHECK(policy::ShareTitle(policy::PageShare::kLink, false) == "Share Link…");
  CHECK(policy::ShareTitle(policy::PageShare::kImage, false) == "Share Image…");
  CHECK(policy::KindName(policy::PageShare::kText) == "text");
  CHECK(policy::ImageExtension("image/jpeg") == "jpg");
  CHECK(policy::ImageExtension("text/html") == "png");
}

TEST(hostile_sinks) {
  const double nan = std::numeric_limits<double>::quiet_NaN();
  const double inf = std::numeric_limits<double>::infinity();
  for (double a : {nan, inf, -inf, 1e20, 1e308, -0.0, 4.9e-324}) {
    const double values[] = {a, a, a, a};
    if (const auto anchor = policy::AnchorFrom(4, values)) {
      CHECK(std::isfinite(anchor->x) && anchor->width >= 0);
    }
    const auto scaled = policy::Scaled(policy::Anchor{1, 1, 1, 1}, a);
    CHECK(std::isfinite(scaled.x));
    CHECK(std::isfinite(policy::DefaultAnchor(a).x));
  }
  for (const char* url : {"file:///../../etc/passwd", "vbscript:x", " https://x", "https://x\x7f"}) {
    CHECK(policy::ClassifyUrl(url) != policy::UrlKind::kWeb);
  }
  CHECK(!policy::InsideDirectory(std::string("/tmp/images/a\0b", 15), "/tmp/images"));
}

TEST(each_context_menu_owns_its_observer_until_it_is_destroyed) {
  struct Observer {
    explicit Observer(int* alive) : alive(alive) { ++*alive; }
    ~Observer() { --*alive; }
    int* alive;
  };
  int alive = 0;
  policy::KeyedOwner<const void*, Observer> observers;
  const int first_menu = 0;
  const int second_menu = 0;
  Observer* first = observers.Attach(&first_menu, std::make_unique<Observer>(&alive));
  Observer* second = observers.Attach(&second_menu, std::make_unique<Observer>(&alive));
  CHECK(alive == 2 && observers.size() == 2);
  CHECK(observers.Find(&first_menu) == first);
  CHECK(observers.Find(&second_menu) == second);
  CHECK(observers.Release(&first_menu));
  CHECK(alive == 1 && observers.Find(&first_menu) == nullptr && observers.Find(&second_menu) == second);
  CHECK(!observers.Release(&first_menu));
  CHECK(observers.Release(&second_menu));
  CHECK(alive == 0 && observers.size() == 0);
}

TEST(only_issued_images_are_taken_and_only_by_their_window) {
  policy::IssuedFiles<std::string> issued;
  const auto by = [](std::string window) { return [window](const std::string& owner) { return owner == window; }; };
  CHECK(issued.Reserve("/tmp/i/1-a/one.png", "w1").issued);
  CHECK(issued.Reserve("/tmp/i/1-a/two.png", "w2").issued);
  CHECK(!issued.Reserve("/tmp/i/1-a/one.png", "w2").issued);
  CHECK(!issued.Take("/tmp/i/1-a/one.png", by("w1")));
  CHECK(issued.Publish("/tmp/i/1-a/one.png") && !issued.Publish("/tmp/i/1-a/one.png"));
  CHECK(!issued.Take("/tmp/i/1-a/one.png", by("w2")));
  CHECK(issued.Shareable("/tmp/i/1-a/one.png"));
  CHECK(issued.Take("/tmp/i/1-a/one.png", by("w1")));
  CHECK(!issued.Take("/tmp/i/1-a/one.png", by("w1")));
  CHECK(issued.SlotOf("/tmp/i/1-a/one.png") == policy::Slot::kTaken);
  CHECK(!issued.Take("/tmp/i/1-a/never.png", by("w1")));
  CHECK(issued.Release("/tmp/i/1-a/one.png") && issued.Release("/tmp/i/1-a/two.png"));
  CHECK(issued.size() == 0);
}

TEST(a_retired_window_cancels_its_reserved_and_issued_images_but_not_one_a_service_holds) {
  policy::IssuedFiles<std::string> issued;
  CHECK(issued.Reserve("/tmp/i/1-a/writing.png", "w1").issued);
  CHECK(issued.Reserve("/tmp/i/1-a/ready.png", "w1").issued && issued.Publish("/tmp/i/1-a/ready.png"));
  CHECK(issued.Reserve("/tmp/i/1-a/held.png", "w1").issued && issued.Publish("/tmp/i/1-a/held.png"));
  CHECK(issued.Take("/tmp/i/1-a/held.png", [](const std::string&) { return true; }));
  CHECK(issued.Reserve("/tmp/i/1-a/other.png", "w2").issued);
  std::vector<std::string> cancelled;
  const auto revoked = issued.RevokeUnheld([&cancelled](const std::string& owner) {
    if (owner != "w1") return false;
    cancelled.push_back(owner);
    return true;
  });
  CHECK((revoked.written == std::vector<std::string>{"/tmp/i/1-a/ready.png"}));
  CHECK((revoked.writing == std::vector<std::string>{"/tmp/i/1-a/writing.png"}));
  CHECK(cancelled.size() == 2);
  CHECK(issued.SlotOf("/tmp/i/1-a/held.png") == policy::Slot::kTaken);
  CHECK(issued.SlotOf("/tmp/i/1-a/other.png") == policy::Slot::kReserved);
  CHECK(!issued.Publish("/tmp/i/1-a/writing.png"));
  CHECK(issued.Holds("/tmp/i/1-a/writing.png") && issued.size() == 4);
  CHECK(policy::KeepsServiceAfterRetire(true) && !policy::KeepsServiceAfterRetire(false));
}

TEST(taken_images_hold_their_slot_until_the_file_is_deleted) {
  policy::IssuedFiles<std::string> issued;
  const auto anyone = [](const std::string&) { return true; };
  for (std::size_t index = 0; index < policy::kMaxIssuedFiles; ++index) {
    const std::string path = "/tmp/i/1-a/" + std::to_string(index) + ".png";
    CHECK(issued.Reserve(path, "w1").issued && issued.Publish(path));
  }
  CHECK(issued.Take("/tmp/i/1-a/0.png", anyone));
  const auto full = issued.Reserve("/tmp/i/1-a/next.png", "w1");
  CHECK(!full.issued && full.evicted == std::optional<std::string>("/tmp/i/1-a/1.png"));
  CHECK(issued.SlotOf("/tmp/i/1-a/1.png") == policy::Slot::kRevoked && issued.size() == policy::kMaxIssuedFiles);
  CHECK(issued.Release("/tmp/i/1-a/1.png"));
  CHECK(issued.Reserve("/tmp/i/1-a/next.png", "w1").issued);
  for (std::size_t index = 2; index < policy::kMaxIssuedFiles; ++index) {
    CHECK(issued.Take("/tmp/i/1-a/" + std::to_string(index) + ".png", anyone));
  }
  const auto refused = issued.Reserve("/tmp/i/1-a/later.png", "w1");
  CHECK(!refused.issued && !refused.evicted && !issued.Holds("/tmp/i/1-a/later.png"));
  CHECK(issued.Revoke("/tmp/i/1-a/0.png") && issued.Holds("/tmp/i/1-a/0.png"));
  CHECK(!issued.Reserve("/tmp/i/1-a/later.png", "w1").issued);
  CHECK(issued.Release("/tmp/i/1-a/0.png"));
  CHECK(issued.Reserve("/tmp/i/1-a/later.png", "w1").issued);
}

TEST(unlinks_retry_with_backoff_and_then_give_up) {
  CHECK(policy::NextUnlinkStep(0, true) == policy::UnlinkStep::kRelease);
  CHECK(policy::NextUnlinkStep(3, true) == policy::UnlinkStep::kRelease);
  for (int attempt = 0; attempt + 1 < policy::kMaxUnlinkAttempts; ++attempt) {
    CHECK(policy::NextUnlinkStep(attempt, false) == policy::UnlinkStep::kRetry);
    CHECK(policy::UnlinkRetryDelayMs(attempt + 1) == 2 * policy::UnlinkRetryDelayMs(attempt));
  }
  CHECK(policy::NextUnlinkStep(policy::kMaxUnlinkAttempts - 1, false) == policy::UnlinkStep::kGiveUp);
  int attempts = 1;
  for (int attempt = 0; policy::NextUnlinkStep(attempt, false) == policy::UnlinkStep::kRetry; ++attempt) ++attempts;
  CHECK(attempts == policy::kMaxUnlinkAttempts && policy::kMaxUnlinkAttempts == 5);
  CHECK(policy::UnlinkRetryDelayMs(0) == policy::kFirstUnlinkRetryMs);
  CHECK(policy::UnlinkRetryDelayMs(1000) == policy::UnlinkRetryDelayMs(policy::kMaxUnlinkAttempts));
  CHECK(policy::UnlinkRetryDelayMs(-5) == policy::kFirstUnlinkRetryMs);
}

TEST(leftover_staging_folders_are_reaped_only_for_dead_unlocked_processes) {
  CHECK(policy::StagingPid(".42-0f3a.staging") == 42);
  CHECK(!policy::StagingPid("42-0f3a.staging"));
  CHECK(!policy::StagingPid(".42-0f3a"));
  CHECK(!policy::StagingPid(".x.staging"));
  CHECK(!policy::StagingPid(".staging"));
  CHECK(policy::SweepsStaging(false, false, false));
  CHECK(!policy::SweepsStaging(false, false, true));
  CHECK(!policy::SweepsStaging(false, true, false));
  CHECK(!policy::SweepsStaging(true, false, false));
}

TEST(a_chosen_service_survives_either_callback_order) {
  CHECK(policy::SameChoice(false, false));
  CHECK(policy::SameChoice(true, true));
  CHECK(!policy::SameChoice(true, false));
}

TEST(share_commands_sit_outside_chromiums_custom_ranges) {
  CHECK(policy::kShareCommandFirst == 54100);
  CHECK(policy::kShareCommandLast == policy::kShareCommandFirst + static_cast<int>(policy::kMaxPageShares) - 1);
  CHECK(policy::kShareCommandFirst > 49000 + 1000);
  CHECK(policy::kShareCommandLast < 0xE000);
}

TEST(only_exited_instances_are_swept) {
  using Lock = policy::InstanceLock;
  CHECK(policy::SweepsInstance(true, false, Lock::kFree, true));
  CHECK(policy::SweepsInstance(true, false, Lock::kFree, false));
  CHECK(!policy::SweepsInstance(true, false, Lock::kHeld, false));
  CHECK(!policy::SweepsInstance(true, false, Lock::kHeld, true));
  CHECK(policy::SweepsInstance(true, false, Lock::kMissing, false));
  CHECK(!policy::SweepsInstance(true, false, Lock::kMissing, true));
  CHECK(!policy::SweepsInstance(true, true, Lock::kFree, false));
  CHECK(!policy::SweepsInstance(false, false, Lock::kFree, false));
}

TEST(instance_directories_name_their_process) {
  CHECK(policy::InstanceDirectoryName(42, "0f3a-99") == std::optional<std::string>("42-0f3a-99"));
  CHECK(!policy::InstanceDirectoryName(0, "ab"));
  CHECK(!policy::InstanceDirectoryName(42, ""));
  CHECK(!policy::InstanceDirectoryName(42, "../x"));
  CHECK(policy::InstancePid("42-0f3a-99") == 42);
  CHECK(!policy::InstancePid("42"));
  CHECK(!policy::InstancePid("-ab"));
  CHECK(!policy::InstancePid("42-"));
  CHECK(!policy::InstancePid("4x-ab"));
  CHECK(!policy::InstancePid("42-AB"));
  CHECK(!policy::InstancePid("99999999999-ab"));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
