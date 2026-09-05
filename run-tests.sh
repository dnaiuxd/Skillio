#!/bin/bash
# Run both test suites. No dependencies beyond the backend venv and node.
#
#     ./run-tests.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

fail=0

printf '\n--- backend (python) ---\n'
if [ -x backend/.venv/bin/python ]; then
  (cd backend && .venv/bin/python -m unittest test_backend -q) || fail=1
else
  echo "  skipped: no venv at backend/.venv"
  echo "  create it with: cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  fail=1
fi

printf '\n--- frontend (node) ---\n'
if command -v node >/dev/null 2>&1; then
  node frontend/tests/run.js || fail=1
else
  echo "  skipped: node not found"
  fail=1
fi

printf '\n'
[ "$fail" -eq 0 ] && echo "all suites passed" || echo "FAILURES"
exit "$fail"
