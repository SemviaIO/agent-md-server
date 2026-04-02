#!/bin/bash
# One-time setup after cloning the repository.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

echo "Installing dependencies..."
npm install

echo "Building..."
npm run build

echo "Configuring git hooks..."
git config core.hooksPath .githooks

echo "Setup complete."
