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
  | "page_context_menus"
  | "auto_pip_opened"
  | "pip_back_to_tab"
  | "owner_check_asked"
  | "owner_check_granted"
  | "owner_check_cancelled"
  | "owner_check_wrong_passwords"
  | "owner_check_unavailable"
  | "owner_check_helper_failures"
  | "owner_check_throttled"
  | "screen_locks_seen"
  | "screen_lock_watch_unavailable"
  | "memory_saver_discards_proactive"
  | "memory_saver_discards_urgent"
  | "location_unavailable"
  | "widevine_failures"
  | "popup_menus_without_focus"
  | "popup_menus_unshown"
  | "task_manager_opens"
  | "task_manager_processes_ended"
  | "report_recordings_started"
  | "report_recording_failures"
  | "window_drag_area_menus"
  | "window_moves_by_app"
  | "meadow_scenes"
  | "meadow_failures"
  | "translate_model_downloads"
  | "translate_model_download_failures"
  | "translate_engine_failures";

const counts = new Map<LinuxCount, number>();

export const count = (name: LinuxCount): void => void counts.set(name, (counts.get(name) ?? 0) + 1);

export function takeCounts(): Partial<Record<LinuxCount, number>> {
  const taken = Object.fromEntries(counts) as Partial<Record<LinuxCount, number>>;
  counts.clear();
  return taken;
}
