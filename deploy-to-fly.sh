#!/bin/bash

# Jawz.io Fly.io Deployment Script

set -e

echo "🚀 Jawz.io Fly.io Deployment"
echo "=============================="
echo ""

# Check if flyctl is installed
if ! command -v flyctl &> /dev/null && ! command -v fly &> /dev/null; then
    echo "❌ flyctl is not installed."
    echo ""
    echo "Please install it first:"
    echo "  macOS: brew install flyctl"
    echo "  Linux/WSL: curl -L https://fly.io/install.sh | sh"
    echo ""
    exit 1
fi

# Use flyctl or fly command
FLYCMD="flyctl"
if ! command -v flyctl &> /dev/null; then
    FLYCMD="fly"
fi

echo "✅ flyctl found: $($FLYCMD version)"
echo ""

# Check if logged in
if ! $FLYCMD auth whoami &> /dev/null; then
    echo "❌ Not logged in to Fly.io"
    echo "Please run: $FLYCMD auth login"
    exit 1
fi

echo "✅ Logged in as: $($FLYCMD auth whoami)"
echo ""

# Check if app exists
if $FLYCMD status -a jawz-io &> /dev/null; then
    echo "📦 App 'jawz-io' exists. Deploying update..."
    $FLYCMD deploy
else
    echo "🆕 App 'jawz-io' doesn't exist. Creating and deploying..."
    $FLYCMD launch --now
fi

echo ""
echo "✅ Deployment complete!"
echo ""
echo "🌐 Your app should be available at: https://jawz-io.fly.dev"
echo ""
echo "Useful commands:"
echo "  View logs:   $FLYCMD logs -a jawz-io"
echo "  Check status: $FLYCMD status -a jawz-io"
echo "  Open app:    $FLYCMD open -a jawz-io"
echo "  SSH console: $FLYCMD ssh console -a jawz-io"

