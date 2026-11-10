.PHONY: help setup up down logs ps dev dev-api dev-web dev-patient seed migrate rollback test lint format

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

dev: ## Run the API, staff app and patient website together
	npm run dev

dev-api: ## Run the API only
	npm run dev:api

dev-web: ## Run the staff/employee app only
	npm run dev:web

dev-patient: ## Run the patient website only
	npm run dev:patient

seed: ## Create a demo hospital with fictional data
	npm run seed:demo

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
