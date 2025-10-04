#!/bin/bash

# Test the unified server locally before deploying

echo "🧪 Testing Jawz.io Unified Server Locally"
echo "=========================================="
echo ""

# Check if client is built
if [ ! -f "client/dist/main.js" ]; then
    echo "❌ Client not built. Building now..."
    npm run build
    if [ $? -ne 0 ]; then
        echo "❌ Build failed!"
        exit 1
    fi
    echo "✅ Client built successfully"
else
    echo "✅ Client already built"
fi

echo ""
echo "Starting unified server on http://localhost:3000"
echo "Press Ctrl+C to stop"
echo ""
echo "Test checklist:"
echo "  1. Open http://localhost:3000 in browser"
echo "  2. Login as WarriorX12"
echo "  3. Press Z key to test levelup"
echo "  4. Test collisions (eat food, shoot sharks)"
echo ""

# Start the server
npm start

