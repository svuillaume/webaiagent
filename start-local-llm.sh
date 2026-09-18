#!/bin/bash
set -e

VENV_DIR="$HOME/local-llm-env"
PORT=8000
API_KEY="token-abc123"

# Pick which model to serve: ./start-local-llm.sh [llama2|phi]
# Only one model runs at a time — llama-cpp-python's server loads a single --model file.
# To switch, stop the current server and re-run with the other name.
CHOICE="${1:-llama2}"
case "$CHOICE" in
  llama2)
    MODEL_NAME="Llama-2-7B-Chat-GGUF"
    MODEL_URL="https://huggingface.co/TheBloke/Llama-2-7B-Chat-GGUF/resolve/main/llama-2-7b-chat.Q4_K_M.gguf"
    ;;
  phi)
    # Text-only — Phi-3.5-vision-instruct (the on-device WebGPU model) has no working GGUF for
    # mainline llama.cpp (the only community conversion, abetlen/Phi-3.5-vision-instruct-gguf,
    # says outright "does not currently work with main branch of llama.cpp"). This is the
    # regular Phi-3.5-mini-instruct instead — same family/branding, well-supported GGUF, no
    # vision support server-side.
    MODEL_NAME="Phi-3.5-mini-instruct-GGUF"
    MODEL_URL="https://huggingface.co/bartowski/Phi-3.5-mini-instruct-GGUF/resolve/main/Phi-3.5-mini-instruct-Q4_K_M.gguf"
    ;;
  *)
    echo "Usage: $0 [llama2|phi]"
    exit 1
    ;;
esac
MODEL_PATH="$HOME/.local/share/llama-cpp-python/$MODEL_NAME.gguf"

echo "🔍 Checking llama-cpp-python installation..."

if [ ! -d "$VENV_DIR" ]; then
    echo "📦 Creating venv and installing llama-cpp-python..."
    python3 -m venv "$VENV_DIR"
    source "$VENV_DIR/bin/activate"
    pip install --upgrade pip
    pip install llama-cpp-python uvicorn python-dotenv
else
    source "$VENV_DIR/bin/activate"
fi

mkdir -p "$(dirname "$MODEL_PATH")"

if [ ! -f "$MODEL_PATH" ]; then
    echo "⬇️ Downloading $MODEL_NAME..."
    echo "   This may take several minutes..."
    curl -L "$MODEL_URL" -o "$MODEL_PATH"
    echo "✅ Model downloaded"
fi

echo "🚀 Starting llama-cpp-python server on port $PORT ($MODEL_NAME)..."
echo "   API Key: $API_KEY"
echo "   Base URL: http://localhost:$PORT/v1"
python3 -m llama_cpp.server \
    --model "$MODEL_PATH" \
    --n_ctx 2048 \
    --n_gpu_layers 0 \
    --host 0.0.0.0 \
    --port $PORT \
    --api_key "$API_KEY"
