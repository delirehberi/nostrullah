# Makefile for Nostr Bot

# --- Variables ---
# Extract private keys from keys.json and assign them to variables
TECH_KEY := $(shell cat keys.json | jq -r '.[0].privateKey')
SCIENCE_KEY := $(shell cat keys.json | jq -r '.[1].privateKey')
ART_KEY := $(shell cat keys.json | jq -r '.[2].privateKey')

# --- Default ---
.DEFAULT_GOAL := help

# --- Deployment ---
deploy:
	@echo "🚀 Deploying to Cloudflare Workers..."
	@npx wrangler deploy

# --- Add Resources ---
# Usage: make add-resource-rss-tech url="https://example.com/rss.xml" weight=5
add-resource-rss-tech:
	@./add_resource.sh $(TECH_KEY) rss "$(url)" $(weight)

add-resource-rss-science:
	@./add_resource.sh $(SCIENCE_KEY) rss "$(url)" $(weight)

add-resource-rss-art:
	@./add_resource.sh $(ART_KEY) rss "$(url)" $(weight)

# Usage: make add-resource-quote-tech categories="technology,programming" weight=3
add-resource-quote-tech:
	@./add_resource.sh $(TECH_KEY) quote "$(categories)" $(weight)

add-resource-quote-science:
	@./add_resource.sh $(SCIENCE_KEY) quote "$(categories)" $(weight)

add-resource-quote-art:
	@./add_resource.sh $(ART_KEY) quote "$(categories)" $(weight)

# --- Update Prompts ---
# Usage: make update-prompt-tech
update-prompt-tech:
	@./update_prompt.sh $(TECH_KEY)

update-prompt-science:
	@./update_prompt.sh $(SCIENCE_KEY)

update-prompt-art:
	@./update_prompt.sh $(ART_KEY)

# --- Help ---
help:
	@echo "Usage:"
	@echo "  make deploy                           - Deploy to Cloudflare Workers"
	@echo ""
	@echo "  --- Add RSS Resource ---"
	@echo "  make add-resource-rss-tech url=\"...\" weight=\"...\""
	@echo "  make add-resource-rss-science url=\"...\" weight=\"...\""
	@echo "  make add-resource-rss-art url=\"...\" weight=\"...\""
	@echo ""
	@echo "  --- Add Quote Resource ---"
	@echo "  make add-resource-quote-tech categories=\"cat1,cat2\" weight=\"...\""
	@echo "  make add-resource-quote-science categories=\"cat1,cat2\" weight=\"...\""
	@echo "  make add-resource-quote-art categories=\"cat1,cat2\" weight=\"...\""
	@echo ""
	@echo "  --- Update Prompt (Interactive) ---"
	@echo "  make update-prompt-tech"
	@echo "  make update-prompt-science"
	@echo "  make update-prompt-art"

.PHONY: deploy add-resource-rss-tech add-resource-rss-science add-resource-rss-art add-resource-quote-tech add-resource-quote-science add-resource-quote-art update-prompt-tech update-prompt-science update-prompt-art help
