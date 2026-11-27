import { Box, Button, List, Text, ardia, definePlugin, useState } from "@ardia/plugin-sdk";

const CAP_SECTIONS = 39;
const CAP_TEXTS = 50;
const ROWS = 1000;

function CapTree() {
  return (
    <Box direction="column" gap="xs">
      {Array.from({ length: CAP_SECTIONS }, (_, section) => (
        <Box key={section} direction="row" wrap>
          {Array.from({ length: CAP_TEXTS }, (_, item) => (
            <Text key={item} size="small">{`Section ${section} item ${item}`}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function Rows() {
  const [generation, setGeneration] = useState(0);
  return (
    <List actions={<Button title="Bump" onPress={() => setGeneration((g) => g + 1)} />}>
      {Array.from({ length: ROWS }, (_, row) => (
        <List.Item key={row} id={`row-${row}`} title={`Row ${row} · generation ${generation}`} subtitle={row % 2 ? "odd" : "even"} />
      ))}
    </List>
  );
}

void definePlugin({
  async activate() {
    await ardia.storage.set("activated", true);
  },
  commands: {
    ping: (input: unknown) => ({ pong: input ?? null }),
    spin: (input: unknown) => {
      const until = Date.now() + Number(input ?? 0);
      let n = 0;
      while (Date.now() < until) n++;
      return n > 0;
    },
  },
  views: {
    cap: CapTree,
    rows: Rows,
  },
  async deactivate() {
    await ardia.storage.set("deactivated", true);
  },
});
