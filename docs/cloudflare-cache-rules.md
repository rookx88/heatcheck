# Cloudflare Cache Rules Configuration

This document describes the Cache Rules to be configured in the Cloudflare Dashboard for HeatChecks.io.

## Overview

These Cache Rules work in conjunction with the `_headers` file to optimize caching behavior. The rules handle query string normalization and provide freshness overrides for critical pages.

## Rule 1: Ignore Query Strings for HTML Pages

**Purpose**: Prevent cache fragmentation from query parameters that don't affect content (UTM parameters, social media tracking, etc.)

**Configuration**:
- **When (Matching Logic)**: 
  ```
  http.request.uri.path matches ".*\\.html$" OR 
  http.request.uri.path eq "/" OR 
  http.request.uri.path matches "^/(nba|nfl|epl|bundesliga|dfs)/"
  ```
- **Action**: 
  - Cache Key → Ignore query string

**Why**: 
- Query strings like `?utm_source=twitter&utm_campaign=promo` don't change the HTML content
- Social platforms add parameters like `fbclid`, `ref`, etc.
- Ignoring query strings for HTML pages increases cache hit rate significantly
- Scoped to HTML pages only to avoid accidentally ignoring query strings on future API endpoints

**Impact**: 
- URLs like `/nba/?utm_source=email` and `/nba/` will share the same cache entry
- Prevents cache fragmentation from marketing campaigns
- Expected cache hit rate improvement: +10-15%

## Rule 2: Homepage Freshness Override

**Purpose**: Ensure the homepage reflects new daily slates quickly

**Configuration**:
- **When (Matching Logic)**: 
  ```
  http.request.uri.path eq "/"
  ```
- **Action**: 
  - Edge TTL → 5 minutes
  - Browser TTL → 5 minutes

**Why**: 
- Homepage changes daily with new slates
- Harmonizes with `_headers` max-age=300 (5 minutes)
- Ensures both edge and browser cache align with content update frequency

**Note**: This rule should not override the `_headers` max-age, but harmonize with it. Cloudflare will respect the more restrictive setting.

## Rule 3: League Hub Freshness

**Purpose**: Balance freshness with cache efficiency for daily hub pages

**Configuration**:
- **When (Matching Logic)**: 
  ```
  http.request.uri.path matches "^/(nba|nfl|epl|bundesliga|dfs)/$"
  ```
- **Action**: 
  - Edge TTL → 10 minutes
  - Browser TTL → 10 minutes

**Why**: 
- League hubs update 1-2x daily
- Harmonizes with `_headers` max-age=600 (10 minutes)
- Provides good balance between freshness and cache efficiency

**Note**: This rule should not override the `_headers` max-age, but harmonize with it. Cloudflare will respect the more restrictive setting.

## Implementation Steps

1. Log into Cloudflare Dashboard
2. Navigate to your HeatChecks.io domain
3. Go to **Rules** → **Cache Rules**
4. Click **Create rule**
5. Configure each rule as specified above
6. Set rule order (order doesn't matter for these rules, but Rule 1 should be evaluated first for query string handling)
7. Save and deploy

## Verification

After implementing these rules:

1. Test query string handling:
   - Visit `/nba/?utm_source=test`
   - Visit `/nba/`
   - Both should return the same cached content (check `CF-Cache-Status` header)

2. Test TTL behavior:
   - Check response headers for `CF-Cache-Status` and `Cache-Control`
   - Verify TTL values match expectations

3. Monitor in Cloudflare Analytics:
   - Check cache hit rate (should improve)
   - Monitor origin requests (should decrease)

## Important Notes

- **No Rule for Static Assets**: Cloudflare Pages already caches static assets optimally. The `_headers` file with `immutable` directive is sufficient.
- **Rule Order**: These rules can be in any order, but Rule 1 (query string) should be evaluated for HTML pages.
- **Conflicts**: If Cache Rules conflict with `_headers`, Cloudflare will use the more restrictive setting.

