# Source this file from Git Bash: source scripts/use-toolchain.sh
_spark_repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
_spark_node="$(tr -d '\r\n' < "$_spark_repo/.node-version")"
_spark_pnpm="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' "$_spark_repo/package.json")"
_spark_local="$(cygpath -u "$LOCALAPPDATA")/spark233/toolchains"
_spark_previous_path="$PATH"
if test -x "$_spark_local/node-v$_spark_node-win-x64/node.exe"; then
  export PATH="$_spark_local/node-v$_spark_node-win-x64:$PATH"
fi
if test -f "$_spark_local/pnpm-v$_spark_pnpm/node_modules/.bin/pnpm"; then
  export PATH="$_spark_local/pnpm-v$_spark_pnpm/node_modules/.bin:$PATH"
fi
if test "$(node --version)" != "v$_spark_node" || test "$(pnpm --version)" != "$_spark_pnpm"; then
  export PATH="$_spark_previous_path"
  echo "Install Node $_spark_node and pnpm $_spark_pnpm using the README toolchain instructions." >&2
  unset _spark_repo _spark_node _spark_pnpm _spark_local _spark_previous_path
  return 1
fi
unset _spark_repo _spark_node _spark_pnpm _spark_local _spark_previous_path
