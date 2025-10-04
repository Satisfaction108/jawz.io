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
echo "🔍 Verifying unified server has all features..."
echo ""

# Check for critical features
if grep -q "shark:collision" server/unified-server.ts; then
    echo "✅ Collision damage events found"
else
    echo "❌ Missing collision damage events!"
fi

if grep -q "dev:levelup" server/unified-server.ts; then
    echo "✅ Z key handler found"
else
    echo "❌ Missing Z key handler!"
fi

if grep -q "Skip Socket.IO routes" server/unified-server.ts; then
    echo "✅ Socket.IO route bypass found"
else
    echo "❌ Missing Socket.IO route bypass!"
fi

if grep -q "level: 1" server/unified-server.ts; then
    echo "✅ Respawn level initialization found"
else
    echo "❌ Missing respawn level initialization!"
fi

echo ""
echo "Starting unified server on http://localhost:3000"
echo "Press Ctrl+C to stop"
echo ""
echo "📋 Test checklist:"
echo "  1. Open http://localhost:3000 in browser"
echo "  2. Check console for Socket.IO errors (should be none)"
echo "  3. Login as WarriorX12"
echo "  4. Press Z key to test levelup (should work)"
echo "  5. Collide with another shark (should take damage)"
echo "  6. Shoot sharks (bullets should hit correctly)"
echo "  7. Eat food (pixel-perfect collision)"
echo "  8. Check for freezing/lag (should be smooth)"
echo ""

# Start the server
npm start

