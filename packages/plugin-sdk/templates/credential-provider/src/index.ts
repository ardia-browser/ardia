import { defineCredentialProvider } from "@ardia/plugin-sdk/credentials";
import { vaultctl } from "./provider";

void defineCredentialProvider(vaultctl);
