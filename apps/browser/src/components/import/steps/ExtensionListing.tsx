import { View } from "react-native";
import { plural } from "../../../state/browser/model";
import { leftOutText, listedCount, sourceNotes, type ExtensionListing, type ExtensionTarget } from "../../../state/import/extensionListing";
import { openExtensionStorePage, openListedExtensionsInStore } from "../../../state/import/listedExtensions";
import { useOnboarding } from "../../../state/onboarding/onboarding";
import { Button, space, Text } from "../../ui";
import { APP } from "../model";

const centered = { textAlign: "center" } as const;

function TargetList({ target, sourceName }: { target: ExtensionTarget; sourceName: string }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text size="small" weight="semibold">{`For ${target.profileName || "this profile"}:`}</Text>
      {target.extensions.map((e) => {
        const notes = sourceNotes(e, sourceName);
        return (
          <View key={e.id} style={{ flexDirection: "row", alignItems: "center", gap: space.s }}>
            <View style={{ flex: 1 }}>
              <Text size="small" selectable>
                {notes ? `${e.name} (${notes})` : e.name}
              </Text>
              <Text size="caption" tone="textSecondary" selectable>
                {e.id}
              </Text>
            </View>
            <Button variant="text" look="link" pad="none" title="Store Page" onPress={() => openExtensionStorePage(target.profileId, e.webStoreUrl)} />
          </View>
        );
      })}
    </View>
  );
}

export function ExtensionListingView({ listing, sourceName }: { listing: ExtensionListing; sourceName: string }) {
  const onboarding = useOnboarding((s) => s.windowId !== null);
  const total = listedCount(listing);
  const already = listing.leftOut.filter((e) => e.reason === "installed");
  const skipped = listing.leftOut.filter((e) => e.reason !== "installed");
  return (
    <View style={{ alignSelf: "stretch", marginTop: space.xl, gap: space.m }}>
      {total > 0 && (
        <>
          <Text size="small" tone="textSecondary" style={centered}>
            {`${sourceName} has ${plural(total, "extension")} from the Chrome Web Store, named as ${sourceName} lists ${total === 1 ? "it" : "them"}. Add the ones you want from ${total === 1 ? "its" : "their"} store ${total === 1 ? "page" : "pages"}:`}
          </Text>
          {listing.targets.map((t) => (
            <TargetList key={t.profileId} target={t} sourceName={sourceName} />
          ))}
          {listing.storeOpened ? (
            <Text size="small" tone="textSecondary" style={centered}>
              {`${total === 1 ? "Its page is" : "Their pages are"} open in your sidebar${onboarding ? ", ready when you finish setting up" : ""}. Click Add to ${APP} on each one you want.`}
            </Text>
          ) : (
            <View style={{ alignItems: "center" }}>
              <Button title={total === 1 ? "Open in Chrome Web Store" : `Open ${total} in Chrome Web Store`} onPress={openListedExtensionsInStore} />
            </View>
          )}
        </>
      )}
      {already.length > 0 && (
        <Text size="caption" tone="textSecondary" style={centered}>
          {`Already in ${APP}: ${already.map((e) => e.name).join(", ")}.`}
        </Text>
      )}
      {skipped.length > 0 && (
        <Text size="caption" tone="textSecondary" style={centered}>
          {`Can't be added from the Chrome Web Store: ${skipped.map(leftOutText).join(", ")}.`}
        </Text>
      )}
    </View>
  );
}
