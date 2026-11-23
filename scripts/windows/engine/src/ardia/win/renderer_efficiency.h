#ifndef ARDIA_WIN_RENDERER_EFFICIENCY_H_
#define ARDIA_WIN_RENDERER_EFFICIENCY_H_

#include "base/values.h"

namespace content {
class WebContents;
}

namespace ardia_win {

void StartRendererEfficiency();
void NoteTabHiddenForEfficiency(content::WebContents* contents);
base::DictValue TakeRendererEfficiencyCounts();
base::DictValue RendererEfficiencyOf(content::WebContents* contents);

}

#endif
