// Copyright 2026 Ardia. Apache-2.0.

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/linux/prompts/prompts.h"
#include "ardia/win/tab_state.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/i18n/break_iterator.h"
#include "base/json/json_writer.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/threading/thread_restrictions.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/ui/tab_contents/chrome_web_contents_menu_helper.h"
#include "chrome/browser/ui/views/renderer_context_menu/render_view_context_menu_views.h"
#include "chrome/browser/ui/views/tab_contents/chrome_web_contents_view_delegate_views.h"
#include "chrome/grit/generated_resources.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/clipboard/clipboard.h"
#include "ui/base/clipboard/clipboard_format_type.h"
#include "ui/base/data_transfer_policy/data_transfer_endpoint.h"
#include "ui/events/event_constants.h"
#include "ui/menus/simple_menu_model.h"

namespace ardia_linux {

namespace {

constexpr int kHostFirst = IDC_CONTENT_CONTEXT_CUSTOM_FIRST + 900;
constexpr int kHostLast = IDC_CONTENT_CONTEXT_CUSTOM_FIRST + 999;
constexpr int kOpenLinkInProfileItems = 100;
constexpr size_t kSelectionLabelLength = 50;
constexpr size_t kSelectionLabelBreakAfter = 25;

std::u16string& SearchEngineName() {
  static base::NoDestructor<std::u16string> name(u"Google");
  return *name;
}

ardia_win::TabState* HostedState(content::WebContents* contents) {
  ardia_win::TabState* state =
      contents ? ardia_win::TabState::FromWebContents(contents) : nullptr;
  return state && !state->key().empty() ? state : nullptr;
}

std::u16string SelectionLabel(const std::u16string& text) {
  std::vector<std::u16string_view> words = base::SplitStringPiece(
      text, base::kWhitespaceUTF16, base::TRIM_WHITESPACE,
      base::SPLIT_WANT_NONEMPTY);
  std::u16string collapsed = base::JoinString(words, u" ");
  if (collapsed.size() <= kSelectionLabelLength) {
    return collapsed;
  }
  size_t end = kSelectionLabelLength;
  const size_t space = collapsed.rfind(u' ', kSelectionLabelLength);
  if (space != std::u16string::npos && space > kSelectionLabelBreakAfter) {
    end = space;
  }
  base::i18n::BreakIterator characters(collapsed,
                                       base::i18n::BreakIterator::BREAK_CHARACTER);
  if (characters.Init()) {
    size_t last = 0;
    while (characters.Advance() && characters.pos() <= end) {
      last = characters.pos();
    }
    end = last;
  }
  return collapsed.substr(0, end) + u"…";
}

std::string MenuTitle(const std::u16string& label) {
  std::u16string title;
  for (size_t i = 0; i < label.size(); ++i) {
    if (label[i] != u'&') {
      title.push_back(label[i]);
    } else if (i + 1 < label.size() && label[i + 1] == u'&') {
      title.push_back(u'&');
      ++i;
    }
  }
  return base::UTF16ToUTF8(title);
}

base::ListValue DescribeMenu(ui::MenuModel* model) {
  base::ListValue items;
  for (size_t i = 0; model && i < model->GetItemCount(); ++i) {
    const ui::MenuModel::ItemType type = model->GetTypeAt(i);
    base::DictValue item;
    item.Set("id", model->GetCommandIdAt(i));
    item.Set("label", MenuTitle(model->GetLabelAt(i)));
    item.Set("enabled", model->IsEnabledAt(i));
    item.Set("visible", model->IsVisibleAt(i));
    item.Set("separator", type == ui::MenuModel::TYPE_SEPARATOR);
    item.Set("type", static_cast<int>(type));
    if (type == ui::MenuModel::TYPE_SUBMENU ||
        type == ui::MenuModel::TYPE_ACTIONABLE_SUBMENU) {
      item.Set("submenu", DescribeMenu(model->GetSubmenuModelAt(i)));
    }
    items.Append(std::move(item));
  }
  return items;
}

bool FindLabel(ui::MenuModel* model,
               const std::string& label,
               ui::MenuModel** owner,
               size_t* index) {
  for (size_t i = 0; model && i < model->GetItemCount(); ++i) {
    if (model->GetTypeAt(i) != ui::MenuModel::TYPE_SEPARATOR &&
        MenuTitle(model->GetLabelAt(i)) == label) {
      *owner = model;
      *index = i;
      return true;
    }
    if (FindLabel(model->GetSubmenuModelAt(i), label, owner, index)) {
      return true;
    }
  }
  return false;
}

class PageContextMenu : public RenderViewContextMenuViews {
 public:
  PageContextMenu(content::RenderFrameHost& render_frame_host,
                  const content::ContextMenuParams& params,
                  bool is_paste_enabled,
                  bool is_paste_and_match_style_enabled)
      : RenderViewContextMenuViews(render_frame_host,
                                   params,
                                   is_paste_enabled,
                                   is_paste_and_match_style_enabled) {}

  void Show() override {
    CountLinux("pageContextMenus");
    if (!ShowThroughLog()) {
      RenderViewContextMenuViews::Show();
    }
  }

  void Arrange() {
    ArrangeLikeDia();
    RemoveViewlessItems();
    AddHostItems();
    if (toolkit_delegate()) {
      toolkit_delegate()->Init(&menu_model_);
    }
  }

 private:
  void ArrangeLikeDia() {
    for (size_t i = menu_model_.GetItemCount(); i-- > 0;) {
      const int command = menu_model_.GetCommandIdAt(i);
      if (command == IDC_CONTENT_CONTEXT_OPENLINKINPROFILE ||
          (command >= IDC_OPEN_LINK_IN_PROFILE_FIRST &&
           command < IDC_OPEN_LINK_IN_PROFILE_FIRST + kOpenLinkInProfileItems)) {
        menu_model_.RemoveItemAt(i);
      }
    }
    const std::optional<size_t> save =
        menu_model_.GetIndexOfCommandId(IDC_CONTENT_CONTEXT_SAVELINKAS);
    const std::optional<size_t> copy =
        menu_model_.GetIndexOfCommandId(IDC_CONTENT_CONTEXT_COPYLINKLOCATION);
    if (save && copy && *save > *copy) {
      menu_model_.RemoveItemAt(*save);
      menu_model_.InsertItemWithStringIdAt(*copy, IDC_CONTENT_CONTEXT_SAVELINKAS,
                                           IDS_CONTENT_CONTEXT_SAVELINKAS);
    }
    const std::optional<size_t> reload =
        menu_model_.GetIndexOfCommandId(IDC_RELOAD);
    if (!reload) {
      return;
    }
    if (!menu_model_.GetIndexOfCommandId(IDC_BACK)) {
      menu_model_.InsertItemWithStringIdAt(
          menu_model_.GetIndexOfCommandId(IDC_FORWARD).value_or(*reload),
          IDC_BACK, IDS_CONTENT_CONTEXT_BACK);
    }
    if (!menu_model_.GetIndexOfCommandId(IDC_FORWARD)) {
      menu_model_.InsertItemWithStringIdAt(
          *menu_model_.GetIndexOfCommandId(IDC_BACK) + 1, IDC_FORWARD,
          IDS_CONTENT_CONTEXT_FORWARD);
    }
  }

  void RemoveViewlessItems() {
    for (int command :
         {IDC_CONTENT_CONTEXT_OPEN_IN_READING_MODE,
          IDC_CONTENT_CONTEXT_LISTEN_TO_THIS_PAGE,
          IDC_CONTENT_CONTEXT_GENERATE_QR_CODE, IDC_SEND_TAB_TO_SELF,
          IDC_CONTENT_CONTEXT_SEARCHLENSFORIMAGE,
          IDC_CONTENT_CONTEXT_SEARCHLENSFORVIDEOFRAME,
          IDC_CONTENT_CONTEXT_LENS_REGION_SEARCH}) {
      while (std::optional<size_t> index =
                 menu_model_.GetIndexOfCommandId(command)) {
        menu_model_.RemoveItemAt(*index);
      }
    }
    const auto separator = [this](size_t i) {
      return menu_model_.GetTypeAt(i) == ui::MenuModel::TYPE_SEPARATOR;
    };
    for (size_t i = menu_model_.GetItemCount(); i-- > 0;) {
      const size_t count = menu_model_.GetItemCount();
      if (i < count && separator(i) &&
          (i == 0 || i + 1 == count || separator(i + 1))) {
        menu_model_.RemoveItemAt(i);
      }
    }
  }

  void AddHostItems() {
    const std::u16string& selection = params().selection_text;
    if (selection.empty() || params().is_editable) {
      return;
    }
    host_items_.push_back("search");
    const int command = kHostFirst;
    const std::u16string title = u"Search " + SearchEngineName() + u" for “" +
                                 SelectionLabel(selection) + u"”";
    std::optional<size_t> copy =
        menu_model_.GetIndexOfCommandId(IDC_CONTENT_CONTEXT_COPY);
    size_t place = copy ? *copy + 1 : menu_model_.GetItemCount();
    bool replaced = false;
    for (int chrome_id : {IDC_CONTENT_CONTEXT_SEARCHWEBFOR,
                          IDC_CONTENT_CONTEXT_SEARCHWEBFORNEWTAB}) {
      if (std::optional<size_t> index =
              menu_model_.GetIndexOfCommandId(chrome_id)) {
        if (!replaced) {
          place = *index;
        }
        menu_model_.RemoveItemAt(*index);
        replaced = true;
      }
    }
    menu_model_.InsertItemAt(std::min(place, menu_model_.GetItemCount()),
                             command, title);
  }

 public:
  bool IsCommandIdEnabled(int command_id) const override {
    if (command_id >= kHostFirst && command_id <= kHostLast) {
      return true;
    }
    return RenderViewContextMenuViews::IsCommandIdEnabled(command_id);
  }

  void ExecuteCommand(int command_id, int event_flags) override {
    if (command_id == IDC_CONTENT_CONTEXT_OPENLINKSPLITVIEW) {
      if (ardia_win::TabState* state = HostedState(source_web_contents_)) {
        base::DictValue open;
        open.Set("url", params_.link_url.spec());
        open.Set("disposition", "split");
        open.Set("userGesture", true);
        open.Set("fromClick", false);
        open.Set("postBody", false);
        state->Send("openWindow", std::move(open));
        return;
      }
    }
    const size_t index = static_cast<size_t>(command_id - kHostFirst);
    if (command_id < kHostFirst || command_id > kHostLast ||
        index >= host_items_.size()) {
      RenderViewContextMenuViews::ExecuteCommand(command_id, event_flags);
      return;
    }
    ardia_win::TabState* state = HostedState(source_web_contents_);
    if (!state) {
      return;
    }
    base::DictValue modifiers;
    modifiers.Set("metaKey", (event_flags & ui::EF_CONTROL_DOWN) != 0);
    modifiers.Set("shiftKey", (event_flags & ui::EF_SHIFT_DOWN) != 0);
    modifiers.Set("altKey", (event_flags & ui::EF_ALT_DOWN) != 0);
    base::DictValue data;
    data.Set("command", host_items_[index]);
    data.Set("text", base::UTF16ToUTF8(params().selection_text));
    data.Set("modifiers", std::move(modifiers));
    state->Send("command", std::move(data));
  }

 private:
  bool ShowThroughLog() {
    const bool test = ardiacore::TestFlag("contextMenu");
    if (!test && !ardiacore::BackgroundInstance()) {
      return false;
    }
    base::ListValue items = DescribeMenu(&menu_model_);
    if (!test) {
      std::vector<std::string> titles;
      for (const base::Value& item : items) {
        const std::string* label = item.GetDict().FindString("label");
        if (!item.GetDict().FindBool("separator").value_or(false) && label &&
            !label->empty()) {
          titles.push_back(*label);
        }
      }
      NoteActivation("context menu (not shown): " +
                     base::JoinString(titles, " | "));
      return true;
    }
    base::DictValue dump;
    dump.Set("url", params().page_url.spec());
    dump.Set("link", params().link_url.spec());
    dump.Set("items", std::move(items));
    const base::FilePath path =
        DataDirectory().AppendASCII("context-menu.json");
    const base::FilePath pick_path = path.AddExtensionASCII("pick");
    std::string pick;
    {
      base::ScopedAllowBlockingForTesting test_files;
      base::WriteFile(path, base::WriteJson(dump).value_or("{}"));
      base::ReadFileToString(pick_path, &pick);
      base::DeleteFile(pick_path);
    }
    base::TrimWhitespaceASCII(pick, base::TRIM_ALL, &pick);
    std::vector<std::string> parts = base::SplitString(
        pick, "\t", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL);
    base::WeakPtr<PageContextMenu> alive = weak_factory_.GetWeakPtr();
    ui::MenuModel* owner = nullptr;
    size_t index = 0;
    if (!pick.empty() && FindLabel(&menu_model_, parts[0], &owner, &index) &&
        owner->IsEnabledAt(index)) {
      int flags = 0;
      if (parts.size() > 1) {
        base::StringToInt(parts[1], &flags);
      }
      owner->ActivatedAt(index, flags);
    }
    if (alive) {
      MenuClosed(&menu_model_);
    }
    return true;
  }

  std::vector<std::string> host_items_;
  base::WeakPtrFactory<PageContextMenu> weak_factory_{this};
};

class PageViewDelegate : public ChromeWebContentsViewDelegateViews {
 public:
  explicit PageViewDelegate(content::WebContents* contents)
      : ChromeWebContentsViewDelegateViews(contents), contents_(contents) {}

  std::unique_ptr<RenderViewContextMenuBase> BuildMenu(
      content::RenderFrameHost& render_frame_host,
      const content::ContextMenuParams& params) override {
    if (!HostedState(contents_)) {
      return ChromeWebContentsViewDelegateViews::BuildMenu(render_frame_host,
                                                           params);
    }
    auto menu = std::make_unique<PageContextMenu>(
        render_frame_host, params, paste_enabled_,
        paste_and_match_style_enabled_);
    menu->Init();
    menu->Arrange();
    return menu;
  }

  void BuildMenuAsync(
      content::RenderFrameHost& render_frame_host,
      const content::ContextMenuParams& params,
      base::OnceCallback<void(std::unique_ptr<RenderViewContextMenuBase>)>
          callback) override {
    if (!HostedState(contents_)) {
      ChromeWebContentsViewDelegateViews::BuildMenuAsync(
          render_frame_host, params, std::move(callback));
      return;
    }
    std::optional<ui::DataTransferEndpoint> data_dst;
    if (params.page_url.is_valid()) {
      data_dst.emplace(
          params.page_url,
          ui::DataTransferEndpointOptions{
              .notify_if_restricted = false,
              .off_the_record =
                  contents_->GetBrowserContext()->IsOffTheRecord(),
          });
    }
    ui::Clipboard::GetForCurrentThread()->ReadAvailableTypes(
        ui::ClipboardBuffer::kCopyPaste, data_dst,
        base::BindOnce(
            &PageViewDelegate::OnReadAvailableTypes, weak_factory_.GetWeakPtr(),
            render_frame_host.GetGlobalId(),
            AddContextMenuParamsPropertiesFromPreferences(contents_, params),
            data_dst, std::move(callback)));
  }

 private:
  void OnReadAvailableTypes(
      content::GlobalRenderFrameHostId frame_id,
      const content::ContextMenuParams& params,
      std::optional<ui::DataTransferEndpoint> data_dst,
      base::OnceCallback<void(std::unique_ptr<RenderViewContextMenuBase>)>
          callback,
      std::vector<std::u16string> types) {
    paste_enabled_ = !types.empty();
    ui::Clipboard::GetForCurrentThread()->GetAllAvailableFormats(
        ui::ClipboardBuffer::kCopyPaste, std::move(data_dst),
        base::BindOnce(&PageViewDelegate::OnGetAllAvailableFormats,
                       weak_factory_.GetWeakPtr(), frame_id, params,
                       std::move(callback)));
  }

  void OnGetAllAvailableFormats(
      content::GlobalRenderFrameHostId frame_id,
      const content::ContextMenuParams& params,
      base::OnceCallback<void(std::unique_ptr<RenderViewContextMenuBase>)>
          callback,
      base::flat_set<ui::ClipboardFormatType> formats) {
    paste_and_match_style_enabled_ =
        formats.contains(ui::ClipboardFormatType::PlainTextType());
    content::RenderFrameHost* frame =
        content::RenderFrameHost::FromID(frame_id);
    if (!frame) {
      std::move(callback).Run(nullptr);
      return;
    }
    std::move(callback).Run(BuildMenu(*frame, params));
  }

  raw_ptr<content::WebContents> contents_;
  bool paste_enabled_ = false;
  bool paste_and_match_style_enabled_ = false;
  base::WeakPtrFactory<PageViewDelegate> weak_factory_{this};
};

void SetEngineNameVerb(const std::string&,
                       base::DictValue args,
                       ModuleReply reply) {
  const std::string* name = args.FindString("name");
  SearchEngineName() =
      name && !name->empty() ? base::UTF8ToUTF16(*name) : u"Google";
  ReplyNull(std::move(reply));
}

}

std::unique_ptr<content::WebContentsViewDelegate> CreatePageViewDelegate(
    content::WebContents* contents) {
  return std::make_unique<PageViewDelegate>(contents);
}

void AddContextMenuVerbs(DomainVerbs& verbs) {
  verbs.Add("search", "setEngineName", base::BindRepeating(&SetEngineNameVerb));
}

}
