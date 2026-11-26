#ifndef ARDIA_MAC_AC_MAC_HOOKS_H_
#define ARDIA_MAC_AC_MAC_HOOKS_H_

class RenderViewContextMenuBase;
class RenderViewContextMenuObserver;

namespace ui {
class SimpleMenuModel;
}

extern bool g_ardia_mac_hosts_normal_windows;

extern RenderViewContextMenuObserver* (*g_ardia_mac_page_menu_observer)(RenderViewContextMenuBase* menu,
                                                                         ui::SimpleMenuModel* model);

extern void (*g_ardia_mac_page_menu_destroyed)(RenderViewContextMenuBase* menu);

#if defined(__OBJC__)
#import <AppKit/AppKit.h>

extern bool (*g_ardia_mac_shell_passes_point)(NSView* view, NSPoint point);
#endif

#endif
