// TEMPORARY - GET /api/leaderboard-image-test, X-Curate-Secret gated. Renders a
// fixed sample leaderboard through the exact same renderLeaderboardImage path
// /leaderboard uses and returns the raw PNG (or the failure reason as text), so the
// wasm/satori render stack can be verified with curl instead of burning live Discord
// interaction round-trips on every iteration. Reads nothing and writes nothing -
// delete once the render path is confirmed stable.

import type { PagesFunction } from '@cloudflare/workers-types';
import { jsonResponse, type Env } from '../../lib/pages-functions/db';
import { renderLeaderboardImage, renderWelcomeImage, getLastRenderError } from '../../lib/pages-functions/leaderboard-image';
import { renderMeCard, getLastMeError } from '../../lib/pages-functions/me-card';
import { renderCommunityPickImage, getLastCpImageError } from '../../lib/pages-functions/community-pick-image';

const SAMPLE_ROWS = [
    { rank: 1, displayName: 'Sample One', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', scoreLine: '3694 Community Points', scoreValue: '3,694', sr: 712 },
    { rank: 2, displayName: 'Sample Two', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png', scoreLine: '95 Community Points', scoreValue: '95', sr: 488 },
    { rank: 3, displayName: 'Sample Three', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/2.png', scoreLine: '40 Community Points', scoreValue: '40', sr: 315 },
    { rank: 4, displayName: 'Sample Four', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/3.png', scoreLine: '12 Community Points', scoreValue: '12', sr: 204 },
];

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    // ?welcome=1 renders the wizard's welcome card; ?me=1[&level=N] renders the /me
    // card with sample data at any milestone tier (level 27 = Apex gold/black).
    const params = new URL(context.request.url).searchParams;
    let png: Uint8Array | null;
    if (params.get('me') === '1') {
        png = await renderMeCard({
            displayName: 'Sample Player',
            avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png',
            // The test guild's real server icon, so the preview matches what /me
            // shows (the glow circle holds the GUILD icon, not the user avatar).
            guildIconUrl: 'https://cdn.discordapp.com/icons/1537014644621967402/4fda9d85115e21aa76119d5082b7ece3.png?size=512',
            points: 1286,
            rank: 13,
            sr: 517,
            level: Math.max(1, Math.min(27, Number(params.get('level') ?? '3') || 3)),
        });
        if (!png) return jsonResponse({ ok: false, error: getLastMeError() ?? 'unknown' }, { status: 500 });
    } else if (params.get('cp') === '1') {
        png = await renderCommunityPickImage({
            questionText: 'Boston Red Sox vs. New York Yankees',
            sideALabel: 'Boston Red Sox',
            sideBLabel: 'New York Yankees',
            sideAPoints: 58,
            sideBPoints: 42,
            resolveDate: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
        });
        if (!png) return jsonResponse({ ok: false, error: getLastCpImageError() ?? 'unknown' }, { status: 500 });
    } else if (params.get('welcome') === '1') {
        png = await renderWelcomeImage();
    } else {
        png = await renderLeaderboardImage('OVERALL COMMUNITY POINTS', SAMPLE_ROWS);
    }
    if (!png) {
        return jsonResponse({ ok: false, error: getLastRenderError() ?? 'unknown - render returned null with no captured error' }, { status: 500 });
    }
    return new Response(png as unknown as BodyInit, { headers: { 'Content-Type': 'image/png' } }) as unknown as ReturnType<PagesFunction<Env>>;
};
