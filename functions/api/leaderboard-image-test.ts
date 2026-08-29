// TEMPORARY - GET /api/leaderboard-image-test, X-Curate-Secret gated. Renders a
// fixed sample leaderboard through the exact same renderLeaderboardImage path
// /leaderboard uses and returns the raw PNG (or the failure reason as text), so the
// wasm/satori render stack can be verified with curl instead of burning live Discord
// interaction round-trips on every iteration. Reads nothing and writes nothing -
// delete once the render path is confirmed stable.

import type { PagesFunction } from '@cloudflare/workers-types';
import { jsonResponse, type Env } from '../../lib/pages-functions/db';
import { renderLeaderboardImage, getLastRenderError } from '../../lib/pages-functions/leaderboard-image';

const SAMPLE_ROWS = [
    { rank: 1, displayName: 'Sample One', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', scoreLine: '180 Community Points' },
    { rank: 2, displayName: 'Sample Two', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/1.png', scoreLine: '95 Community Points' },
    { rank: 3, displayName: 'Sample Three', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/2.png', scoreLine: '40 Community Points' },
    { rank: 4, displayName: 'Sample Four', avatarUrl: 'https://cdn.discordapp.com/embed/avatars/3.png', scoreLine: '12 Community Points' },
];

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const baseUrl = new URL(context.request.url).origin;
    const png = await renderLeaderboardImage(baseUrl, 'Heatchecks Leaderboard (render test)', SAMPLE_ROWS);
    if (!png) {
        return jsonResponse({ ok: false, error: getLastRenderError() ?? 'unknown - render returned null with no captured error' }, { status: 500 });
    }
    return new Response(png as unknown as BodyInit, { headers: { 'Content-Type': 'image/png' } }) as unknown as ReturnType<PagesFunction<Env>>;
};
