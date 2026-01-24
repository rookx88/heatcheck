#!/bin/bash

# Simple script to check migration progress and restart if needed
while true; do
    echo "[$(date +'%H:%M:%S')] Checking migration status..."
    
    # Check current count
    COUNT=$(cd scripts && node -e "const { Pool } = require('pg'); require('dotenv').config({ path: '../.env.local' }); const pool = new Pool({ connectionString: process.env.DATABASE_URL }); pool.query(\"SELECT COUNT(*) as migrated FROM posts WHERE data->>'status' = 'published' AND data->'websiteStory'->'seo'->>'slug' LIKE '%-prediction-preview-%'\").then(r => { console.log(r.rows[0].migrated); pool.end(); process.exit(0); }).catch(e => { console.error('0'); process.exit(1); });" 2>/dev/null)
    
    echo "  Migrated: $COUNT / 147"
    
    if [ "$COUNT" -ge 147 ]; then
        echo "✅ Migration complete! All 147 posts migrated."
        break
    fi
    
    # Check if migration is running
    if ! pgrep -f "migrate-to-seo-urls" > /dev/null; then
        echo "  ⚠️  Migration not running. Restarting..."
        npm run migrate:seo > /dev/null 2>&1 &
    else
        echo "  ✓ Migration running"
    fi
    
    # Wait 30 seconds before next check
    sleep 30
done

