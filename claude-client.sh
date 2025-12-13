#!/usr/bin/env bash
# Claude Agent Client - Self-contained interactive client
# Usage: curl -fsSL https://raw.githubusercontent.com/cgrdavies/claude-agent-server/main/claude-client.sh -o /tmp/claude-client.sh && bash /tmp/claude-client.sh

set -e

VENV_DIR="${TMPDIR:-/tmp}/claude-client-venv"
SCRIPT_FILE="${TMPDIR:-/tmp}/claude-client-script.py"

# Create venv if needed
if [ ! -d "$VENV_DIR" ]; then
    echo "Setting up environment..."
    python3 -m venv "$VENV_DIR"
    "$VENV_DIR/bin/pip" install -q websockets
fi

# Write Python script to temp file
cat > "$SCRIPT_FILE" << 'PYTHON_EOF'
import asyncio
import json
import os
import sys
import uuid
import websockets

SERVER_URL = os.environ.get("CLAUDE_SERVER_URL", "https://agents.yeeted.lol")
SYSTEM_PROMPT = os.environ.get("SYSTEM_PROMPT", "You are a helpful assistant.")
session_id = str(uuid.uuid4())

def configure_server():
    from urllib.request import Request, urlopen
    data = json.dumps({"systemPrompt": SYSTEM_PROMPT}).encode("utf-8")
    req = Request(f"{SERVER_URL}/config", data=data, headers={"Content-Type": "application/json"})
    urlopen(req)

async def main():
    global session_id
    print(f"\033[36mConnecting to {SERVER_URL}...\033[0m")
    configure_server()
    ws_url = SERVER_URL.replace("https", "wss").replace("http", "ws") + "/ws"

    async with websockets.connect(ws_url) as ws:
        print("\033[32mConnected!\033[0m Type /quit to exit, /new for new session\n")

        async def receive_messages():
            async for message in ws:
                msg = json.loads(message)
                if msg["type"] == "sdk_message":
                    data = msg["data"]
                    if data["type"] == "assistant":
                        text = "".join(
                            b["text"] if b["type"] == "text" else f"[{b['type']}]"
                            for b in data["message"]["content"]
                        )
                        print(f"\n\033[34mClaude:\033[0m {text}")
                    elif data["type"] == "result":
                        duration = data.get("duration_ms", 0)
                        cost = data.get("total_cost_usd", 0) or 0
                        print(f"\033[90m({duration}ms, ${cost:.4f})\033[0m\n")
                        print("\033[32mYou:\033[0m ", end="", flush=True)
                elif msg["type"] == "error":
                    print(f"\033[31mError: {msg['error']}\033[0m")
                    print("\033[32mYou:\033[0m ", end="", flush=True)

        async def send_messages():
            global session_id
            loop = asyncio.get_event_loop()
            print("\033[32mYou:\033[0m ", end="", flush=True)
            while True:
                line = await loop.run_in_executor(None, sys.stdin.readline)
                if not line:
                    break
                text = line.strip()
                if not text:
                    print("\033[32mYou:\033[0m ", end="", flush=True)
                    continue
                if text == "/quit":
                    return
                if text == "/new":
                    session_id = str(uuid.uuid4())
                    print("New session\n\033[32mYou:\033[0m ", end="", flush=True)
                    continue
                await ws.send(json.dumps({
                    "type": "user_message",
                    "data": {
                        "type": "user",
                        "message": {"role": "user", "content": text},
                        "parent_tool_use_id": None,
                        "session_id": session_id,
                    }
                }))

        done, pending = await asyncio.wait(
            [asyncio.create_task(receive_messages()), asyncio.create_task(send_messages())],
            return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nGoodbye!")
PYTHON_EOF

# Run the script
exec "$VENV_DIR/bin/python" "$SCRIPT_FILE"
