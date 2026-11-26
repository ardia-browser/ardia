#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <limits>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "ardia/mac/ac_mac_backdrop_theme.h"
#include "ardia/mac/ac_mac_dialog_policy.h"
#include "ardia/mac/ac_mac_extension_view_policy.h"
#include "ardia/mac/ac_mac_glass_layout.h"
#include "ardia/mac/ac_mac_link_policy.h"
#include "ardia/mac/ac_mac_menu_model.h"
#include "ardia/mac/ac_mac_menu_state.h"
#include "ardia/mac/ac_mac_page_policy.h"
#include "ardia/mac/ac_mac_pip_policy.h"
#include "ardia/mac/ac_mac_popover_policy.h"
#include "ardia/mac/ac_mac_share_policy.h"
#include "ardia/mac/ac_mac_shared_folders_policy.h"
#include "ardia/mac/ac_mac_shell_policy.h"
#include "ardia/mac/ac_mac_system_policy.h"
#include "ardia/mac/ac_mac_webui_policy.h"
#include "ardia/mac/ac_mac_window_layout.h"
#include "ardia/mac/ac_mac_window_policy.h"
#include "check.h"
#include "launch_args.h"

namespace {

struct Corpus {
  std::vector<std::string> strings;
  std::vector<double> numbers;
};

int HexDigit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

const Corpus& Load() {
  static const Corpus corpus = [] {
    Corpus loaded;
    const char* path = std::getenv("ARDIA_HOSTILE_CORPUS");
    if (!path) return loaded;
    std::ifstream file(path);
    std::string line;
    while (std::getline(file, line)) {
      std::istringstream fields(line);
      std::string kind, id, value;
      fields >> kind >> id;
      std::getline(fields >> std::ws, value);
      if (kind == "s") {
        std::string bytes;
        for (std::size_t index = 0; index + 1 < value.size(); index += 2) {
          const int high = HexDigit(value[index]);
          const int low = HexDigit(value[index + 1]);
          if (high < 0 || low < 0) break;
          bytes.push_back(static_cast<char>(high * 16 + low));
        }
        loaded.strings.push_back(bytes);
        loaded.strings.push_back("x" + bytes);
        loaded.strings.push_back(bytes + "webui");
      } else if (kind == "n") {
        loaded.numbers.push_back(value == "NaN" ? std::numeric_limits<double>::quiet_NaN()
                                 : value == "Infinity" ? std::numeric_limits<double>::infinity()
                                                       : std::strtod(value.c_str(), nullptr));
      }
    }
    for (double extra : {-std::numeric_limits<double>::infinity(), 1e20, -1e20, 1e308, -0.0, 4.9e-324}) {
      loaded.numbers.push_back(extra);
    }
    return loaded;
  }();
  return corpus;
}

bool Charset(std::string_view text, std::string_view extra) {
  for (char c : text) {
    const bool alnum = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
    if (!alnum && extra.find(c) == std::string_view::npos) return false;
  }
  return true;
}

bool NoControls(std::string_view text) {
  for (char c : text) {
    const auto byte = static_cast<unsigned char>(c);
    if (byte < 0x20 || byte == 0x7f) return false;
  }
  return true;
}

}

TEST(corpus_is_loaded) {
  CHECK(Load().strings.size() >= 300);
  CHECK(Load().numbers.size() >= 10);
}

TEST(glass_names_and_ids) {
  for (const std::string& text : Load().strings) {
    if (ardia_mac::backdrop_theme::KnownTexture(text)) {
      CHECK(text == "film" || text == "grain" || text == "sand" || text == "denim" || text == "tweed");
    }
    if (ardia_mac::glass::ValidId(text)) {
      CHECK(!text.empty() && text.size() <= ardia_mac::glass::kMaxIdLength && Charset(text, "-_:."));
    }
    if (const auto layer = ardia_mac::glass::LayerNamed(text)) {
      CHECK(text.empty() || text == "auto" || text == "behind" || text == "window" || text == "sidebar" ||
            text == "over_page" || text == "overPage" || text == "page");
    }
    if (ardia_mac::glass::MaterialNamed(text)) {
      CHECK(Charset(text, ""));
    }
    ardia_mac::glass::Region region;
    region.id = text;
    region.rect = {0, 0, 10, 10};
    const auto layout = ardia_mac::glass::Lay({region}, {}, {0, 0, 100, 100}, 1);
    for (const auto& placement : layout.placements) CHECK(ardia_mac::glass::ValidId(placement.id));
  }
  ardia_mac::glass::Region control;
  control.id = "control";
  control.rect = {0, 0, 10, 10};
  CHECK(ardia_mac::glass::Lay({control}, {}, {0, 0, 100, 100}, 1).placements.size() == 1);
}

TEST(native_backdrop_theme) {
  namespace theme = ardia_mac::backdrop_theme;
  for (double a : Load().numbers) {
    for (double b : Load().numbers) {
      if (const auto color = theme::ColorFrom({a, b, a, b, a})) {
        for (double channel : {color->red, color->green, color->blue, color->alpha}) CHECK(channel >= 0 && channel <= 1);
        CHECK(std::isfinite(a) && std::isfinite(b));
      }
      const int pixels = theme::GrainImagePixels(a, b, a);
      CHECK(pixels >= 1 && pixels <= theme::kMaxGrainImagePixels);
    }
    if (const auto point = theme::GradientPoint(a)) CHECK(std::isfinite(*point) && std::abs(*point) <= theme::kMaxGradientReach);
    const double radius = theme::ThemeRadius(a);
    CHECK(radius >= 0 && radius <= theme::kMaxThemeRadius);
    const double points = theme::GrainPoints(a);
    CHECK(points > 0 && points <= theme::kMaxGrainPoints);
    CHECK(theme::Unit(a) >= 0 && theme::Unit(a) <= 1);
    if (std::isfinite(a) && a >= 0 && a < 1e6) {
      const auto count = static_cast<std::size_t>(a);
      if (theme::LayerCountFits(count)) CHECK(count <= theme::kMaxLayers);
      if (theme::StopCountFits(count)) CHECK(count >= 1 && count <= theme::kMaxStops);
    }
  }
  for (const std::string& text : Load().strings) {
    const auto index = theme::BackdropIndex(text, 64);
    if (index) CHECK(*index < 64 && text == theme::BackdropId(*index));
  }
  CHECK(theme::ColorFrom({1, 0.5, 0, 1, 1}).has_value());
  CHECK(theme::BackdropIndex("backdrop:3", 64) == std::optional<std::size_t>(3));
}

TEST(glass_geometry) {
  for (double a : Load().numbers) {
    for (double b : Load().numbers) {
      ardia_mac::glass::Region region;
      region.id = "g";
      region.rect = {a, b, a, b};
      region.radii = {a, b, a, b};
      region.opacity = a;
      region.blur = b;
      const auto layout = ardia_mac::glass::Lay({region}, {{1, {a, b, 500, 500}}}, {0, 0, 1280, 800}, a);
      for (const auto& placement : layout.placements) {
        CHECK(std::isfinite(placement.frame.x) && std::isfinite(placement.frame.width));
        CHECK(placement.opacity >= 0 && placement.opacity <= 1 && std::isfinite(placement.radius));
      }
      const int narrowed = ardia_mac::glass::ClampToInt(a);
      CHECK(narrowed >= -1000000 && narrowed <= 1000000);
      if (const auto generation = ardia_mac::glass::PresentableGeneration(a)) CHECK(*generation >= 0 && *generation == a);
      const auto shape = ardia_mac::glass::ShapeFor({a, b, a, b});
      CHECK(std::isfinite(shape.radii.upper_left) && shape.radii.upper_left >= 0);
      CHECK(std::isfinite(ardia_mac::glass::NativeCornerRadius(shape)));
    }
  }
}

TEST(popover_guards) {
  for (const std::string& text : Load().strings) {
    if (ardia_mac::popover::ValidId(text)) CHECK(text.size() <= 128 && Charset(text, "-_"));
    if (ardia_mac::popover::ValidRoute(text)) {
      CHECK(text.find("..") == std::string::npos && text.front() != '/' && Charset(text, "-_/."));
    }
    if (const auto reason = ardia_mac::popover::ReasonNamed(text)) CHECK(Charset(text, ""));
    if (const auto edge = ardia_mac::popover::EdgeNamed(text)) CHECK(Charset(text, ""));
  }
  for (double a : Load().numbers) {
    for (double b : Load().numbers) {
      const ardia_mac::popover::Rect hostile{a, b, a, b};
      if (const auto mapped = ardia_mac::popover::WindowToScreen(hostile, {0, 0, 1280, 800}, b)) {
        CHECK(std::isfinite(mapped->x) && std::isfinite(mapped->height));
      }
      if (const auto clamped = ardia_mac::popover::ClampToScreen(hostile, hostile, {{0, 25, 1440, 875}}, a > 0,
                                                                 {0, 0, 1280, 800})) {
        CHECK(clamped->frame.x >= 0 && clamped->frame.right() <= 1440 + 0.5);
      }
    }
  }
  CHECK(ardia_mac::popover::ValidRoute("downloads") && ardia_mac::popover::ValidId("popover-main-1"));
}

TEST(menu_construction) {
  for (const std::string& text : Load().strings) {
    ardia_mac::menu::Item root;
    ardia_mac::menu::Item item;
    item.title = text;
    item.command = text;
    item.key = text;
    item.argument = text;
    root.children.push_back(item);
    if (ardia_mac::menu::Validate(root).empty()) {
      CHECK(text.size() <= ardia_mac::menu::kMaxCommand && NoControls(text) && Charset(text, "._-:"));
      CHECK(ardia_mac::menu::ValidKey(text));
    }
    CHECK(!ardia_mac::menu::RoleNamed(text) || Charset(text, ""));
    ardia_mac::menu::Describe(root);
  }
  ardia_mac::menu::Item control;
  ardia_mac::menu::Item open;
  open.title = "Open";
  open.command = "open";
  open.key = "o";
  control.children.push_back(open);
  CHECK(ardia_mac::menu::Validate(control).empty());
}

TEST(menu_state_and_bookmarks) {
  ardia_mac::menu::Bookmarks bookmarks;
  for (const std::string& text : Load().strings) {
    ardia_mac::menu::State state;
    if (ardia_mac::menu::AddStateEntry(state.disabled, text)) {
      CHECK(!text.empty() && text.size() <= ardia_mac::menu::kMaxStateId && NoControls(text));
    }
    if (ardia_mac::menu::AddStateTitle(state, "id", text)) {
      CHECK(ardia_mac::menu::ValidTitle(text));
    }
    const std::string clean = ardia_mac::menu::CleanTitle(text);
    CHECK(ardia_mac::menu::ValidTitle(clean));
    const auto shown = ardia_mac::menu::Resolve(text, false, false, clean, state);
    CHECK(shown.title == clean || ardia_mac::menu::ValidTitle(shown.title));
    bookmarks.other.push_back({text, text, text, false, {}});
    ardia_mac::menu::Bookmark folder{text, text, "", true, {}};
    folder.children.push_back({text + "child", text, text, false, {}});
    bookmarks.bar.push_back(folder);
  }
  ardia_mac::menu::Item root;
  root.children = ardia_mac::menu::BookmarkMenuItems(bookmarks);
  std::size_t problems = 0;
  for (const auto& problem : ardia_mac::menu::Validate(root)) {
    problems += problem.reason == "too many items" || problem.reason == "too deep" ? 0 : 1;
  }
  CHECK(problems == 0);
}

TEST(glass_tints_groups_and_appearance) {
  for (const std::string& text : Load().strings) {
    if (const auto color = ardia_mac::glass::ColorFrom(text)) {
      for (double channel : {color->red, color->green, color->blue, color->alpha}) {
        CHECK(std::isfinite(channel) && channel >= 0 && channel <= 1);
      }
      CHECK(Charset(text, "#(),. "));
    }
    if (ardia_mac::glass::ValidGroup(text)) CHECK(text.size() <= ardia_mac::glass::kMaxIdLength && Charset(text, "-_:."));
    if (ardia_mac::glass::AppearanceNamed(text)) CHECK(text.empty() || text == "auto" || text == "light" || text == "dark");
    if (ardia_mac::popover::MessageFits(text.size())) CHECK(text.size() <= ardia_mac::popover::kMaxMessageBytes);
  }
  CHECK(ardia_mac::glass::ColorFrom("rgba(10,20,30,0.5)").has_value());
}

TEST(window_guards) {
  for (double a : Load().numbers) {
    for (double b : Load().numbers) {
      if (const auto lights = ardia_mac::window::LightsFrom(a, b, false, {1280, 800})) {
        CHECK(lights->center.x >= 0 && lights->center.x <= 1280 && lights->center.y >= 0 && lights->center.y <= 800);
        const auto zoom = ardia_mac::window::ButtonOrigin(*lights, {14, 14}, 800, 2);
        CHECK(zoom.x + ardia_mac::window::kButtonSide <= 1280);
      }
    }
  }
  for (const std::string& text : Load().strings) {
    const auto action = ardia_mac::window::CaptionActionFor(text, std::nullopt, false);
    if (action == ardia_mac::window::CaptionAction::kMinimize) CHECK(text == "Minimize");
    if (action == ardia_mac::window::CaptionAction::kNone) CHECK(text == "None");
    CHECK(ardia_mac::window::CaptionActionFor(text, true, true) == ardia_mac::window::CaptionAction::kNone);
  }
  CHECK(ardia_mac::window::LightsFrom(25, 20, false, {1280, 800}).has_value());
}

TEST(window_requests) {
  namespace policy = ardia_mac::shell_policy;
  for (const std::string& text : Load().strings) {
    for (const std::string_view kind : {std::string_view(), std::string_view("settings"), std::string_view(text)}) {
      if (policy::CheckWindowRequest({text, kind, text, false, false}) == policy::WindowRefusal::kNone) {
        CHECK(!text.empty() && text.size() <= policy::kWindowIdLimit && Charset(text, "_-:."));
        CHECK(!policy::UtilityKind(text) || text == kind);
        CHECK(text == "default" || policy::ValidProfileId(text));
        CHECK(policy::PageProfileFor(kind, text).empty() || policy::ValidProfileId(policy::PageProfileFor(kind, text)));
      }
      CHECK(policy::CheckWindowRequest({text, kind, "", true, false}) != policy::WindowRefusal::kNone);
    }
  }
  CHECK(policy::CheckWindowRequest({"settings", "settings", "", false, false}) == policy::WindowRefusal::kNone);
}

TEST(bridge_documents) {
  for (const std::string& text : Load().strings) {
    if (ardia_mac::shell_policy::ValidDocumentName(text)) {
      CHECK(text.size() <= 200 && text.front() != '.' && Charset(text, "._-"));
      CHECK(!ardia_mac::shell_policy::EqualsIgnoringAsciiCase(text, "session.json"));
    }
    if (ardia_mac::shell_policy::ReservedLiveDocument(text)) {
      CHECK(ardia_mac::shell_policy::EqualsIgnoringAsciiCase(text, "live.json") ||
            ardia_mac::shell_policy::EqualsIgnoringAsciiCase(text, "live.canonical.json"));
    }
  }
  CHECK(ardia_mac::shell_policy::ReservedLiveDocument("LIVE.CANONICAL.JSON"));
  CHECK(ardia_mac::shell_policy::ValidDocumentName("notes.json"));
  for (const std::string& text : Load().strings) {
    if (const auto id = ardia_mac::shell_policy::ParseAdoptId(text)) {
      CHECK(*id > 0 && text == "tab:" + std::to_string(*id));
    }
    if (ardia_mac::shell_policy::ClassifyAdoptField(true, true, text) == ardia_mac::shell_policy::AdoptField::kId) {
      CHECK(text.starts_with("tab:") && Charset(text.substr(4), ""));
    }
  }
  CHECK(ardia_mac::shell_policy::ParseAdoptId("tab:12") == 12);
}

TEST(launch_environment) {
  for (const std::string& text : Load().strings) {
    namespace policy = ardia_mac::webui_policy;
    if (policy::Active(policy::Decide(policy::Build::kDevelopment, text, text))) CHECK(text == "webui");
    CHECK(!policy::Active(policy::Decide(policy::Build::kRelease, text, text)));
    if (policy::Background(false, text)) CHECK(text == "1" || text == "true");
    ArdiaLaunchStorage storage;
    const char* argv[] = {"Ardia"};
    const char* out[1 + kArdiaLaunchExtraArgs + 1] = {};
    const int count = ArdiaBuildLaunchArgs(1, argv, text.c_str(), text.c_str(), text.c_str(), &storage, out);
    CHECK(count >= 1 && count <= 1 + kArdiaLaunchExtraArgs);
    for (int index = 1; index < count; ++index) {
      const std::string_view arg = out[index];
      CHECK(arg.starts_with("--user-data-dir=") || arg.starts_with("--ardia-data-dir=") ||
            arg == "--use-mock-keychain" || arg == "--ardia-shell=webui" || arg == "--ardia-background");
      CHECK(arg.size() < kArdiaLaunchPathLimit + 32);
    }
  }
  CHECK(ardia_mac::webui_policy::Active(
      ardia_mac::webui_policy::Decide(ardia_mac::webui_policy::Build::kDevelopment, "webui", std::nullopt)));
}

TEST(share_guards) {
  namespace share = ardia_mac::share_policy;
  for (const std::string& text : Load().strings) {
    const share::UrlKind kind = share::ClassifyUrl(text);
    if (kind != share::UrlKind::kRefused) {
      CHECK(NoControls(text) && text.size() <= share::kMaxUrlBytes);
      CHECK(text.find(':') != std::string::npos);
      const std::string scheme = ardia_mac::shared_folders_policy::LowerAscii(text.substr(0, text.find(':')));
      CHECK(kind == share::UrlKind::kWeb ? (scheme == "http" || scheme == "https") : scheme == "file");
      if (kind == share::UrlKind::kFile) CHECK(text.substr(5, 3) == "///");
    }
    if (share::ValidServiceName(text)) CHECK(NoControls(text) && !text.empty() && text.size() <= share::kMaxServiceBytes);
    if (share::InsideDirectory(text, "/tmp/ardia-images")) {
      CHECK(text.starts_with("/tmp/ardia-images/") && text.find("..") == std::string::npos && NoControls(text));
      CHECK(text.find('/', 18) == std::string::npos);
    }
  }
  for (double a : Load().numbers) {
    for (double b : Load().numbers) {
      const double values[] = {a, b, a, b};
      if (const auto anchor = share::AnchorFrom(4, values)) {
        CHECK(std::isfinite(anchor->x) && std::isfinite(anchor->y) && anchor->width >= 0 && anchor->height >= 0);
        const auto scaled = share::Scaled(*anchor, b);
        CHECK(std::isfinite(scaled.x) && std::isfinite(scaled.height));
      }
    }
  }
  for (const std::string& text : Load().strings) {
    if (const auto pid = share::InstancePid(text)) {
      CHECK(*pid > 0 && text.starts_with(std::to_string(*pid) + "-") && Charset(text, "-"));
      CHECK(text.find('/') == std::string::npos && text.find("..") == std::string::npos);
    }
    if (const auto name = share::InstanceDirectoryName(1, text)) CHECK(Charset(*name, "-") && name->find('/') == std::string::npos);
    share::IssuedFiles<std::string> issued;
    issued.Reserve("/tmp/ardia-images/1-a/image.png", "w1");
    issued.Publish("/tmp/ardia-images/1-a/image.png");
    if (const auto staging = share::StagingPid(text)) CHECK(*staging > 0 && text.front() == '.' && text.ends_with(".staging"));
    const auto window = [&text](const std::string& owner) { return owner == text; };
    CHECK(!issued.Take(text, [](const std::string& owner) { return owner == "w1"; }) ||
          text == "/tmp/ardia-images/1-a/image.png");
    CHECK(!issued.Take("/tmp/ardia-images/1-a/image.png", window) || text == "w1");
    if (share::SweepsInstance(share::InstancePid(text).has_value(), false, share::InstanceLock::kFree, true)) {
      CHECK(share::InstancePid(text).has_value());
    }
  }
  CHECK(share::ClassifyUrl("https://ardia.dev/") == share::UrlKind::kWeb);
}

TEST(shared_folder_guards) {
  namespace folders = ardia_mac::shared_folders_policy;
  for (const std::string& text : Load().strings) {
    if (const auto parts = folders::RelativeParts(text)) {
      CHECK(!parts->empty() && parts->size() <= folders::kMaxParts);
      for (const std::string& part : *parts) {
        CHECK(!part.empty() && part != "." && part != ".." && part.find('/') == std::string::npos);
        CHECK(part.find('\0') == std::string::npos && part.size() <= folders::kMaxNameBytes);
      }
    }
    const std::string name = folders::FolderName(text);
    CHECK(!name.empty() && name.size() <= folders::kMaxFolderNameBytes && NoControls(name));
    CHECK(name.find('/') == std::string::npos && name.find(':') == std::string::npos && name.front() != '.');
    if (folders::ValidAbsolutePath(text)) CHECK(text.front() == '/' && text.find('\0') == std::string::npos);
    if (folders::WritableName(text)) CHECK(folders::IsManifest(text) || folders::IsLinkName(text));
    CHECK(folders::OpNamed(text) == folders::OpKind::kUnknown || Charset(text, ""));
  }
  for (double a : Load().numbers) {
    if (const auto identity = folders::IdentityFrom(a, a)) CHECK(identity->device >= 0 && identity->inode >= 0);
  }
  CHECK(folders::RelativeParts("Reading/Essay.webloc").has_value());
}

TEST(system_files_and_links) {
  namespace system = ardia_mac::system_policy;
  const std::vector<std::string> known = {"/Users/me/Downloads/a.zip"};
  for (const std::string& text : Load().strings) {
    if (system::ValidDownloadId(text)) CHECK(text.size() == 36 && Charset(text, "-"));
    if (system::ValidLocalPath(text)) {
      CHECK(text.front() == '/' && text.find('\0') == std::string::npos && text.find("/../") == std::string::npos &&
            !text.ends_with("/..") && text.size() <= system::kMaxPathBytes);
    }
    if (system::PathListed(text, known)) CHECK(text == known[0]);
    if (system::IconPathAllowed(text, known)) {
      CHECK(text == known[0] || (text.find('/') == std::string::npos && NoControls(text) && !text.empty()));
    }
    if (system::ExternalSchemeAllowed(text)) {
      CHECK(Charset(text, "+-.") && text != "file" && text != "javascript" && text != "data");
    }
    if (system::ExternalTextAllowed(text)) {
      CHECK(NoControls(text) && text.find(' ') == std::string::npos && text.find('"') == std::string::npos);
    }
    if (system::SchemeGoesToShell(text)) {
      CHECK(NoControls(text) && text.find(' ') == std::string::npos && text.find("://") != std::string::npos);
    }
    if (system::PickerPromptUsable(text)) CHECK(NoControls(text) && text.size() <= system::kPickerPromptLimit);
  }
  system::OpenUrlInbox inbox;
  inbox.Add(Load().strings);
  CHECK(inbox.pending() <= system::kPendingOpenUrls);
  while (!inbox.empty()) {
    for (const std::string& url : inbox.Take()) CHECK(system::SchemeGoesToShell(url));
  }
  for (double number : Load().numbers) {
    const double points = system::IconPoints(number);
    CHECK(points >= system::kMinIconPoints && points <= system::kMaxIconPoints);
    if (const auto pid = system::ProcessId(number)) CHECK(*pid >= 1);
    CHECK(!system::ClearsDownload(false, false, number, std::numeric_limits<double>::quiet_NaN()));
  }
  CHECK(system::ExternalSchemeAllowed("https") && system::SchemeGoesToShell("https://example.com"));
  CHECK(system::ValidDownloadId("0b6a3f2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b"));
}

TEST(extension_surfaces) {
  namespace ext = ardia_mac::extension_policy;
  for (const std::string& text : Load().strings) {
    if (ext::ValidExtensionId(text)) CHECK(text.size() == 32);
    if (const auto host = ext::ExtensionUrlHost(text)) {
      CHECK(ext::ValidExtensionId(*host) && text.starts_with("chrome-extension://" + *host) && NoControls(text));
    }
    if (ext::ValidTabKey(text)) CHECK(NoControls(text) && text.size() <= ext::kMaxTabKey);
    if (ext::ValidRequestId(text)) CHECK(NoControls(text) && text.size() <= ext::kMaxRequestId);
    if (ext::ValidFolderPath(text)) CHECK(text.front() == '/' && text != "/");
    if (const auto resource = ext::ResourcePath(text)) {
      CHECK(resource->find("/../") == std::string::npos && !resource->starts_with("../") && *resource != "..");
      CHECK(!resource->starts_with("/") && NoControls(*resource));
    }
    if (const auto kind = ext::SurfaceKindFor(text)) CHECK(text == "popup" || text == "sidePanel");
    ext::SurfaceBook book;
    if (book.Open(ext::SurfaceKind::kPopup, text, 1)) CHECK(ext::ValidExtensionId(text));
  }
  for (double a : Load().numbers) {
    for (double b : Load().numbers) {
      const ext::PopupPlacement placement{.anchor_right = a, .anchor_top = b, .room_left = 0, .room_right = a,
                                          .room_bottom = b};
      if (const auto box = ext::PopupBoxFor(placement, 1, std::isfinite(a) ? static_cast<int>(std::clamp(a, -1e6, 1e6)) : 0, 300, a, b, a)) {
        CHECK(box->width >= 1 && box->width <= ext::kPopupMaxWidth && box->height >= 1 &&
              box->height <= ext::kPopupMaxHeight);
      }
      if (const auto box = ext::ViewportBox(a, b, a, b, 1, 1280, 800)) {
        CHECK(box->x >= 0 && box->y >= 0 && box->x + box->width <= 1280 && box->y + box->height <= 800);
      }
      const double radius = ext::CornerRadius(a, b);
      CHECK(std::isfinite(radius) && radius >= 0 && radius <= ext::kMaxCornerRadius * 10);
    }
  }
  CHECK(ext::ExtensionUrlHost("chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html").has_value());
}

TEST(pip_commands) {
  namespace pip = ardia_mac::pip_policy;
  for (const std::string& text : Load().strings) {
    if (const auto action = pip::ParseAction(text)) {
      CHECK(text == "togglePlayPause" || text == "seekTo" || text == "seekBy" || text == "backToTab" ||
            text == "close" || text == "popOut");
    }
  }
  for (double a : Load().numbers) {
    if (pip::ValidSeekSeconds(a)) CHECK(std::isfinite(a));
    const double clamped = pip::ClampSeek(std::isfinite(a) ? a : 0, a);
    CHECK(std::isfinite(clamped) && clamped >= 0);
    if (pip::PlayerMatches(a, 7)) CHECK(a == 7);
    for (double b : Load().numbers) {
      if (const auto box = pip::PlayerBox(a, b, a, b, 1, 1280, 800)) {
        CHECK(box->x >= 0 && box->y >= 0 && box->x + box->width <= 1280 && box->y + box->height <= 800);
      }
    }
  }
  CHECK(pip::ParseAction("popOut").has_value() && pip::PlayerMatches(7.0, 7));
}

TEST(dialog_guards) {
  namespace dialog = ardia_mac::dialog_policy;
  for (const std::string& text : Load().strings) {
    if (dialog::ValidDialogId(text)) CHECK(text.size() >= 16 && text.size() <= 96 && Charset(text, ":_-"));
    if (dialog::ValidGeneration(text)) CHECK(text.front() != '0' && text.size() <= 20 && Charset(text, ""));
    dialog::Request request;
    request.dialog_id = {true, true, text};
    request.kind = {true, true, text};
    request.has_options = true;
    request.title = {true, true, text};
    request.message = {true, true, text};
    request.confirm_title = {true, true, text};
    request.window_id = {true, true, text};
    if (const auto spec = dialog::Parse(request, "main")) {
      CHECK(dialog::ValidDialogId(spec->dialog_id) && (text == "confirm" || text == "prompt"));
    }
    dialog::Request control;
    control.dialog_id = {true, true, "dialog:0123456789abcdef:1"};
    control.kind = {true, true, "prompt"};
    control.has_options = true;
    control.title = {true, true, text};
    control.message = {true, true, text};
    control.value = {true, true, text};
    control.placeholder = {true, true, text};
    control.suppression = {true, true, text};
    const auto spec = dialog::Parse(control, "main");
    CHECK(spec.has_value() == (text.size() <= dialog::kTitleLimit));
    if (spec) {
      CHECK(NoControls(dialog::ButtonTitle(spec->confirm_title, "OK")));
      for (char c : dialog::Displayable(spec->title)) {
        const auto byte = static_cast<unsigned char>(c);
        CHECK(c == '\n' || c == '\t' || (byte >= 0x20 && byte != 0x7f));
      }
      const auto answer = dialog::Resolve(*spec, {.accepted = true, .text = text});
      if (answer.text) CHECK(!answer.text->empty() && answer.text->size() <= dialog::kValueLimit);
      dialog::Queue queue;
      CHECK(queue.Admit(*spec, text, text) == dialog::Refusal::kNone || !dialog::ValidGeneration(text));
    }
  }
  dialog::Request valid;
  valid.dialog_id = {true, true, "dialog:0123456789abcdef:1"};
  valid.kind = {true, true, "confirm"};
  valid.has_options = true;
  valid.title = {true, true, "Quit?"};
  CHECK(dialog::Parse(valid, "main").has_value());
}

TEST(window_lifecycle_guards) {
  namespace policy = ardia_mac::window_policy;
  for (const std::string& text : Load().strings) {
    if (policy::ValidWindowId(text)) CHECK(text.size() <= 128 && Charset(text, "_-"));
    if (policy::ValidGeneration(text)) CHECK(text.front() != '0' && Charset(text, ""));
    if (const auto title = policy::WindowTitle(text)) CHECK(NoControls(*title) && title->size() == text.size());
    if (policy::AppearanceNamed(text)) CHECK(text == "auto" || text == "light" || text == "dark");
    policy::CloseBook book;
    const auto identity = book.Request(1);
    CHECK(!book.BeginDrain(policy::CloseIdentity{text, text}, 1) || (text == "1"));
    CHECK(identity.has_value());
  }
  for (double a : Load().numbers) {
    for (double b : Load().numbers) {
      if (const auto frame = policy::FrameFrom(a, b, a, b)) {
        CHECK(std::isfinite(frame->x) && std::isfinite(frame->height));
        CHECK(frame->width >= policy::kMinWidth && frame->height >= policy::kMinHeight);
        CHECK(std::abs(frame->x) <= policy::kFrameLimit && frame->width <= policy::kFrameLimit);
      }
      policy::EdgeWatch watch;
      watch.Watch(a, policy::Side::kLeft, false);
      if (const auto report = watch.Moved(a, b, 1200, 800, false)) {
        CHECK(!report->over || (std::isfinite(report->x) && std::isfinite(report->y)));
      }
      policy::CloseBook book;
      const auto identity = book.Request(1);
      book.BeginDrain(*identity, 1);
      if (book.Acknowledge(*identity, 1, a)) CHECK(std::isfinite(a) && a >= 0 && std::floor(a) == a);
    }
  }
  CHECK(policy::FrameFrom(0, 0, 1280, 800).has_value());
}

TEST(page_guards) {
  namespace page = ardia_mac::page_policy;
  const auto never = [](std::string_view) { return std::string("not-a-digest"); };
  const std::array<page::Operation, 1> operations = {{{"plain", 5, "0", page::Arguments::kNone, ""}}};
  for (const std::string& text : Load().strings) {
    if (page::Handles(text)) {
      CHECK(Charset(text, ""));
    }
    if (page::IsZoomRoute(text)) {
      CHECK(text == "sites.zoomLevels" || text == "sites.setZoom");
    }
    if (const auto id = page::PopupId(text)) {
      CHECK(*id >= 0 && Charset(text, "") && text == std::to_string(*id));
    }
    if (page::PageActionFor(text) != page::PageAction::kUnsupported) {
      CHECK(text == "savePage" || text == "systemPrint" || text == "viewSource");
    }
    if (page::DevToolsPanelFor(text)) {
      CHECK(text == "toggle" || text == "inspect" || text == "console");
    }
    if (page::ZoomHostShape(text)) {
      CHECK(!text.empty() && text.size() <= 253 && NoControls(text) && text.find('/') == std::string::npos);
    }
    CHECK(!page::MatchOperation(text, never, operations).has_value());
    const std::string quoted = page::JavaScriptString(text);
    CHECK(quoted.size() >= 2 && quoted.front() == '"' && quoted.back() == '"' && NoControls(quoted));
    CHECK(quoted.find('<') == std::string::npos && quoted.find('>') == std::string::npos);
    for (size_t index = 1; index + 1 < quoted.size(); ++index) {
      if (quoted[index] == '"') CHECK(quoted[index - 1] == '\\');
    }
    if (const auto replaced = page::ReplaceArguments(text, text, false)) {
      CHECK(text.size() <= page::kReplaceTextMax && NoControls(*replaced));
    }
    const std::array<std::string_view, 1> fonts = {{"serif"}};
    if (const auto look = page::LookArgument(true, 0, text, 5, fonts)) CHECK(text == "serif");
    const std::array<std::string_view, 1> selectors = {{text}};
    if (const auto picked = page::PickerSelectors(selectors)) {
      CHECK(!text.empty() && text.size() <= page::kPickerSelectorMax && NoControls(*picked));
    }
  }
  for (double a : Load().numbers) {
    if (const auto whole = page::WholeNumber(a)) CHECK(static_cast<double>(*whole) == a);
    if (const auto step = page::ZoomStep(a)) CHECK(*step >= -1 && *step <= 1);
    if (const auto seconds = page::SleepSeconds(a)) {
      CHECK(*seconds >= 0 && *seconds <= page::kSleepLongestHiddenSeconds);
    }
    if (page::ZoomFactorAllowed(a)) CHECK(a >= page::kZoomFactorMin && a <= page::kZoomFactorMax);
    if (const auto factor = page::ReportedZoomFactor(a)) CHECK(std::isfinite(*factor) && *factor > 0);
    for (double b : Load().numbers) {
      if (const auto point = page::PickerPoint(a, b)) {
        CHECK(std::isfinite(a) && std::isfinite(b) && NoControls(*point));
        CHECK(point->find("nan") == std::string::npos && point->find("inf") == std::string::npos);
      }
    }
  }
  CHECK(page::Handles("find") && page::PopupId("7") == 7);
}

TEST(link_option_guards) {
  namespace link = ardia_mac::link_policy;
  std::vector<std::optional<std::string>> keys;
  for (const std::string& text : Load().strings) {
    link::PageOptions options;
    options.SetPeek(text);
    CHECK(options.peek == "alt" || options.peek == "shift" || options.peek == "off");
    options.SetSplit(text);
    CHECK(options.split == "alt" || options.split == "altShift");
    if (link::KeyFlags(text)) CHECK(text == "alt" || text == "shift" || text == "altShift" || text == "altMeta");
    if (options.ActionFor(text)) CHECK(link::KeyFlags(text) != 0);
    if (link::IsRoute(text)) CHECK(text.starts_with("webView.set") && Charset(text, "."));
    if (const auto one = link::SiteTabKeys({text})) {
      CHECK(one->size() == 1 && !text.empty() && text.size() <= link::kTabKeyMax);
    }
    keys.push_back(text);
    link::GestureGate gate;
    gate.NoteRelease(1, link::KeyFlags(text), 1, link::Point{0, 0}, text, 1);
    const auto release = gate.FreshRelease(1, 1);
    CHECK(release.target.size() <= link::kUrlMax);
    if (link::TargetMatches(release.target, text)) CHECK(!text.empty() && text.size() <= link::kUrlMax);
    link::Request request;
    request.surface = 1;
    request.key = text;
    request.http = true;
    request.visible = true;
    request.now = 1;
    const link::Decision decision = gate.Decide(request, link::PageOptions());
    if (decision.outcome == link::Outcome::kPeek || decision.outcome == link::Outcome::kSplit) {
      CHECK(link::PageOptions().ActionFor(text).has_value());
    }
  }
  if (const auto all = link::SiteTabKeys(keys)) {
    CHECK(all->size() <= link::kSiteTabsMax);
    for (const std::string& key : *all) CHECK(!key.empty() && key.size() <= link::kTabKeyMax);
  }
  link::ScrollZoom zoom;
  for (double delta : Load().numbers) {
    const int step = zoom.Add(delta, 1);
    CHECK(step >= -1 && step <= 1);
    if (!std::isfinite(delta)) CHECK(step == 0);
  }
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
