type NodeApi = { createAnimatedNode: (tag: number, config: object) => void; dropAnimatedNode: (tag: number) => void };

let created = 0;
let dropped = 0;

export function countNativeNodes() {
  const api: NodeApi = require("react-native/src/private/animated/NativeAnimatedHelper").default.API;
  const create = api.createAnimatedNode;
  const drop = api.dropAnimatedNode;
  api.createAnimatedNode = (tag, config) => {
    created++;
    create(tag, config);
  };
  api.dropAnimatedNode = (tag) => {
    dropped++;
    drop(tag);
  };
}

export const nativeNodes = () => ({ created, dropped, live: created - dropped });
