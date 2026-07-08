ANTHROPIC_BASE_URL=https://your-gateway-endpoint/anthropic
BIFROST_VIRTUAL_KEY=sk-bf-your-virtual-key-here
ANTHROPIC_DEFAULT_MODEL=claude-haiku-4-5-20251001
LQL_QUERIES_DIR=

# Optional: token-compression proxy (https://github.com/chopratejas/headroom), run as the
# `headroom` sidecar service in docker-compose.yml. ANTHROPIC_BASE_URL above stays the real
# gateway always — HEADROOM_ENABLED (toggled from the extension's routing badge, or set here)
# decides whether chat requests actually route through it. HEADROOM_URL is how webai reaches it
# server-side (the Compose service DNS name); HEADROOM_DASHBOARD_URL is the host-published address
# the browser opens directly — these differ because host.docker.internal / Compose service names
# only resolve inside containers, never in the browser that opens the dashboard link.
# Running serve.py directly (no Docker)? Both should just be http://127.0.0.1:8787.
HEADROOM_URL=http://headroom:8787
HEADROOM_DASHBOARD_URL=http://127.0.0.1:8787
# HEADROOM_ENABLED=0

# FortiCNAPP credentials — required for Docker (the SCA component install at build
# time, and all runtime lacework CLI calls, authenticate directly off these three;
# no host ~/.lacework.toml needed). Get these from the FortiCNAPP/Lacework console
# under Settings > API Keys. If left unset, serve.py falls back to parsing
# ~/.lacework.toml — which must use the [default] profile (run `lacework configure`
# with no --profile flag).
LW_ACCOUNT=your-account
LW_API_KEY=your-api-key
LW_API_SECRET=your-api-secret
