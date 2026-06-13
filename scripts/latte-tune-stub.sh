#!/bin/bash
# Stub for latte-tune (from latte-rs-model-router).
# Reads prompt from --prompt arg, prints a placeholder review to stdout.
# Install:
#   cp scripts/latte-tune-stub.sh ~/.local/bin/latte-tune
#   chmod +x ~/.local/bin/latte-tune
# Or symlink, or put anywhere on $PATH.

set -e
PROMPT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt) PROMPT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

WORDS=$(echo "$PROMPT" | wc -w)
LINES=$(echo "$PROMPT" | wc -l)
HEADINGS=$(echo "$PROMPT" | grep -c '^#' || true)
WIKILINKS=$(echo "$PROMPT" | grep -o '\[\[[^]]*\]\]' | wc -l || true)

cat <<REVIEW
[latte-tune stub v0.1]
Prompt: ${WORDS} words, ${LINES} lines, ${HEADINGS} headings, ${WIKILINKS} wikilinks

Summary:
  This is a stub response. Install the real latte-tune:
    cd ../latte-rs-model-router && cargo build --release

Suggestions (heuristic):
  - Verify all [[wikilinks]] resolve to existing docs
  - Add a flow diagram for any non-trivial process
  - Keep frontmatter fields in sync with the schema
REVIEW
exit 0
