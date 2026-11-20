import { memo, useMemo, useState } from "react";
import type { SavedAddress, SavedCard } from "../../../state/site/autofill";
import { addressDetail, addressMatches, addressTitle } from "../../../state/autofill/addresses";
import { cardExpiry, cardMatches, cardsInOrder, cardTitle } from "../../../state/autofill/cards";
import { currentEngineProfile } from "../../../state/browser/current";
import { PLATFORM_TERMS } from "../../../lib/platformTerms";
import { addresses as addressList, cards as cardList } from "../../../state/settings/paneData";
import { useResource } from "../../../state/settings/resources";
import { showSettingsSheet } from "../../../state/settings/sheet";
import { useGrowingRows } from "../../../state/settings/growingRows";
import { Box, Button, SearchField, tabularNums, Text } from "../../ui";
import { AddressGlyph } from "../../autofill/AutofillParts";
import { AddressSheet } from "../../autofill/AddressSheet";
import { CardSheet } from "../../autofill/CardSheet";
import { NetworkBadge } from "../../site/Autofill";
import { Group, Row, SectionHeader } from "../Form";
import { setting } from "../settingsIndex";
import { ProfileSubPage } from "./ProfileSubPage";

const SEARCH_FROM = 7;
const SEARCH_WIDTH = 160;

const AddressRow = memo(function AddressRow({ address, profile }: { address: SavedAddress; profile: string }) {
  const detail = addressDetail(address);
  return (
    <Row
      icon={<AddressGlyph address={address} />}
      title={addressTitle(address)}
      description={detail || undefined}
      onPress={() => showSettingsSheet(<AddressSheet profile={profile} saved={address} />)}
    />
  );
});

const CardRow = memo(function CardRow({ card, profile, now }: { card: SavedCard; profile: string; now: Date }) {
  const expiry = cardExpiry(card, now);
  return (
    <Row icon={<NetworkBadge network={card.network} />} title={cardTitle(card)} description={card.name?.trim() || undefined} onPress={() => showSettingsSheet(<CardSheet profile={profile} saved={card} />)}>
      {expiry.expired ? (
        <Text size="small" tone="destructive">
          Expired
        </Text>
      ) : expiry.label ? (
        <Text size="small" tone="textSecondary" style={tabularNums}>
          {expiry.label}
        </Text>
      ) : null}
    </Row>
  );
});

function ListActions({ count, query, onQuery, addTitle, onAdd }: { count: number; query: string; onQuery: (q: string) => void; addTitle: string; onAdd: () => void }) {
  return (
    <Box row gap="s" center>
      {count >= SEARCH_FROM || query ? <SearchField value={query} onChangeText={onQuery} placeholder="Search" width={SEARCH_WIDTH} /> : null}
      <Button title={addTitle} onPress={onAdd} />
    </Box>
  );
}

export function AddressesPage({ profileId }: { profileId: string }) {
  const profile = currentEngineProfile(profileId);
  const [list] = useResource(addressList, profile);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => (list ?? []).filter((a) => addressMatches(a, query)), [list, query]);
  const rows = useGrowingRows(shown.length, `${profile}|${query}`);

  return (
    <ProfileSubPage>
      <SectionHeader
        title="Addresses"
        description={setting("profiles.addresses").description}
        action={<ListActions count={list?.length ?? 0} query={query} onQuery={setQuery} addTitle="Add Address…" onAdd={() => showSettingsSheet(<AddressSheet profile={profile} />)} />}
      />
      <Group>
        {list && !shown.length ? (
          <Row title={query ? "No addresses match" : "No saved addresses"} description={query ? undefined : "Addresses you enter in forms can be saved here."} />
        ) : (
          shown.slice(0, rows).map((a) => <AddressRow key={a.id} address={a} profile={profile} />)
        )}
      </Group>
    </ProfileSubPage>
  );
}

export function CardsPage({ profileId }: { profileId: string }) {
  const profile = currentEngineProfile(profileId);
  const [list] = useResource(cardList, profile);
  const [query, setQuery] = useState("");
  const now = useMemo(() => new Date(), [list]);
  const shown = useMemo(() => cardsInOrder(list ?? [], now).filter((c) => cardMatches(c, query)), [list, query, now]);
  const rows = useGrowingRows(shown.length, `${profile}|${query}`);

  return (
    <ProfileSubPage>
      <SectionHeader
        title="Cards"
        description={`${setting("profiles.cards").description} Card numbers are kept in ${PLATFORM_TERMS.secretStore}.`}
        action={<ListActions count={list?.length ?? 0} query={query} onQuery={setQuery} addTitle="Add Card…" onAdd={() => showSettingsSheet(<CardSheet profile={profile} />)} />}
      />
      <Group>
        {list && !shown.length ? (
          <Row title={query ? "No cards match" : "No saved cards"} description={query ? undefined : "Cards you enter at checkout can be saved here."} />
        ) : (
          shown.slice(0, rows).map((c) => <CardRow key={c.id} card={c} profile={profile} now={now} />)
        )}
      </Group>
    </ProfileSubPage>
  );
}
