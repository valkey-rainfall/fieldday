#!/usr/bin/env bash
# Headless-browser e2e. Regenerates the Python reference SVG every run so
# renderer changes can't leave a stale reference (a recurring trap).
# Usage: tests/js/run_e2e.sh [python] [chromium]
set -euo pipefail
cd "$(dirname "$0")/../.."
PY="${1:-.venv/bin/python}"
CHROMIUM="${2:-$HOME/.cache/ms-playwright/chromium_headless_shell-1228/chrome-linux/headless_shell}"
cat > /tmp/e2e_client.c <<'SNIP'
struct client {
    uint64_t id;
    int fd;
    uint8_t resp;
    sds name;
    unsigned flags : 12;
    unsigned paused : 1;
    void *conn;
};
SNIP
"$PY" -m fieldday.cli /tmp/e2e_client.c -o /tmp/e2e_py.svg 2>/dev/null || \
  "$PY" -c "import sys; sys.path.insert(0,'src'); from fieldday.cli import main; sys.exit(main(['/tmp/e2e_client.c','-o','/tmp/e2e_py.svg']))"
node tests/js/run_e2e.mjs "$(pwd)/node_modules/playwright-core" "$CHROMIUM" /tmp/e2e_py.svg
