export type LinuxCount =
  | "print_system_dialogs"
  | "print_pdf_saves"
  | "print_failures"
  | "page_error_pages"
  | "page_link_drops_opened"
  | "page_escapes"
  | "leave_site_asked"
  | "leave_site_stayed"
  | "quit_unsaved_asked"
  | "quit_unsaved_stayed"
  | "window_close_unsaved_asked"
  | "window_close_unsaved_stayed"
  | "memory_saver_discards_proactive"
  | "memory_saver_discards_urgent"
  | "location_unavailable"
  | "widevine_failures"
  | "popup_menus_without_focus"
  | "popup_menus_unshown"
  | "task_manager_opens"
  | "task_manager_processes_ended"
  | "report_recordings_started"
  | "report_recording_failures";

const counts = new Map<LinuxCount, number>();

export const count = (name: LinuxCount): void => void counts.set(name, (counts.get(name) ?? 0) + 1);

export function takeCounts(): Partial<Record<LinuxCount, number>> {
  const taken = Object.fromEntries(counts) as Partial<Record<LinuxCount, number>>;
  counts.clear();
  return taken;
}
