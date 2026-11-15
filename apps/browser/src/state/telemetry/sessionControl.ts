import { save, sessionId } from "./choice";

export const reopenSession = () => save({ sessionOpen: true, sessionId: sessionId() });
