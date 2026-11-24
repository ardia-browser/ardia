import { useState } from "react";
import { resolveInputBox } from "../../state/plugins/actions";
import { usePluginTitle } from "../../state/plugins/hooks";
import type { InputBoxRequest } from "../../state/plugins/surfaces";
import { Box, Button, Dialog, DialogActions, DialogTitle, Text, TextField } from "../ui";

export function PluginInputBox({ request }: { request: InputBoxRequest }) {
  const { id, options } = request;
  const pluginTitle = usePluginTitle(request.plugin);
  const [value, setValue] = useState(options.value ?? "");
  const cancel = () => resolveInputBox(id, null);
  const confirm = () => resolveInputBox(id, value);
  return (
    <Dialog width="s" animated onDismiss={cancel}>
      <DialogTitle subtitle={options.message ?? pluginTitle ?? undefined}>{options.title}</DialogTitle>
      <Box gap="xs">
        <TextField value={value} onChangeText={setValue} placeholder={options.placeholder} autoFocus selectOnFocus secure={!!options.password} onSubmit={confirm} onEscape={cancel} />
        {options.message && pluginTitle ? (
          <Text size="caption" tone="textTertiary">
            {`Asked by ${pluginTitle}`}
          </Text>
        ) : null}
      </Box>
      <DialogActions>
        <Button title="Cancel" onPress={cancel} />
        <Button title={options.confirmTitle ?? "OK"} kind="primary" onPress={confirm} />
      </DialogActions>
    </Dialog>
  );
}
