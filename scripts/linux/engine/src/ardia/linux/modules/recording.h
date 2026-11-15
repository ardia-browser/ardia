// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_RECORDING_H_
#define ARDIA_LINUX_MODULES_RECORDING_H_

#include "ardia/linux/ui_host/modules.h"
#include "content/public/browser/media_stream_request.h"

namespace content {
class WebContents;
}

namespace input {
struct NativeWebKeyboardEvent;
}

namespace ardia_linux {

void AddRecordingMethods(ModuleRegistry::Module& module);

bool AnswerRecordingMediaRequest(content::WebContents* host,
                                 const content::MediaStreamRequest& request,
                                 content::MediaResponseCallback& callback);

bool RecordingTakesKey(const input::NativeWebKeyboardEvent& event);

}

#endif
