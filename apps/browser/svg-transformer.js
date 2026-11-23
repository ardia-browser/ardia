const upstream = require("@react-native/metro-babel-transformer");

module.exports.transform = function transform(props) {
  if (props.filename.endsWith(".svg")) {
    return upstream.transform({ ...props, src: `module.exports = ${JSON.stringify(props.src)};` });
  }
  return upstream.transform(props);
};
