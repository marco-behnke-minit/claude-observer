# Local build/run helpers for claude-observer. All config comes from .env.

.DEFAULT_GOAL := help
.PHONY: help run-hub run-dashboard run-reporter build-hub build-dashboard

help:
	@echo "make run-hub          build + run the hub container (port 7345, config from .env)"
	@echo "make run-dashboard    build + run the dashboard container (interactive TTY)"
	@echo "make run-reporter     run the reporter on this host with auto-reload"
	@echo "make build-hub        just build the hub image"
	@echo "make build-dashboard  just build the dashboard image"

build-hub:
	docker build -f Dockerfile.hub -t claude-observer-hub .

build-dashboard:
	docker build -f Dockerfile.dashboard -t claude-observer-dashboard .

run-hub: build-hub
	docker run --rm --name observer-hub -p 7345:7345 --env-file .env claude-observer-hub

# Inside the container 127.0.0.1 is the container itself, so the hub URL is
# overridden to reach the host (-e wins over --env-file for the same key).
run-dashboard: build-dashboard
	docker run -it --rm --env-file .env \
		-e CLAUDE_OBSERVER_HUB_URL=http://host.docker.internal:7345 \
		-e CLAUDE_OBSERVER_HIDE_STALE_S=60 \
		claude-observer-dashboard

# The reporter runs directly on the host (it must see this machine's
# sessions and system stats), restarting automatically on code changes.
run-reporter:
	node --watch reporter.js
