#include "ardia/win/context_menu.h"

#include <memory>

#include "ardia/win/hooks.h"
#include "ardia/win/tab_state.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/ui/views/renderer_context_menu/render_view_context_menu_views.h"
#include "content/public/browser/context_menu_params.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/accelerators/accelerator.h"
#include "ui/base/models/menu_model.h"

namespace ardia_win {

namespace {

constexpr int kOpenLinkInProfileItems = 100;

bool AppCannotDo(int command) {
  switch (command) {
    case IDC_CONTENT_CONTEXT_OPENLINKSPLITVIEW:
    case IDC_ROUTE_MEDIA:
    case IDC_CONTENT_CONTEXT_OPENLINKINPROFILE:
    case IDC_CONTENT_CONTEXT_OPEN_IN_READING_MODE:
    case IDC_CONTENT_CONTEXT_LISTEN_TO_THIS_PAGE:
    case IDC_CONTENT_CONTEXT_GENERATE_QR_CODE:
    case IDC_SEND_TAB_TO_SELF:
    case IDC_CONTENT_CONTEXT_SEARCHLENSFORIMAGE:
    case IDC_CONTENT_CONTEXT_SEARCHLENSFORVIDEOFRAME:
    case IDC_CONTENT_CONTEXT_LENS_REGION_SEARCH:
      return true;
    default:
      return command >= IDC_OPEN_LINK_IN_PROFILE_FIRST &&
             command < IDC_OPEN_LINK_IN_PROFILE_FIRST + kOpenLinkInProfileItems;
  }
}

class HostedPageMenu : public RenderViewContextMenuViews {
 public:
  HostedPageMenu(content::RenderFrameHost& render_frame_host,
                 const content::ContextMenuParams& params,
                 bool is_paste_enabled,
                 bool is_paste_and_match_style_enabled)
      : RenderViewContextMenuViews(render_frame_host,
                                   params,
                                   is_paste_enabled,
                                   is_paste_and_match_style_enabled) {}

  void Show() override {
    LeaveOutWhatTheAppCannotDo();
    if (ToolkitDelegate* toolkit = toolkit_delegate()) {
      toolkit->Init(&menu_model_);
    }
    RenderViewContextMenuViews::Show();
  }

 protected:
  bool GetAcceleratorForCommandId(int command_id,
                                  ui::Accelerator* accelerator) const override {
    if (command_id == IDC_SAVE_PAGE) {
      return false;
    }
    return RenderViewContextMenuViews::GetAcceleratorForCommandId(command_id,
                                                                  accelerator);
  }

 private:
  void LeaveOutWhatTheAppCannotDo() {
    for (size_t i = menu_model_.GetItemCount(); i-- > 0;) {
      if (AppCannotDo(menu_model_.GetCommandIdAt(i))) {
        menu_model_.RemoveItemAt(i);
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
};

std::unique_ptr<RenderViewContextMenuBase> HostedPageMenuFor(
    content::RenderFrameHost& render_frame_host,
    const content::ContextMenuParams& params,
    bool is_paste_enabled,
    bool is_paste_and_match_style_enabled) {
  content::WebContents* contents =
      content::WebContents::FromRenderFrameHost(&render_frame_host);
  if (!contents || !TabState::FromWebContents(contents)) {
    return nullptr;
  }
  return std::make_unique<HostedPageMenu>(render_frame_host, params,
                                          is_paste_enabled,
                                          is_paste_and_match_style_enabled);
}

}

void InstallHostedPageMenus() {
  g_ardia_win_context_menu = &HostedPageMenuFor;
}

}
