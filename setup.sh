#!/bin/bash

echo "========================================"
echo "  SyncMaster Backend Setup Script"
echo "========================================"
echo ""

cd "$(dirname "$0")"

echo "[1/4] Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed or not in PATH"
    exit 1
fi
echo "OK: Node.js $(node -v) is available"
echo ""

echo "[2/4] Checking Docker..."
if command -v docker &> /dev/null; then
    echo "OK: Docker is available"
else
    echo "WARNING: Docker is not installed. Please install Docker to run database services."
fi
echo ""

echo "[3/4] Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to install npm dependencies"
    exit 1
fi
echo "OK: Dependencies installed"
echo ""

echo "[4/4] Generating Prisma client..."
npm run db:generate
if [ $? -eq 0 ]; then
    echo "OK: Prisma client generated"
else
    echo "WARNING: Prisma generate failed. This may be OK if the database is not running."
fi
echo ""

echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
echo "Next steps:"
echo ""
echo "Option A - Using Docker (recommended):"
echo "  1. Run: docker-compose up -d"
echo "  2. Run: npm run db:push"
echo "  3. Run: npm run dev"
echo ""
echo "Option B - Local Development:"
echo "  1. Ensure PostgreSQL is running on localhost:5432"
echo "  2. Ensure Redis is running on localhost:6379"
echo "  3. Update .env with your database URL"
echo "  4. Run: npm run db:push"
echo "  5. Run: npm run dev"
echo ""
echo "API will be available at: http://localhost:3000"
echo "WebSocket at: ws://localhost:3000/sessions/{sessionId}/events"
echo ""
