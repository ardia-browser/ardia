import { onContentBlocked } from "../services/contentBlocker";
import { guestById, tell } from "./guests";

onContentBlocked((webContentsId, url) => {
  const guest = guestById(webContentsId);
  if (!guest) return;
  guest.blocked += 1;
  tell(guest, "contentBlocked", { count: guest.blocked, url });
});
