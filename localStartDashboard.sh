#!/bin/bash

docker build -f Dockerfile.dashboard -t claude-observer-dashboard .
docker run -it --env-file .env \
  -e CLAUDE_OBSERVER_HUB_URL=http://host.docker.internal:7345 \
  -e CLAUDE_OBSERVER_HIDE_STALE_S=60 \
  claude-observer-dashboard

