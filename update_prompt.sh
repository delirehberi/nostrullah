#!/bin/bash

# Usage: ./update_prompt.sh <private_key>

PRIVATE_KEY=$1

if [ -z "$PRIVATE_KEY" ]; then
  echo "Usage: ./update_prompt.sh <private_key>"
  exit 1
fi

DB_NAME="nostr-bot-db"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "jq could not be found, please install it to run this script."
    exit 1
fi

# Check if vim is installed
if ! command -v vim &> /dev/null; then
    echo "vim could not be found, please install it to run this script."
    exit 1
fi

echo "Fetching current prompt template for account..."

# Configure nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Ensure we are using node 22
nvm use 22

# Fetch current prompt_template.
# We use --json to get parseable output.
RESPONSE=$(npx wrangler d1 execute $DB_NAME --remote --command "SELECT prompt_template FROM accounts WHERE private_key = '$PRIVATE_KEY'" --json)

# Extract the prompt_template field.
# The structure is usually: [ { "results": [ { "prompt_template": "..." } ], ... } ]
CURRENT_PROMPT=$(echo "$RESPONSE" | jq -r '.[0].results[0].prompt_template')

# Create a temporary file
TMP_FILE=$(mktemp)

# Handle null or empty results
if [ "$CURRENT_PROMPT" == "null" ]; then
    echo "No existing prompt found or prompt is empty."
    # Leave file empty or prompt user? Empty is fine for a fresh start.
else
    echo "$CURRENT_PROMPT" > "$TMP_FILE"
fi

echo "Opening vim to edit prompt template..."
vim "$TMP_FILE"

# Capture exit code of vim to see if user saved/quit successfully
if [ $? -ne 0 ]; then
    echo "Vim exited with error. Aborting."
    rm "$TMP_FILE"
    exit 1
fi

NEW_PROMPT=$(cat "$TMP_FILE")

if [ -z "$NEW_PROMPT" ]; then
    echo "New prompt is empty. Aborting update."
    rm "$TMP_FILE"
    exit 1
fi

echo "Updating account prompt template..."

# Escape single quotes for SQL. 
# We use a slightly different approach than typical sed because prompt might contain newlines and many special chars.
# A robust way is to use python or node to escape it, but let's try a simple sed approach first that works for standard text.
# Single quote ' needs to become ''
NEW_PROMPT_ESCAPED=$(echo "$NEW_PROMPT" | sed "s/'/''/g")

UPDATE_SQL="UPDATE accounts SET prompt_template = '$NEW_PROMPT_ESCAPED' WHERE private_key = '$PRIVATE_KEY';"

npx wrangler d1 execute $DB_NAME --remote --command "$UPDATE_SQL"

echo "Successfully updated prompt template."
rm "$TMP_FILE"
