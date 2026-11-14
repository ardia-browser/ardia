import { contextBridge } from "electron";

function guardPageElements() {
  const home = document;
  const registry = CustomElementRegistry.prototype;
  const define = registry.define;
  registry.define = function (name: string, constructor: CustomElementConstructor, options?: ElementDefinitionOptions) {
    if (name === "webview") {
      const page = constructor.prototype as { connectedCallback?: (this: Element) => void };
      if (!("connectedMoveCallback" in page)) Object.defineProperty(page, "connectedMoveCallback", { value() {}, configurable: true });
      const attach = page.connectedCallback;
      Object.defineProperty(page, "connectedCallback", {
        configurable: true,
        writable: true,
        value(this: Element) {
          if (this.ownerDocument !== home) {
            console.error("[ardia linux] refused a page element outside the window that made it: its page would attach to the wrong window and crash the browser on focus");
            return;
          }
          attach?.call(this);
        },
      });
    }
    return define.call(this, name, constructor, options);
  };
}

contextBridge.executeInMainWorld({ func: guardPageElements });
