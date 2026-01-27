# Cache Purge Checklist for HeatChecks.io

## Philosophy

**Default**: Don't purge. Let TTL-based freshness handle updates naturally via `stale-while-revalidate`.

**Situational**: Only purge when you need instant visibility of new content (e.g., breaking news, critical corrections).

## After Each Deploy

### Standard Post-Deploy Steps

1. ✅ **Check deploy status**
   - Ensure build succeeded in Cloudflare Pages dashboard
   - Verify no build errors or warnings

2. ✅ **Verify content appears**
   - Check that new content appears (may take 5-10 minutes via stale-while-revalidate)
   - Test homepage: Visit `/` and verify new slate appears
   - Test league hubs: Visit `/nba/`, `/nfl/`, etc. and verify updates
   - Be patient: Content will appear automatically within the TTL window

3. ✅ **Monitor cache performance**
   - Check Cloudflare Analytics for cache hit rate (should be >90%)
   - Monitor origin requests (should be low due to caching)
   - Review `CF-Cache-Status` headers in browser dev tools

### When to Purge (Situational Only)

⚠️ **Only purge if you need instant visibility** (not routine):

- **Homepage (`/`)**: If new slate must appear immediately (e.g., breaking news)
- **League Hubs** (`/nba/`, `/nfl/`, `/epl/`, `/dfs/`): If hub updates must appear immediately
- **Specific Matchup Articles**: If critical update needs instant visibility (e.g., injury correction)
- **Sitemap (`/sitemap.xml`)**: If URLs changed and immediate SEO visibility needed

### How to Purge

**Method 1: Cloudflare Dashboard**
1. Log into Cloudflare Dashboard
2. Navigate to your domain
3. Go to **Caching** → **Configuration** → **Purge Cache**
4. Select **Custom Purge**
5. Enter specific URLs (one per line)
6. Click **Purge Everything** (but only for the URLs you entered)

**Method 2: Cloudflare API**
```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache" \
  -H "Authorization: Bearer {api_token}" \
  -H "Content-Type: application/json" \
  --data '{"files":["https://heatchecks.io/","https://heatchecks.io/nba/"]}'
```

**Method 3: Wrangler CLI** (if using Cloudflare Workers/Pages CLI)
```bash
wrangler pages deployment purge --project-name=heatchecks --url=https://heatchecks.io/
```

## What NOT to Purge

❌ **Never purge these**:
- Entire cache (unless emergency)
- Static assets (`/assets/*`)
- Images (`/images/*`, `/assets/images/*`)
- By default after every deploy (let TTL-based freshness work)

## Emergency Procedures

### Critical Content Error

If you discover a critical content error that must be fixed immediately:

1. **Fix the content** in your CMS/database
2. **Trigger a new build** (if needed)
3. **Purge the specific URL** immediately:
   - Use Cloudflare Dashboard or API
   - Purge only the affected page(s)
4. **Verify** the fix appears within 1-2 minutes

### Site-Wide Issue

If there's a site-wide issue requiring full cache purge (rare):

1. **Assess the impact** - Is a full purge really necessary?
2. **Consider alternatives** - Can you fix via selective purge?
3. **If full purge is required**:
   - Use Cloudflare Dashboard → **Purge Everything**
   - Monitor cache hit rate recovery (will take time to rebuild)
   - Expect temporary increase in origin load

## Monitoring & Verification

### How to Verify Cache is Working

1. **Check response headers**:
   ```
   CF-Cache-Status: HIT
   Cache-Control: public, max-age=300, stale-while-revalidate=3600
   ```

2. **Test cache behavior**:
   - Request same URL twice
   - Second request should show `CF-Cache-Status: HIT`
   - Response should be faster on second request

3. **Monitor in Cloudflare Analytics**:
   - Cache hit rate should be >90%
   - Origin requests should be low
   - Edge requests should be high

### Expected Cache Behavior

- **Homepage**: Updates appear within 5 minutes
- **League Hubs**: Updates appear within 10 minutes
- **Matchup Articles**: Updates appear within 1 hour (or immediately if purged)
- **Static Assets**: Never change (immutable cache)

## Troubleshooting

### Content Not Updating

**Symptom**: New content not appearing after deploy

**Check**:
1. Verify build succeeded
2. Check if TTL window has passed (5-10 minutes for hubs)
3. Hard refresh browser (Ctrl+Shift+R / Cmd+Shift+R)
4. Check `CF-Cache-Status` header

**Solution**: 
- Wait for TTL to expire (stale-while-revalidate will update)
- Or purge if instant visibility needed

### Low Cache Hit Rate

**Symptom**: Cache hit rate <90%

**Check**:
1. Verify `_headers` file is deployed correctly
2. Check Cache Rules are configured
3. Review query string handling (Rule 1)
4. Check for excessive purging

**Solution**:
- Verify headers are applied (check response headers)
- Review purge frequency (should be minimal)
- Check Cache Rules configuration

### High Origin Load

**Symptom**: Too many requests hitting origin

**Check**:
1. Cache hit rate (should be >90%)
2. TTL settings (may be too short)
3. Purge frequency (should be minimal)

**Solution**:
- Increase TTLs if appropriate (but balance with freshness needs)
- Reduce purge frequency
- Verify caching is working (check headers)

## Quick Reference

| Content Type | TTL | Update Window | Purge Needed? |
|-------------|-----|---------------|---------------|
| Homepage | 5 min | 5-10 min | Situational |
| League Hubs | 10 min | 10-15 min | Situational |
| Matchup Articles | 1 hour | 1 hour | Situational |
| Heat Picks | 5 min | 5-10 min | Situational |
| Static Assets | 1 year | Never | Never |
| Sitemap | 1 hour | 1 hour | Situational |

## Best Practices

1. **Trust the TTL**: Let `stale-while-revalidate` do its job
2. **Purge sparingly**: Only when instant visibility is critical
3. **Monitor regularly**: Check cache hit rate weekly
4. **Document purges**: Note why you purged (for learning)
5. **Test in staging**: Verify cache behavior before production changes

