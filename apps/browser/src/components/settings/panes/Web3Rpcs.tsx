import { useState } from "react";
import { useSettings } from "../../../state/browser/hooks";
import { addWeb3Rpc, removeWeb3Rpc, setWeb3Rpc } from "../../../state/settings/actions";
import { closeSettingsSheet, showSettingsSheet } from "../../../state/settings/sheet";
import { PUBLIC_NODE_RPC } from "../../../state/settings/web3Rpcs";
import { Button, DialogActions, DialogTitle, Sheet, space, Text, TextField } from "../../ui";
import { FormField, Group, Row, SectionHeader } from "../Form";

const chainName = (chain: string) => (chain === "1" ? "Ethereum (chain 1)" : `Chain ${chain}`);
const rpcHost = (url: string) => /^[a-z]+:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;

export function Web3RpcSection() {
  const rpcs = useSettings((s) => s.web3Rpcs);
  const chains = Object.keys(rpcs).sort((a, b) => Number(a) - Number(b));
  return (
    <>
      <SectionHeader
        anchor="advanced.chainRpcs"
        action={<Button title="Add RPC…" icon="plus" onPress={() => showSettingsSheet(<Web3RpcSheet chain={rpcs["1"] ? "" : "1"} />)} />}
      />
      <Group of="advanced.chainRpcs">
        {rpcs["1"] ? null : (
          <Row title={chainName("1")} description="No RPC set, so web3:// pages on Ethereum don't open. PublicNode is free and needs no account; it sees which contracts you open.">
            <Button title="Use PublicNode" onPress={() => setWeb3Rpc("1", PUBLIC_NODE_RPC)} />
          </Row>
        )}
        {chains.map((chain) => (
          <Row key={chain} title={chainName(chain)} description={rpcHost(rpcs[chain]!)}>
            <Button variant="icon" icon="trash" size="m" tooltip="Remove" onPress={() => removeWeb3Rpc(chain)} />
          </Row>
        ))}
      </Group>
    </>
  );
}

function Web3RpcSheet({ chain: startChain }: { chain: string }) {
  const [chain, setChain] = useState(startChain);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    const problem = await addWeb3Rpc(chain.trim(), url.trim());
    if (problem) return setError(problem);
    closeSettingsSheet();
  };
  return (
    <Sheet onClose={closeSettingsSheet}>
      <DialogTitle subtitle="Ardia reads web3:// pages through this RPC. Pages never see it, so it can hold an API key. A local node or light client works too.">
        Add RPC
      </DialogTitle>
      <FormField label="Chain ID">
        <TextField value={chain} onChangeText={setChain} placeholder="1" onSubmit={add} onEscape={closeSettingsSheet} autoFocus={!startChain} />
      </FormField>
      <FormField label="RPC URL">
        <TextField value={url} onChangeText={setUrl} placeholder="https://… or http://127.0.0.1:8545" onSubmit={add} onEscape={closeSettingsSheet} autoFocus={!!startChain} />
      </FormField>
      {error && (
        <Text size="caption" tone="destructive" style={ERROR}>
          {error}
        </Text>
      )}
      <DialogActions>
        <Button title="Cancel" onPress={closeSettingsSheet} />
        <Button title="Add" kind="primary" disabled={!chain.trim() || !url.trim()} onPress={add} />
      </DialogActions>
    </Sheet>
  );
}

const ERROR = { marginTop: space.ml } as const;
