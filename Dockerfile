FROM python:3.12-slim

# Install system dependencies + lacework CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates jq poppler-utils \
    && curl -sL https://raw.githubusercontent.com/lacework/go-sdk/main/cli/install.sh \
       | bash -s -- -d /usr/local/bin \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install lacework SCA component for linux/arm64.
# Credentials are mounted as a BuildKit secret (never baked into the image).
# --profile samv matches the [samv] section in ~/.lacework.toml.
RUN --mount=type=secret,id=lacework_toml,target=/root/.lacework.toml \
    lacework component install sca --noninteractive --profile samv \
    || echo "WARNING: SCA component install failed — CodeSec/SBOM will be unavailable"

WORKDIR /app
COPY serve.py chatbox.html FortiCNAPP-LQL_Reference_Guide.txt ./
COPY extension/ ./extension/

# .env and lacework config injected at runtime via env vars or volume
ENV PYTHONUNBUFFERED=1

EXPOSE 45321

CMD ["python3", "serve.py"]
