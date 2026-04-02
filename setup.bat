@echo off
echo ========================================
echo   SyncMaster Backend Setup Script
echo ========================================
echo.

cd /d "%~dp0"

echo [1/4] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not installed or not in PATH
    pause
    exit /b 1
)
echo OK: Node.js is available
echo.

echo [2/4] Checking Docker...
docker --version >nul 2>&1
if errorlevel 1 (
    echo WARNING: Docker is not installed. Please install Docker to run database services.
    echo Skipping Docker setup...
) else (
    echo OK: Docker is available
)
echo.

echo [3/4] Installing dependencies...
call npm install
if errorlevel 1 (
    echo ERROR: Failed to install npm dependencies
    pause
    exit /b 1
)
echo OK: Dependencies installed
echo.

echo [4/4] Generating Prisma client...
call npm run db:generate
if errorlevel 1 (
    echo WARNING: Prisma generate failed. This may be OK if the database is not running.
) else (
    echo OK: Prisma client generated
)
echo.

echo ========================================
echo   Setup Complete!
echo ========================================
echo.
echo Next steps:
echo.
echo Option A - Using Docker (recommended):
echo   1. Run: docker-compose up -d
echo   2. Run: npm run db:push
echo   3. Run: npm run dev
echo.
echo Option B - Local Development:
echo   1. Ensure PostgreSQL is running on localhost:5432
echo   2. Ensure Redis is running on localhost:6379
echo   3. Update .env with your database URL
echo   4. Run: npm run db:push
echo   5. Run: npm run dev
echo.
echo API will be available at: http://localhost:3000
echo WebSocket at: ws://localhost:3000/sessions/{sessionId}/events
echo.
pause
