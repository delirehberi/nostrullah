cat keys.json | jq -c '.[]' | while read -r account; do
  privateKey=$(echo "$account" | jq -r '.privateKey')
  relays=$(echo "$account" | jq -c '.relays' | sed "s/'/''/g") # Escape single quotes
  categories=$(echo "$account" | jq -c '.categories' | sed "s/'/''/g")
  frequency=$(echo "$account" | jq -r '.frequency')
  
  sql="INSERT INTO accounts (name, private_key, relays, categories, frequency, is_active) VALUES ('Imported Account', '$privateKey', '$relays', '$categories', '$frequency', 1);"
  
  echo "Importing account..."
  npx wrangler d1 execute nostr-bot-db --remote --command "$sql"
done