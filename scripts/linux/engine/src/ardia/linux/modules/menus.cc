// Copyright 2026 Ardia. Apache-2.0.

#include <memory>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/modules/owner_window.h"
#include "ardia/linux/modules/test_answers.h"
#include "ardia/linux/ui_host/modules.h"
#include "base/json/json_writer.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "third_party/skia/include/core/SkCanvas.h"
#include "third_party/skia/include/core/SkPaint.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/mojom/menu_source_type.mojom.h"
#include "ui/base/models/image_model.h"
#include "ui/menus/simple_menu_model.h"
#include "ui/display/screen.h"
#include "ui/events/event_constants.h"
#include "ui/events/keycodes/keyboard_codes.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/views/controls/menu/menu_runner.h"
#include "ui/views/widget/widget.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaMenus";
constexpr int kSwatchSize = 12;

bool Shows(const base::DictValue& item) {
  return !item.FindBool("separator").value_or(false) &&
         !item.FindBool("alternate").value_or(false);
}

std::string TitleOf(const base::DictValue& item) {
  const std::string* title = item.FindString("title");
  return title ? *title : std::string();
}

std::string JoinedTitles(const base::ListValue& items, bool describe) {
  std::vector<std::string> titles;
  for (const base::Value& value : items) {
    const base::DictValue* item = value.GetIfDict();
    if (!item || !Shows(*item) || TitleOf(*item).empty()) {
      continue;
    }
    titles.push_back(base::StrCat(
        {TitleOf(*item),
         describe && item->FindBool("checked").value_or(false) ? " ✓" : ""}));
  }
  return base::JoinString(titles, " | ");
}

void ReportItems(const base::ListValue& items, const std::string& path) {
  NoteActivation(
      base::StrCat({"menu items: ", path, ": ", JoinedTitles(items, true)}));
  for (const base::Value& value : items) {
    const base::DictValue* item = value.GetIfDict();
    const base::ListValue* children =
        item ? item->FindList("children") : nullptr;
    if (item && Shows(*item) && children && !children->empty()) {
      ReportItems(*children, base::StrCat({path, " › ", TitleOf(*item)}));
    }
  }
}

void EnabledIds(const base::ListValue& items, std::set<std::string>& into) {
  for (const base::Value& value : items) {
    const base::DictValue* item = value.GetIfDict();
    if (!item || !Shows(*item) || !item->FindBool("enabled").value_or(true)) {
      continue;
    }
    const base::ListValue* children = item->FindList("children");
    if (children && !children->empty()) {
      EnabledIds(*children, into);
    } else if (const std::string* id = item->FindString("id")) {
      into.insert(*id);
    }
  }
}

std::optional<SkColor> SwatchColor(const std::string* hex) {
  if (!hex) {
    return std::nullopt;
  }
  std::string_view digits(*hex);
  if (!digits.empty() && digits.front() == '#') {
    digits.remove_prefix(1);
  }
  uint32_t value = 0;
  if (digits.size() != 6 || !base::HexStringToUInt(digits, &value)) {
    return std::nullopt;
  }
  return SkColorSetRGB((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

ui::ImageModel SwatchImage(SkColor color) {
  SkBitmap bitmap;
  bitmap.allocN32Pixels(kSwatchSize, kSwatchSize);
  bitmap.eraseColor(SK_ColorTRANSPARENT);
  SkCanvas canvas(bitmap);
  SkPaint paint;
  paint.setAntiAlias(true);
  paint.setColor(color);
  canvas.drawCircle(kSwatchSize / 2.0f, kSwatchSize / 2.0f,
                    kSwatchSize / 2.0f - 0.5f, paint);
  return ui::ImageModel::FromImageSkia(
      gfx::ImageSkia::CreateFrom1xBitmap(bitmap));
}

std::optional<ui::Accelerator> AcceleratorOf(const base::DictValue& item) {
  const std::string* key = item.FindString("key");
  if (!key || key->empty()) {
    return std::nullopt;
  }
  int flags = 0;
  bool shifted = false;
  if (const base::ListValue* modifiers = item.FindList("modifiers")) {
    for (const base::Value& modifier : *modifiers) {
      const std::string* name = modifier.GetIfString();
      if (!name) {
        continue;
      }
      if (*name == "command" || *name == "control" || *name == "cmd" ||
          *name == "ctrl") {
        flags |= ui::EF_CONTROL_DOWN;
      } else if (*name == "option" || *name == "alt") {
        flags |= ui::EF_ALT_DOWN;
      } else if (*name == "shift") {
        shifted = true;
      }
    }
  }
  const char typed = (*key)[0];
  if (key->size() != 1) {
    return std::nullopt;
  }
  ui::KeyboardCode code = ui::VKEY_UNKNOWN;
  if (base::IsAsciiAlpha(typed)) {
    shifted |= base::IsAsciiUpper(typed);
    code = static_cast<ui::KeyboardCode>(ui::VKEY_A +
                                         (base::ToLowerASCII(typed) - 'a'));
  } else if (base::IsAsciiDigit(typed)) {
    code = static_cast<ui::KeyboardCode>(ui::VKEY_0 + (typed - '0'));
  } else if (typed == ',') {
    code = ui::VKEY_OEM_COMMA;
  } else if (typed == '.') {
    code = ui::VKEY_OEM_PERIOD;
  } else if (typed == '[') {
    code = ui::VKEY_OEM_4;
  } else if (typed == ']') {
    code = ui::VKEY_OEM_6;
  } else if (typed == '-') {
    code = ui::VKEY_OEM_MINUS;
  } else if (typed == '=' || typed == '+') {
    code = ui::VKEY_OEM_PLUS;
  } else if (typed == '/') {
    code = ui::VKEY_OEM_2;
  }
  if (code == ui::VKEY_UNKNOWN || !flags) {
    return std::nullopt;
  }
  if (shifted) {
    flags |= ui::EF_SHIFT_DOWN;
  }
  return ui::Accelerator(code, flags);
}

class AppMenu : public ui::SimpleMenuModel::Delegate {
 public:
  AppMenu(const base::ListValue& items, ModuleReply reply)
      : reply_(std::move(reply)) {
    root_ = Build(items);
  }

  void RunAt(views::Widget* owner) {
    runner_ = std::make_unique<views::MenuRunner>(
        root_, views::MenuRunner::CONTEXT_MENU | views::MenuRunner::HAS_MNEMONICS,
        base::BindRepeating(&AppMenu::Closed, base::Unretained(this)));
    display::Screen* screen = display::Screen::Get();
    const gfx::Point at =
        screen ? screen->GetCursorScreenPoint() : gfx::Point();
    runner_->RunMenuAt(owner, nullptr, gfx::Rect(at, gfx::Size()),
                       views::MenuAnchorPosition::kTopLeft,
                       ui::mojom::MenuSourceType::kMouse);
  }

  bool IsCommandIdChecked(int command_id) const override {
    return checked_.contains(command_id);
  }

  bool IsCommandIdEnabled(int command_id) const override {
    return !disabled_.contains(command_id);
  }

  bool GetAcceleratorForCommandId(int command_id,
                                  ui::Accelerator* accelerator) const override {
    auto found = accelerators_.find(command_id);
    if (found == accelerators_.end()) {
      return false;
    }
    *accelerator = found->second;
    return true;
  }

  void ExecuteCommand(int command_id, int) override {
    if (command_id >= 0 && static_cast<size_t>(command_id) < ids_.size()) {
      chosen_ = ids_[command_id];
    }
  }

 private:
  ui::SimpleMenuModel* Build(const base::ListValue& items) {
    auto model = std::make_unique<ui::SimpleMenuModel>(this);
    ui::SimpleMenuModel* made = model.get();
    models_.push_back(std::move(model));
    for (const base::Value& value : items) {
      const base::DictValue* item = value.GetIfDict();
      if (!item || item->FindBool("alternate").value_or(false)) {
        continue;
      }
      if (item->FindBool("separator").value_or(false)) {
        if (made->GetItemCount() > 0 &&
            made->GetTypeAt(made->GetItemCount() - 1) !=
                ui::MenuModel::TYPE_SEPARATOR) {
          made->AddSeparator(ui::NORMAL_SEPARATOR);
        }
        continue;
      }
      const std::u16string label = base::UTF8ToUTF16(TitleOf(*item));
      const int command_id = static_cast<int>(ids_.size());
      const std::string* id = item->FindString("id");
      ids_.push_back(id ? *id : std::string());
      if (!item->FindBool("enabled").value_or(true)) {
        disabled_.insert(command_id);
      }
      const base::ListValue* children = item->FindList("children");
      if (children && !children->empty()) {
        made->AddSubMenu(command_id, label, Build(*children));
      } else if (item->FindBool("checked").value_or(false)) {
        checked_.insert(command_id);
        made->AddCheckItem(command_id, label);
      } else {
        made->AddItem(command_id, label);
      }
      if (std::optional<ui::Accelerator> accelerator = AcceleratorOf(*item)) {
        accelerators_.emplace(command_id, *accelerator);
      }
      if (std::optional<SkColor> swatch =
              SwatchColor(item->FindString("swatch"))) {
        made->SetIcon(made->GetItemCount() - 1, SwatchImage(*swatch));
      }
    }
    while (made->GetItemCount() > 0 &&
           made->GetTypeAt(made->GetItemCount() - 1) ==
               ui::MenuModel::TYPE_SEPARATOR) {
      made->RemoveItemAt(made->GetItemCount() - 1);
    }
    return made;
  }

  void Closed() {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](AppMenu* menu) {
                         std::unique_ptr<AppMenu> owned(menu);
                         std::move(owned->reply_).Run(
                             owned->chosen_.empty()
                                 ? base::Value()
                                 : base::Value(owned->chosen_));
                       },
                       base::Unretained(this)));
  }

  ModuleReply reply_;
  std::vector<std::unique_ptr<ui::SimpleMenuModel>> models_;
  raw_ptr<ui::SimpleMenuModel> root_ = nullptr;
  std::vector<std::string> ids_;
  std::set<int> checked_;
  std::set<int> disabled_;
  std::map<int, ui::Accelerator> accelerators_;
  std::string chosen_;
  std::unique_ptr<views::MenuRunner> runner_;
};

int CountVisible(const base::ListValue& items) {
  int count = 0;
  for (const base::Value& value : items) {
    const base::DictValue* item = value.GetIfDict();
    count += item && Shows(*item) ? 1 : 0;
  }
  return count;
}

void ShowMenu(base::ListValue args, ModuleReply reply) {
  const base::ListValue* items = ListArg(args, 0);
  base::ListValue empty;
  if (!items) {
    items = &empty;
  }
  Note("menu", base::StrCat({"showMenu asked: ",
                             base::NumberToString(CountVisible(*items)),
                             " items"}));
  const LaunchConfig& config = CurrentLaunchConfig();
  if (config.TestFlag("appMenu")) {
    std::set<std::string> enabled;
    EnabledIds(*items, enabled);
    DumpAndTakePick(
        "menu.json",
        base::WriteJsonWithOptions(*items,
                                   base::JSONWriter::OPTIONS_PRETTY_PRINT)
            .value_or("[]"),
        base::BindOnce(
            [](std::set<std::string> enabled, ModuleReply reply,
               std::optional<std::string> pick) {
              std::move(reply).Run(pick && enabled.contains(*pick)
                                       ? base::Value(*pick)
                                       : base::Value());
            },
            std::move(enabled), std::move(reply)));
    return;
  }
  if (config.background) {
    const std::string titles = JoinedTitles(*items, false);
    Note("menu", "pop-up menu not shown in a background instance: " + titles);
    NoteActivation("pop-up menu (not shown): " + titles);
    ReportItems(*items, "pop-up menu");
    std::move(reply).Run(base::Value());
    return;
  }
  views::Widget* owner = OwnerWidget();
  if (!owner) {
    Note("menu", "pop-up menu not shown: no app window to show it over");
    std::move(reply).Run(base::Value());
    return;
  }
  (new AppMenu(*items, std::move(reply)))->RunAt(owner);
}

}

void RegisterMenusModule(ModuleRegistry& registry) {
  registry.Define(kModule).Async("showMenu", base::BindRepeating(&ShowMenu));
}

}
