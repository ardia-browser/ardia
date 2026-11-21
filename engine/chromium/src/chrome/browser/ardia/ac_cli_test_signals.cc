// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_test_signals.h"

namespace ardia {
namespace {

bool g_private_pasteboard_active = false;
bool g_plugin_input_hold = false;
int g_plugin_deliveries_refused_departed = 0;

}

void NoteCliPrivatePasteboard(bool active) {
  g_private_pasteboard_active = active;
}

bool CliPrivatePasteboardActive() {
  return g_private_pasteboard_active;
}

void NoteCliPluginInputHold(bool active) {
  g_plugin_input_hold = active;
}

bool CliPluginInputHold() {
  return g_plugin_input_hold;
}

void CountPluginDeliveryRefusedDeparted() {
  ++g_plugin_deliveries_refused_departed;
}

void AddCliTestSignals(base::DictValue& status) {
  status.Set("privatePasteboard", g_private_pasteboard_active);
  status.Set("pluginInputHold", g_plugin_input_hold);
  status.Set("pluginDeliveriesRefusedDeparted",
             g_plugin_deliveries_refused_departed);
}

}
