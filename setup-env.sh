#!/bin/bash
# Creates .env file with base64-encoded Claude credentials for Dokploy

set -e

CREDENTIALS_FILE="$HOME/.claude/.credentials.json"

if [ ! -f "$CREDENTIALS_FILE" ]; then
  echo "Error: $CREDENTIALS_FILE not found"
  exit 1
fi

CREDENTIALS_BASE64=$(cat "$CREDENTIALS_FILE" | base64 -w0)

cat > .env << EOF
CLAUDE_CREDENTIALS_BASE64=$CREDENTIALS_BASE64
EOF

echo "Created .env with CLAUDE_CREDENTIALS_BASE64"
