import { useState } from "react";
import { applySetupCode, type SetupCodeApplied } from "../../../state/presets/actions";
import { SETUP_CODE_PREFIX } from "../../../state/presets/setupCode";
import { Button, TextField } from "../../ui";
import { Row } from "../Form";
import { t } from "../../../lib/uiLanguage";


const SETUP_CODE_HINT = t(`Paste the code from the demo on ardia.dev to bring over the layout, look and pinned apps you picked there.`);

export function SetupCodeRow() {
  const [code, setCode] = useState("");
  const [result, setResult] = useState<SetupCodeApplied | null>(null);
  const apply = () => {
    if (!code.trim()) return;
    const applied = applySetupCode(code);
    setResult(applied);
    if (applied.ok) setCode("");
  };
  const description = result ? (result.ok ? `Applied: ${result.lines.join(", ")}.` : result.error) : SETUP_CODE_HINT;
  return (
    <Row title={t(`Apply a setup code`)} description={description}>
      <TextField
        value={code}
        onChangeText={(text) => {
          setCode(text);
          setResult(null);
        }}
        placeholder={`${SETUP_CODE_PREFIX}…`}
        onSubmit={apply}
        width={170}
      />
      <Button title={t(`Apply`)} disabled={!code.trim()} onPress={apply} />
    </Row>
  );
}
