#!/bin/bash

# Deploy sync fixes to Fly.io
# This script builds the client and deploys to Fly.io with single instance configuration

set -e  # Exit on error

echo "============================================"
echo "🔧 Deploying Sync Fixes to Fly.io"
echo "============================================"
echo ""

# Step 1: Build client
echo "📦 Step 1: Building client TypeScript..."
npm run build
echo "✅ Client built successfully"
echo ""

# Step 2: Check fly.toml configuration
echo "🔍 Step 2: Verifying fly.toml configuration..."
if grep -q "max_machines_running = 1" fly.toml; then
    echo "✅ Single instance configuration found"
else
    echo "❌ ERROR: max_machines_running = 1 not found in fly.toml"
    echo "Please ensure fly.toml has max_machines_running = 1"
    exit 1
fi
echo ""

# Step 3: Deploy to Fly.io
echo "🚀 Step 3: Deploying to Fly.io..."
echo "This will:"
echo "  - Force single instance (no auto-scaling)"
echo "  - Fix Socket.IO 400 errors"
echo "  - Enable player sync across connections"
echo ""

# Check if flyctl is installed
if ! command -v flyctl &> /dev/null; then
    echo "❌ ERROR: flyctl not found"
    echo "Install it from: https://fly.io/docs/hands-on/install-flyctl/"
    exit 1
fi

# Deploy
flyctl deploy

echo ""
echo "============================================"
echo "✅ Deployment Complete!"
echo "============================================"
echo ""
echo "📊 Next Steps:"
echo ""
echo "1. Check deployment status:"
echo "   flyctl status"
echo ""
echo "2. Verify single instance:"
echo "   Should show only 1 machine running"
echo ""
echo "3. Monitor logs:"
echo "   flyctl logs"
echo ""
echo "4. Test with two browsers:"
echo "   - Open https://jawz-io.fly.dev in Chrome"
echo "   - Open https://jawz-io.fly.dev in Firefox"
echo "   - Both players should see each other!"
echo ""
echo "============================================"

