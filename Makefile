.PHONY: help setup up down logs ps dev dev-api dev-web migrate rollback test lint format

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-10s %s\n", $$1, $$2}'

setup: ## Create .env from the template (if missing) and install dependencies
	@test -f .env || cp .env.example .env
	npm install

up: ## Start PostgreSQL and Redis and wait until healthy
	docker compose up -d --wait

down: ## Stop services (data volumes are kept)
	docker compose down

logs: ## Follow service logs
	docker compose logs -f

ps: ## Show service status
	docker compose ps

dev: ## Run API and web together
	npm run dev

dev-api: ## Run the API only
	npm run dev:api

dev-web: ## Run the web app only
	npm run dev:web

migrate: ## Apply database migrations (development database)
	npm run db:migrate

rollback: ## Roll back the last migration batch
	npm run db:rollback

test: ## Run all tests
	npm test

lint: ## Lint and check formatting
	npm run lint && npm run format:check

format: ## Auto-format the codebase
	npm run format
