#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' \
  "Manual runner spawn is not supported." \
  "The Worker returns this response for a body-less request:" \
  "HTTP 400" \
  '{"error":"POST /runners requires a non-empty application/json JIT request body"}' \
  "A reservation must already exist in AutopilotControl." \
  "Only reserve() creates a reservation, and only the scale-set listener calls reserve()." \
  "The control HTTP surface has no create route and never returns the reservation token." \
  "The jitConfig is bound to a runnerRequestId from acquirejobs." \
  "Start runners through the scale-set listener and autopilot." \
  "See docs/AUTOPILOT-OPERATIONS.md." \
  "Inspect state with GET /autopilot/control and GET /autopilot/control/reservations." \
  "Do not relax the JIT body validation." \
  "That validation is the kill switch closed by commit 0bd14c7 (PR #12)." >&2

exit 2
