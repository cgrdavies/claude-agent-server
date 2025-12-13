#!/bin/bash
set -e

# Create .claude directory structure
mkdir -p /home/bun/.claude

# If CLAUDE_CREDENTIALS is set, write it to the credentials file
if [ -n "$CLAUDE_CREDENTIALS" ]; then
  echo "$CLAUDE_CREDENTIALS" > /home/bun/.claude/.credentials.json
  chmod 600 /home/bun/.claude/.credentials.json
  echo "Claude credentials configured from environment"
fi

# If CLAUDE_SETTINGS is set, write settings.json
if [ -n "$CLAUDE_SETTINGS" ]; then
  echo "$CLAUDE_SETTINGS" > /home/bun/.claude/settings.json
  echo "Claude settings configured from environment"
fi

# Ensure workspace exists
mkdir -p /home/bun/agent-workspace

# Execute the main command
exec "$@"
