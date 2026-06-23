FROM python:3.12-slim

# Install system dependencies + lacework CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates jq \
    && curl -sL https://raw.githubusercontent.com/lacework/go-sdk/main/cli/install.sh \
       | bash -s -- -d /usr/local/bin \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install lacework SCA + SAST components (non-interactive)
RUN lacework component install sca --noninteractive 2>/dev/null || true

WORKDIR /app
COPY serve.py chatbox.html ./
COPY extension/ ./extension/

# .env and lacework config injected at runtime via env vars or volume
ENV PYTHONUNBUFFERED=1

EXPOSE 8765

CMD ["python3", "serve.py"]
