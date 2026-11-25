import { t, tp } from "../../../lib/i18n";
import { View } from "react-native";
import { leftOutText, listedCount, sourceNotes, type ExtensionListing, type ExtensionTarget } from "../../../state/import/extensionListing";
import { openExtensionStorePage, openListedExtensionsInStore } from "../../../state/import/listedExtensions";
import { useOnboarding } from "../../../state/onboarding/onboarding";
import { Button, space, Text } from "../../ui";
import { APP } from "../model";

const centered = { textAlign: "center" } as const;

function TargetList({ target, sourceName }: { target: ExtensionTarget; sourceName: string }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text size="small" weight="semibold">{t("For {profile}:", { profile: target.profileName || t("this profile") })}</Text>
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
            <Button variant="text" look="link" pad="none" title={t("Store Page")} onPress={() => openExtensionStorePage(target.profileId, e.webStoreUrl)} />
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
            {tp("{browser} has {count} extension from the Chrome Web Store, named as {browser} lists it. Add the ones you want from its store page:", "{browser} has {count} extensions from the Chrome Web Store, named as {browser} lists them. Add the ones you want from their store pages:", total, { browser: sourceName })}
          </Text>
          {listing.targets.map((t) => (
            <TargetList key={t.profileId} target={t} sourceName={sourceName} />
          ))}
          {listing.storeOpened ? (
            <Text size="small" tone="textSecondary" style={centered}>
              {tp("Its page is open in your sidebar{when}. Click Add to {app} on each one you want.", "Their pages are open in your sidebar{when}. Click Add to {app} on each one you want.", total, { when: onboarding ? t(", ready when you finish setting up") : "", app: APP })}
            </Text>
          ) : (
            <View style={{ alignItems: "center" }}>
              <Button title={tp("Open in Chrome Web Store", "Open {count} in Chrome Web Store", total)} onPress={openListedExtensionsInStore} />
            </View>
          )}
        </>
      )}
      {already.length > 0 && (
        <Text size="caption" tone="textSecondary" style={centered}>
          {t("Already in {app}: {extensions}.", { app: APP, extensions: already.map((e) => e.name).join(t(", ")) })}
        </Text>
      )}
      {skipped.length > 0 && (
        <Text size="caption" tone="textSecondary" style={centered}>
          {t("Can't be added from the Chrome Web Store: {extensions}.", { extensions: skipped.map(leftOutText).join(t(", ")) })}
        </Text>
      )}
    </View>
  );
}
