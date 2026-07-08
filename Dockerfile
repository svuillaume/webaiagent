FROM python:3.12-slim

# Install system dependencies + lacework CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates jq poppler-utils \
    && curl -sL https://raw.githubusercontent.com/lacework/go-sdk/main/cli/install.sh \
       | bash -s -- -d /usr/local/bin \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install lacework SCA component for linux/arm64.
# Credentials are mounted as BuildKit secrets (never baked into the image) using
# LW_ACCOUNT/LW_API_KEY/LW_API_SECRET directly — the same env vars serve.py already
# accepts at runtime as a ~/.lacework.toml alternative (see _lw_creds() in serve.py).
# The lacework CLI's -a/-k/-s flags authenticate standalone, with no profile or toml
# file involved, so this works identically regardless of what profile name (if any)
# a given machine's ~/.lacework.toml happens to use. Verified directly: a fresh
# container with no pre-existing toml successfully ran `lacework component install
# sca --noninteractive -a <account> -k <key> -s <secret>` end-to-end.
RUN --mount=type=secret,id=lw_account \
    --mount=type=secret,id=lw_api_key \
    --mount=type=secret,id=lw_api_secret \
    lacework component install sca --noninteractive \
      -a "$(cat /run/secrets/lw_account)" \
      -k "$(cat /run/secrets/lw_api_key)" \
      -s "$(cat /run/secrets/lw_api_secret)" \
    || echo "WARNING: SCA component install failed — CodeSec/SBOM will be unavailable"

WORKDIR /app
COPY vendor/mcp_forticnapp/ ./vendor/mcp_forticnapp/
RUN pip install --no-cache-dir ./vendor/mcp_forticnapp

COPY serve.py chatbox.html FortiCNAPP-LQL_Reference_Guide.txt ./
COPY extension/ ./extension/

# .env and lacework config injected at runtime via env vars or volume
ENV PYTHONUNBUFFERED=1

EXPOSE 45321

CMD ["python3", "serve.py"]
