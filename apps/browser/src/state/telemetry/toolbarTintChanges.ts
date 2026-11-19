import { withoutFragment } from "../../lib/url";
import { noteToolbarTintChange } from "./usage";

export type TintReport = {
  previous: string | null;
  shown: string | null;
  url: string;
  lastPage: string | null;
  isLoading: boolean;
};

export const tintChangedOnSamePage = ({ previous, shown, url, lastPage, isLoading }: TintReport) => !isLoading && lastPage !== null && withoutFragment(url) === lastPage && shown !== previous;

export function noteSamePageTint(report: TintReport) {
  if (tintChangedOnSamePage(report)) noteToolbarTintChange();
}
