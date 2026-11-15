import { installFakeBridge } from "./bridge";

installFakeBridge(window as Window & typeof globalThis);
