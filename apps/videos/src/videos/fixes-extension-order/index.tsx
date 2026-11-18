import { fixesFilm } from "../../lib/fixes-film/Film";
import segments from "./segments.json";

const film = fixesFilm({ id: "fixes-extension-order", release: "0.2.47-nightly.3", before: "0.2.46", channel: "nightly", segments });

export const meta = film.meta;
export default film.Video;
