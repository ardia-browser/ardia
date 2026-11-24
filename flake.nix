{
  description = "Ardia development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (
        pkgs:
        let
          inherit (pkgs) lib stdenvNoCC;
          packages =
            with pkgs;
            [
              nodejs_24
              pnpm_11
              python3
              xz
            ]
            ++ lib.optionals stdenvNoCC.hostPlatform.isDarwin [ cocoapods ];
          stdenvToolDirs = map (pkg: "${lib.getBin pkg}/bin") (
            lib.subtractLists packages stdenvNoCC.initialPath
          );
        in
        {
          default = pkgs.mkShellNoCC {
            inherit packages;

            shellHook = lib.optionalString stdenvNoCC.hostPlatform.isDarwin ''
              export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
              PATH=":$PATH:"
              for dir in ${lib.escapeShellArgs stdenvToolDirs}; do
                PATH=''${PATH//":$dir:"/":"}
              done
              PATH=''${PATH#:}
              export PATH=''${PATH%:}
            '';
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
