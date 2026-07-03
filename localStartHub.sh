#!/bin/bash

docker build -f Dockerfile.hub -t claude-observer-hub .
docker run --rm --name observer-hub -p 7345:7345 --env-file .env claude-observer-hub

