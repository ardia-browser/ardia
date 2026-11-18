import { fixesFilm } from "../../lib/fixes-film/Film";
import segments from "./segments.json";

const film = fixesFilm({ id: "fixes-0247n3", release: "0.2.47-nightly.3", before: "0.2.47-nightly.2", channel: "nightly", segments });

export const meta = film.meta;
export default film.Video;
