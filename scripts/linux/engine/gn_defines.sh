source "$AC_MAC_BUILD_DIR/gn_defines.sh"
_linux_drop=(is_official_build chrome_pgo_phase target_cpu enable_cdm_host_verification symbol_level enable_rlz
  enable_cdm_storage_id alternate_cdm_storage_id_key)
_linux_add=(
  'target_os="linux"'
  "target_cpu=\"${LINUX_CPU:-x64}\""
  is_official_build=false
  chrome_pgo_phase=0
  use_thin_lto=false
  symbol_level=1
  use_sysroot=true
  is_clang=true
  use_kerberos=false
  use_system_libffi=false
  use_vaapi=true
  rtc_use_pipewire=true
  blink_enable_generated_code_formatting=false
)
_linux_args=()
for _arg in "${_gn_args[@]}"; do
  _name="${_arg%%=*}"
  _keep=1
  for _drop in "${_linux_drop[@]}"; do
    [[ "$_name" == "$_drop" ]] && _keep=0
  done
  [[ $_keep == 1 ]] && _linux_args+=("$_arg")
done
_gn_args=("${_linux_args[@]}" "${_linux_add[@]}")
unset _linux_args _linux_drop _linux_add _arg _name _keep _drop
export GN_DEFINES="${_gn_args[*]}"
