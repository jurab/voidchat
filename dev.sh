#!/bin/bash

# Local development script for voidchat
# Starts both the signaling worker and frontend server

set -e

WORKER_PORT=8787
FRONTEND_PORT=5555

cleanup() {
  echo ""
  echo "Shutting down..."
  kill $WORKER_PID 2>/dev/null || true
  kill $FRONTEND_PID 2>/dev/null || true
  exit 0
}

trap cleanup SIGINT SIGTERM

echo "Starting voidchat local development..."
echo ""

# Start worker
echo "Starting signaling worker on port $WORKER_PORT..."
cd worker
npx wrangler dev --port $WORKER_PORT &
WORKER_PID=$!
cd ..

# Wait for worker to be ready
sleep 3

# Start frontend
echo ""
echo "Starting frontend on port $FRONTEND_PORT..."
cd frontend
npx serve -l $FRONTEND_PORT &
FRONTEND_PID=$!
cd ..

echo ""
echo "================================================"
echo "  voidchat is running!"
echo ""
echo "  Frontend: http://localhost:$FRONTEND_PORT"
echo "  Worker:   http://localhost:$WORKER_PORT"
echo ""
echo "  Press Ctrl+C to stop"
echo "================================================"
echo ""

# Wait for either process to exit
wait
