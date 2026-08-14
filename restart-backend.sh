#!/bin/bash
# Script to restart the backend server

echo "Stopping any existing backend processes..."
pkill -f "tsx.*backend" 2>/dev/null || true
pkill -f "node.*backend" 2>/dev/null || true

# On Windows, try taskkill
if command -v taskkill &> /dev/null; then
    taskkill //F //FI "WINDOWTITLE eq *backend*" 2>/dev/null || true
fi

echo "Waiting 2 seconds..."
sleep 2

echo "Starting backend server..."
npm run backend





























