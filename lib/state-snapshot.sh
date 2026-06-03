# Shared snapshot/restore helpers for openclaw-update.
# Source this file from bash scripts:
#   source "$SCRIPT_DIR/../lib/state-snapshot.sh"
#
# Functions:
#   snapshot_state <version_dir>   — Snapshot ~/.openclaw whitelisted files into <version_dir>/.state-snapshot/
#   restore_state  <version_dir>   — Restore from <version_dir>/.state-snapshot/ into ~/.openclaw/
#   diff_state     <version_dir>   — Compare live ~/.openclaw against <version_dir>/.state-snapshot/, print diffs

OPENCLAW_DIR_DEFAULT="$HOME/.openclaw"
RESILIENCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHITELIST_FILE="$RESILIENCE_ROOT/snapshot-whitelist.txt"

# Print whitelist entries (skipping comments and blank lines)
_whitelist_entries() {
  [[ -f "$WHITELIST_FILE" ]] || { echo "snapshot whitelist not found: $WHITELIST_FILE" >&2; return 1; }
  grep -v '^\s*#' "$WHITELIST_FILE" | grep -v '^\s*$'
}

# snapshot_state <version_dir> [openclaw_dir]
snapshot_state() {
  local version_dir="$1"
  local openclaw_dir="${2:-$OPENCLAW_DIR_DEFAULT}"
  [[ -d "$version_dir" ]] || { echo "snapshot_state: version_dir not found: $version_dir" >&2; return 1; }

  local snap_dir="$version_dir/.state-snapshot"
  mkdir -p "$snap_dir"

  local manifest_tmp
  manifest_tmp=$(mktemp)
  echo "{" > "$manifest_tmp"
  echo "  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >> "$manifest_tmp"
  echo "  \"openclaw_dir\": \"$openclaw_dir\"," >> "$manifest_tmp"
  echo "  \"files\": {" >> "$manifest_tmp"

  local first=1
  local entry src dest sha
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    src="$openclaw_dir/$entry"
    dest="$snap_dir/$entry"
    if [[ -f "$src" ]]; then
      mkdir -p "$(dirname "$dest")"
      cp -p "$src" "$dest"
      sha=$(shasum -a 256 "$src" | awk '{print $1}')
      [[ $first -eq 1 ]] || echo "," >> "$manifest_tmp"
      printf '    "%s": "%s"' "$entry" "$sha" >> "$manifest_tmp"
      first=0
    fi
  done < <(_whitelist_entries)

  echo "" >> "$manifest_tmp"
  echo "  }" >> "$manifest_tmp"
  echo "}" >> "$manifest_tmp"
  mv "$manifest_tmp" "$snap_dir/snapshot.json"
  echo "snapshotted state → $snap_dir"
}

# restore_state <version_dir> [openclaw_dir]
# Returns 0 if restored, 1 if no snapshot exists, 2 on partial failure.
restore_state() {
  local version_dir="$1"
  local openclaw_dir="${2:-$OPENCLAW_DIR_DEFAULT}"
  local snap_dir="$version_dir/.state-snapshot"

  if [[ ! -d "$snap_dir" ]] || [[ ! -f "$snap_dir/snapshot.json" ]]; then
    return 1
  fi

  # Backup live files before overwriting
  local ts
  ts=$(date +%Y%m%dT%H%M%S)
  local backup_dir="$openclaw_dir/.state-pre-restore-$ts"
  mkdir -p "$backup_dir"

  local entry src dest restored=0 failed=0
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    src="$snap_dir/$entry"
    dest="$openclaw_dir/$entry"
    if [[ -f "$src" ]]; then
      if [[ -f "$dest" ]]; then
        mkdir -p "$(dirname "$backup_dir/$entry")"
        cp -p "$dest" "$backup_dir/$entry" || { failed=$((failed+1)); continue; }
      fi
      mkdir -p "$(dirname "$dest")"
      cp -p "$src" "$dest" || { failed=$((failed+1)); continue; }
      restored=$((restored+1))
    fi
  done < <(_whitelist_entries)

  echo "restored $restored file(s) from snapshot; pre-restore backup at $backup_dir"
  [[ $failed -gt 0 ]] && { echo "$failed file(s) failed to restore" >&2; return 2; }
  return 0
}

# diff_state <version_dir> [openclaw_dir]
# Lists whitelist files whose live sha256 differs from the snapshot.
diff_state() {
  local version_dir="$1"
  local openclaw_dir="${2:-$OPENCLAW_DIR_DEFAULT}"
  local snap_dir="$version_dir/.state-snapshot"

  if [[ ! -d "$snap_dir" ]] || [[ ! -f "$snap_dir/snapshot.json" ]]; then
    echo "no snapshot at $snap_dir"
    return 1
  fi

  local entry live_sha snap_sha
  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    [[ -f "$openclaw_dir/$entry" ]] || { echo "  - missing (live): $entry"; continue; }
    [[ -f "$snap_dir/$entry" ]] || { echo "  - missing (snap): $entry"; continue; }
    live_sha=$(shasum -a 256 "$openclaw_dir/$entry" | awk '{print $1}')
    snap_sha=$(shasum -a 256 "$snap_dir/$entry" | awk '{print $1}')
    if [[ "$live_sha" != "$snap_sha" ]]; then
      echo "  ≠ drift: $entry  (live=$live_sha snap=$snap_sha)"
    fi
  done < <(_whitelist_entries)
}
