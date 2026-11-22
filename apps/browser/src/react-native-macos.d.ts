import "react-native";

declare module "react-native" {
  interface ViewProps {
    tooltip?: string;
  }
  interface TextProps {
    ardiaCentersCapitals?: boolean;
  }
  interface TextInputProps {
    pastedTypes?: PastedTypesType;
    ardiaCentersCapitals?: boolean;
  }
}
