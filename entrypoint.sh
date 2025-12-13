#!/bin/bash
set -e

echo "=== Entrypoint starting ==="
echo "User: $(whoami)"
echo "Home: $HOME"

# Create .claude directory structure
mkdir -p /home/bun/.claude
echo "Created /home/bun/.claude"

# If CLAUDE_CREDENTIALS_BASE64 is set, decode and write it
if [ -n "$CLAUDE_CREDENTIALS_BASE64" ]; then
  echo "CLAUDE_CREDENTIALS_BASE64 is set (length: ${#CLAUDE_CREDENTIALS_BASE64})"
  echo "$CLAUDE_CREDENTIALS_BASE64" | base64 -d > /home/bun/.claude/.credentials.json
  chmod 600 /home/bun/.claude/.credentials.json
  echo "Wrote credentials to /home/bun/.claude/.credentials.json"
  ls -la /home/bun/.claude/
# Fallback to raw JSON if CLAUDE_CREDENTIALS is set
elif [ -n "$CLAUDE_CREDENTIALS" ]; then
  echo "CLAUDE_CREDENTIALS is set (length: ${#CLAUDE_CREDENTIALS})"
  echo "$CLAUDE_CREDENTIALS" > /home/bun/.claude/.credentials.json
  chmod 600 /home/bun/.claude/.credentials.json
  echo "Wrote credentials to /home/bun/.claude/.credentials.json"
  ls -la /home/bun/.claude/
else
  echo "WARNING: No CLAUDE_CREDENTIALS_BASE64 or CLAUDE_CREDENTIALS set!"
fi

# If CLAUDE_SETTINGS_BASE64 is set, decode and write it
if [ -n "$CLAUDE_SETTINGS_BASE64" ]; then
  echo "$CLAUDE_SETTINGS_BASE64" | base64 -d > /home/bun/.claude/settings.json
  echo "Claude settings configured from base64 environment"
elif [ -n "$CLAUDE_SETTINGS" ]; then
  echo "$CLAUDE_SETTINGS" > /home/bun/.claude/settings.json
  echo "Claude settings configured from environment"
fi

# Ensure workspace exists
mkdir -p /home/bun/agent-workspace

# Execute the main command
exec "$@"
