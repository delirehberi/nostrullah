#!/bin/bash

# Usage: ./add_resource.sh <private_key> <type> <url> <weight>

PRIVATE_KEY=$1
TYPE=$2
URL=$3
WEIGHT=$4

if [ -z "$PRIVATE_KEY" ] || [ -z "$TYPE" ] || [ -z "$URL" ] || [ -z "$WEIGHT" ]; then
  echo "Usage: ./add_resource.sh <private_key> <type> <url> <weight>"
  echo "Example: ./add_resource.sh nsec1... rss https://example.com/rss.xml 5"
  exit 1
fi

DB_NAME="nostr-bot-db"

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo "jq could not be found, please install it to run this script."
    exit 1
fi

echo "Fetching current resources for account..."
# Fetch current data_resources. 
# We use --json to get parseable output.
RESPONSE=$(npx wrangler d1 execute $DB_NAME --remote --command "SELECT data_resources FROM accounts WHERE private_key = '$PRIVATE_KEY'" --json)

# Extract the data_resources field.
# The structure is usually: [ { "results": [ { "data_resources": "..." } ], ... } ]
CURRENT_RESOURCES=$(echo "$RESPONSE" | jq -r '.[0].results[0].data_resources')

# Handle null or empty results
if [ "$CURRENT_RESOURCES" == "null" ] || [ -z "$CURRENT_RESOURCES" ]; then
    echo "No existing resources found or account does not exist. Initializing empty list."
    CURRENT_RESOURCES="[]"
fi

# Create the new resource object
NEW_RESOURCE=$(jq -n \
                  --arg type "$TYPE" \
                  --arg url "$URL" \
                  --argjson weight "$WEIGHT" \
                  '{type: $type, url: $url, weight: $weight}')

# Append the new resource to the current list
UPDATED_RESOURCES=$(echo "$CURRENT_RESOURCES" | jq --argjson new "$NEW_RESOURCE" '. + [$new]' | jq -c .)

# Escape single quotes for SQL
UPDATED_RESOURCES_ESCAPED=$(echo "$UPDATED_RESOURCES" | sed "s/'/''/g")

echo "Updating account resources..."
UPDATE_SQL="UPDATE accounts SET data_resources = '$UPDATED_RESOURCES_ESCAPED' WHERE private_key = '$PRIVATE_KEY';"

npx wrangler d1 execute $DB_NAME --remote --command "$UPDATE_SQL"

echo "Successfully added resource."
