.PHONY: install build dev start test lint clean db-migrate db-reset help

# Default target
.DEFAULT_GOAL := help

# Variables
NODE_BIN := ./node_modules/.bin
TSX := $(NODE_BIN)/tsx
TSC := $(NODE_BIN)/tsc
ESLINT := $(NODE_BIN)/eslint

# Install dependencies
install:
	npm install

# Build TypeScript
build: clean
	$(TSC)

# Run in development mode
dev:
	$(TSX) src/index.ts $(ARGS)

# Run production build
start: build
	node dist/index.js $(ARGS)

# Run linter
lint:
	$(ESLINT) src/

# Clean build artifacts
clean:
	rm -rf dist/

# Database migrations
db-migrate:
	$(TSX) src/index.ts db:migrate

# Reset database
db-reset:
	$(TSX) src/index.ts db:reset

# Fetch market data
fetch:
	$(TSX) src/index.ts fetch $(ARGS)

# Run predictions
predict:
	$(TSX) src/index.ts predict $(ARGS)

# Evaluate predictions
evaluate:
	$(TSX) src/index.ts evaluate $(ARGS)

# Show summary
summary:
	$(TSX) src/index.ts summary $(ARGS)

# List trading pairs
pairs:
	$(TSX) src/index.ts pairs

# Watch mode
watch:
	$(TSX) src/index.ts watch $(ARGS)

# Help
help:
	@echo "Crypto Snipper - Makefile Commands"
	@echo ""
	@echo "Setup:"
	@echo "  make install      Install dependencies"
	@echo "  make build        Build TypeScript to JavaScript"
	@echo "  make clean        Remove build artifacts"
	@echo ""
	@echo "Development:"
	@echo "  make dev          Run in development mode"
	@echo "  make start        Run production build"
	@echo "  make lint         Run ESLint"
	@echo ""
	@echo "Database:"
	@echo "  make db-migrate   Run database migrations"
	@echo "  make db-reset     Reset database"
	@echo ""
	@echo "Commands:"
	@echo "  make fetch        Fetch market data"
	@echo "  make predict      Run predictions"
	@echo "  make evaluate     Evaluate predictions"
	@echo "  make summary      Show accuracy summary"
	@echo "  make pairs        List trading pairs"
	@echo "  make watch        Watch mode"
	@echo ""
	@echo "Pass arguments with ARGS:"
	@echo "  make fetch ARGS='--symbol BTC/IDR'"
	@echo "  make predict ARGS='--formula both --interval 15'"
