#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(node --version)" != v22.* ]]; then
  echo "PidginDocs Cloudflare verification requires Node 22" >&2
  exit 1
fi

node --test .github/ci/tests/scope-check.mjs
node site/check.mjs

(
  cd server
  npm ci
  npx tsc --noEmit
  npm test
)

gitleaks_version=8.29.1
gitleaks_sha256=e4eb209d04e20339d77122a3bdf9cd41351255cfb27ebcb75e85325e04f88924
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT
archive="$temp_dir/gitleaks_${gitleaks_version}_linux_x64.tar.gz"
curl --fail --silent --show-error --location \
  "https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks_version}/gitleaks_${gitleaks_version}_linux_x64.tar.gz" \
  --output "$archive"
echo "$gitleaks_sha256  $archive" | sha256sum --check --status
tar -xzf "$archive" -C "$temp_dir" gitleaks
if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
  git fetch --unshallow origin
fi
"$temp_dir/gitleaks" git --redact
"$temp_dir/gitleaks" dir --redact .

# Pages requires an output directory; publish only a neutral validation receipt.
mkdir -p .cloudflare-ci-output
printf '%s\n' '<!doctype html><html lang="en"><meta charset="utf-8"><title>PidginDocs CI</title><p>PidginDocs CI validation passed.</p></html>' > .cloudflare-ci-output/index.html
