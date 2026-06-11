#!/usr/bin/env bash
# Agent Flight Recorder — 3-minute demo script
#
#   ./demo.sh          local-only (record → verify → tamper → catch it)
#   PRIVATE_KEY=0x... ./demo.sh seal   also seal to Filecoin calibration + remote-verify
set -euo pipefail
cd "$(dirname "$0")"

AFR="node bin/afr.js"
export AFR_DIR="${AFR_DIR:-$PWD/.afr-demo}"
rm -rf "$AFR_DIR"

step() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; read -r -t "${DEMO_PAUSE:-0}" _ 2>/dev/null || true; }
hook() { printf '%s' "$1" | $AFR record; }

step "1. An agent works. Every action is recorded into a hash chain."
hook '{"hook_event_name":"UserPromptSubmit","session_id":"demo","cwd":"/app","prompt":"Refund customer #4521 and update the ledger"}'
hook '{"hook_event_name":"PostToolUse","session_id":"demo","cwd":"/app","tool_name":"Read","tool_input":{"file_path":"/app/ledger.db"},"tool_response":"balance: $120.00"}'
hook '{"hook_event_name":"PostToolUse","session_id":"demo","cwd":"/app","tool_name":"Bash","tool_input":{"command":"stripe refunds create --charge ch_4521 --amount 12000"},"tool_response":"re_3OqX succeeded: $120.00 refunded"}'
hook '{"hook_event_name":"PostToolUse","session_id":"demo","cwd":"/app","tool_name":"Edit","tool_input":{"file_path":"/app/ledger.db","old_string":"4521: open","new_string":"4521: refunded $120.00"},"tool_response":"ok"}'
hook '{"hook_event_name":"Stop","session_id":"demo","cwd":"/app"}'
$AFR log

step "2. Verify: every record links to the previous one. Intact."
$AFR verify || true

if [ "${1:-}" = "seal" ]; then
  step "3. Seal the chain to Filecoin Onchain Cloud (Warm Storage + daily PDP proofs)."
  $AFR seal
fi

step "4. Later, someone doctors the history: the \$120 refund becomes \$12,000."
LOG="$AFR_DIR/log.jsonl"
node -e '
  const fs = require("node:fs")
  const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n")
  const r = JSON.parse(lines[2])
  r.data.preview = r.data.preview.replace("--amount 12000", "--amount 1200000")
  lines[2] = JSON.stringify(r)
  fs.writeFileSync(process.argv[1], lines.join("\n") + "\n")
  console.log("  (edited record #2 in place — same file, same length, looks plausible)")
' "$LOG"

step "5. Verify again: the chain catches it instantly."
$AFR verify && exit 1 || true

if [ "${1:-}" = "seal" ]; then
  step "6. And Filecoin still holds the original — fetch it back and verify independently."
  $AFR verify --remote || true
fi

printf '\n\033[1mReceipts, not self-reports.\033[0m\n\n'
