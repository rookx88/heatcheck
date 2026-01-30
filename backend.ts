/**
 * ===================================================================================
 * PRODUCTION-READY BACKEND SERVER (backend.ts)
 * ===================================================================================
 * This file is the complete Node.js Express server with a real PostgreSQL connection.
 * It replaces the previous in-memory array with actual database queries.
 *
 * TO RUN THIS LOCALLY:
 * 1. Create this file inside an `api` directory.
 * 2. In that directory, run `npm init -y`.
 * 3. Install dependencies:
 *    `npm install express cors pg dotenv`
 *    `npm install -D typescript ts-node @types/express @types/cors @types/pg @types/node`
 * 4. Create a `.env` file in the `api` directory with your DATABASE_URL and API_KEY.
 * 5. Create the `posts` table in your PostgreSQL database (schema in previous instructions).
 * 6. Run the server: `npx ts-node backend.ts`
 * ===================================================================================
 */

// FIX: To avoid conflicts with DOM types from the frontend build environment,
// we import the entire 'express' module and use `express.Request`, `express.Response`,
// and `express.NextFunction` to explicitly reference the correct types.
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import 'dotenv/config'; // Loads .env file variables into process.env
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { generatePredictionSlug } from './scripts/utils/slug-generator';

const execAsync = promisify(exec);

// FIX: Decouple backend from frontend by moving type definitions here.
// This prevents TypeScript from loading DOM-related types from the React frontend,
// which was causing conflicts with Express's Request and Response types.
interface HeatcheckStory {
    formatStyle: "QUOTE_LEDE" | "TIMELINE" | "UNSPOKEN" | "TRAP_GAME";
    headline: string;
    dek: string;
    whyItMatters: string[];
    theBackstory: string;
    theData: string[];
    keyMomentsTimeline: {date: string, event: string}[];
    theReceipts: {quote: string, speaker?: string, context?: string, sourceUrl?: string}[];
    pressurePoints: string[];
    whatToWatch: string[];
    edgeAngle: string;
    tags: string[];
    sources: {title: string, url: string, publisher?: string, publishedAt?: string}[];
    seo: {slug: string, metaTitle: string, metaDescription: string, previousSlugs?: string[]};
    image?: string;        // Add this field for image path
    imageUrl?: string;     // Add this field for backward compatibility
}

interface HeatchecksEdge {
    subjectType: "player" | "team";
    subjectName: string;
    game: string;
    marketSnapshot: { retrievedAt: string, books: { book: string, url?: string }[] };
    lines: { marketType: string, label: string, line: string, price?: string, book: string, sourceUrl: string }[];
    lean: "FAVOR" | "FADE" | "NO_EDGE";
    confidence: "low" | "medium" | "high";
    rationaleBullets: string[];
    riskCounterpoints: string[];
    historicalAnalog: { claim: string, sourceUrl: string | null };
    finalCall: string;
}

interface HeatchecksEdgeV2 {
    game: {
        market: "moneyline" | "spread" | "total" | "none";
        selection: "TEAM_A" | "TEAM_B" | "OVER" | "UNDER" | "none";
        line: number | null;
        price_american: number | null;
        book: string | null;
        confidence: "low" | "medium" | "high";
        receipts: [string, string, string];
        risks: [string, string];
        one_sentence_call: string;
    };
    player_props: Array<{
        player_name: string;
        market: string;
        selection: "OVER" | "UNDER";
        line: number;
        price_american: number;
        book: string;
        confidence: "low" | "medium" | "high";
        receipts: [string, string, string];
        risks: [string, string];
    }>;
    no_edge_reason: string | null;
}

interface HeatcheckPost {
    id: string;
    createdAt: string;
    updatedAt: string;
    league: string;
    teamA: string;
    teamB: string;
    storyType: string;
    scanNarrative: string;
    status: "draft" | "published";
    websiteStory: HeatcheckStory;
    heatchecksEdge: HeatchecksEdge | HeatchecksEdgeV2;
}

const app = express();
const port = 3001;

// --- MIDDLEWARE ---
app.use(cors());
// Increase JSON payload limit to 50MB for large Heat Picks articles
app.use(express.json({ limit: '50mb' }));

// --- DATABASE CONNECTION ---
// The Pool will use the DATABASE_URL from your .env file automatically.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// --- NBA HEAT SHEET DATABASE CONNECTION (separate DB for MatchPack V3) ---
// Uses NBA_HEAT_SHEET_DATABASE_URL so we don't mix application content DB with stats DB.
const nbaHeatSheetPool: Pool | null = process.env.NBA_HEAT_SHEET_DATABASE_URL
  ? new Pool({ connectionString: process.env.NBA_HEAT_SHEET_DATABASE_URL })
  : null;

// --- SOCCER DATA DATABASE CONNECTION (separate DB for Soccer MatchPack V3) ---
// Uses SOCCER_DATA_DATABASE_URL for soccer match data and stats.
const soccerDataPool: Pool | null = process.env.SOCCER_DATA_DATABASE_URL
  ? new Pool({ connectionString: process.env.SOCCER_DATA_DATABASE_URL })
  : null;

const SECRET_API_KEY = process.env.API_KEY || 'your-secret-api-key';
const ODDS_API_KEY = process.env.THE_ODDS_API_KEY;

// --- AUTHENTICATION MIDDLEWARE ---
const apiKeyAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const providedKey = req.header('X-API-Key');
    if (providedKey === SECRET_API_KEY) {
        next();
    } else {
        res.status(401).json({ message: 'Unauthorized: Invalid API Key' });
    }
};

// --- HELPER FUNCTIONS FOR MATCHUP IMPORT ---

// Map our league names to OddsAPI sport keys
const LEAGUE_TO_ODDS_API: { [key: string]: string } = {
    'NBA': 'basketball_nba',
    'NFL': 'americanfootball_nfl',
    'EPL': 'soccer_epl',
    'MLB': 'baseball_mlb',
    'NHL': 'icehockey_nhl'
};

/**
 * Format date as YYYY-MM-DD in specific timezone
 * Uses Intl.DateTimeFormat to handle DST automatically
 */
function formatYmdInTimeZone(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);

    const y = parts.find(p => p.type === "year")!.value;
    const m = parts.find(p => p.type === "month")!.value;
    const d = parts.find(p => p.type === "day")!.value;
    return `${y}-${m}-${d}`; // YYYY-MM-DD
}

/**
 * Format time as HH:MM in specific timezone
 * Uses Intl.DateTimeFormat to handle DST automatically
 */
function formatHmInTimeZone(date: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).formatToParts(date);

    const hh = parts.find(p => p.type === "hour")!.value;
    const mm = parts.find(p => p.type === "minute")!.value;
    return `${hh}:${mm}`; // HH:MM
}

// Find or create a team in the database
async function findOrCreateTeam(teamName: string, league: string, pool: Pool): Promise<string> {
    // Normalize team name for matching
    const normalizedName = teamName.trim();
    
    // Try exact match (case-insensitive)
    let result = await pool.query(
        'SELECT id FROM teams WHERE LOWER(name) = LOWER($1) AND league = $2',
        [normalizedName, league]
    );
    
    if (result.rows.length > 0) {
        return result.rows[0].id;
    }
    
    // Try matching by abbreviation if the name looks like it might be an abbreviation
    if (normalizedName.length <= 5) {
        result = await pool.query(
            'SELECT id FROM teams WHERE LOWER(abbreviation) = LOWER($1) AND league = $2',
            [normalizedName, league]
        );
        if (result.rows.length > 0) {
            return result.rows[0].id;
        }
    }
    
    // Try partial match (e.g., "Lakers" matches "Los Angeles Lakers")
    result = await pool.query(
        `SELECT id FROM teams WHERE 
         (LOWER(name) LIKE LOWER($1) || '%' OR LOWER(name) LIKE '%' || LOWER($1)) 
         AND league = $2`,
        [normalizedName, league]
    );
    
    if (result.rows.length > 0) {
        return result.rows[0].id;
    }
    
    // Create new team if no match found
    const newTeamId = crypto.randomUUID();
    await pool.query(
        'INSERT INTO teams (id, name, league, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())',
        [newTeamId, normalizedName, league]
    );
    
    return newTeamId;
}

// --- NBA ABBREVIATION HELPERS (for manual matchup imports) ---
const NBA_ABBREV_TO_TEAM: Record<string, string> = {
    ATL: 'Atlanta Hawks',
    BKN: 'Brooklyn Nets',
    BOS: 'Boston Celtics',
    CHA: 'Charlotte Hornets',
    CHI: 'Chicago Bulls',
    CLE: 'Cleveland Cavaliers',
    DAL: 'Dallas Mavericks',
    DEN: 'Denver Nuggets',
    DET: 'Detroit Pistons',
    GSW: 'Golden State Warriors',
    HOU: 'Houston Rockets',
    IND: 'Indiana Pacers',
    LAC: 'Los Angeles Clippers',
    LAL: 'Los Angeles Lakers',
    MEM: 'Memphis Grizzlies',
    MIA: 'Miami Heat',
    MIL: 'Milwaukee Bucks',
    MIN: 'Minnesota Timberwolves',
    NOP: 'New Orleans Pelicans',
    NYK: 'New York Knicks',
    OKC: 'Oklahoma City Thunder',
    ORL: 'Orlando Magic',
    PHI: 'Philadelphia 76ers',
    PHX: 'Phoenix Suns',
    POR: 'Portland Trail Blazers',
    SAC: 'Sacramento Kings',
    SAS: 'San Antonio Spurs',
    TOR: 'Toronto Raptors',
    UTA: 'Utah Jazz',
    WAS: 'Washington Wizards',
};

function parseEtTimeTo24h(timeStr: string): string {
    // Examples: "7:00 pm ET", "12:00 pm ET", "9:30 pm ET"
    const cleaned = timeStr.replace(/\s*ET\s*$/i, '').trim();
    const match = cleaned.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
    if (!match) throw new Error(`Invalid ET time format: "${timeStr}"`);
    let hh = parseInt(match[1], 10);
    const mm = match[2];
    const ampm = match[3].toLowerCase();
    if (ampm === 'am') {
        if (hh === 12) hh = 0;
    } else {
        if (hh !== 12) hh += 12;
    }
    return `${String(hh).padStart(2, '0')}:${mm}`; // HH:MM
}

async function ensureTeamAbbreviation(pool: Pool, teamId: string, abbreviation: string): Promise<void> {
    const abbrev = abbreviation.trim().toUpperCase();
    if (!abbrev) return;
    const existing = await pool.query('SELECT abbreviation FROM teams WHERE id = $1', [teamId]);
    const current = (existing.rows[0]?.abbreviation || '').trim();
    if (!current) {
        await pool.query('UPDATE teams SET abbreviation = $1, updated_at = NOW() WHERE id = $2', [abbrev, teamId]);
    }
}

type UpcomingWeekGameRow = {
    scheduledDate: string; // YYYY-MM-DD
    homeAbbrev: string;
    awayAbbrev: string;
    venueName: string;
    timeEt: string; // e.g. "7:00 pm ET"
};

function parseUpcomingWeekGamesText(text: string): UpcomingWeekGameRow[] {
    const rows: UpcomingWeekGameRow[] = [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('game_date_est')) continue;
        if (trimmed.startsWith('---')) continue;
        if (/\(\d+\s+rows\)/i.test(trimmed)) continue;

        const parts = line.split('|').map(p => p.trim());
        if (parts.length < 5) continue;

        const scheduledDate = parts[0];
        const homeAbbrev = parts[1];
        const awayAbbrev = parts[2];
        const venueName = parts[3];
        const timeEt = parts[4];

        if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate)) continue;
        if (!homeAbbrev || !awayAbbrev) continue;

        rows.push({
            scheduledDate,
            homeAbbrev,
            awayAbbrev,
            venueName,
            timeEt,
        });
    }
    return rows;
}

// --- API ROUTES ---

// GET /api/images - Get list of available images from assets/images directory
app.get('/api/images', async (req: express.Request, res: express.Response) => {
    try {
        // Path to assets/images directory relative to backend.ts location
        // backend.ts is in the root, so assets/images is at ./assets/images
        const imagesDir = path.join(process.cwd(), 'assets', 'images');
        
        // Check if directory exists
        if (!fs.existsSync(imagesDir)) {
            console.warn(`Images directory not found at: ${imagesDir}`);
            return res.json([]);
        }
        
        // Read directory and filter for image files
        const files = fs.readdirSync(imagesDir);
        const imageFiles = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return ['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext);
            })
            .sort(); // Sort alphabetically
        
        console.log(`[GET /api/images] Found ${imageFiles.length} images in ${imagesDir}`);
        res.json(imageFiles);
    } catch (err) {
        console.error('Error fetching images:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/posts - Get all posts (for admin feed)
app.get('/api/posts', async (req: express.Request, res: express.Response) => {
    try {
        const result = await pool.query('SELECT data FROM posts ORDER BY "updatedAt" DESC');
        // The `data` column contains the full JSONB object for each post.
        const posts = result.rows.map(row => row.data);
        
        // Debug: Log NBA posts from 2026-01-27
        const nbaPosts127 = posts.filter(post => {
            const league = (post.league || '').toUpperCase();
            const date = post.matchupScheduledDate || post.createdAt;
            const dateStr = date ? new Date(date).toISOString().split('T')[0] : '';
            return league === 'NBA' && dateStr === '2026-01-27';
        });
        console.log(`[GET /api/posts] Found ${nbaPosts127.length} NBA posts from 2026-01-27`);
        nbaPosts127.forEach((post, idx) => {
            console.log(`  [${idx + 1}] ${post.websiteStory?.headline?.substring(0, 50)}`, {
                id: post.id,
                league: post.league,
                matchupScheduledDate: post.matchupScheduledDate,
                createdAt: post.createdAt,
                updatedAt: post.updatedAt,
                status: post.status
            });
        });
        
        // Debug: Log Bundesliga posts from 2026-01-27 for comparison
        const bundesligaPosts127 = posts.filter(post => {
            const league = (post.league || '').toUpperCase();
            const date = post.matchupScheduledDate || post.createdAt;
            const dateStr = date ? new Date(date).toISOString().split('T')[0] : '';
            return league === 'BUNDESLIGA' && dateStr === '2026-01-27';
        });
        console.log(`[GET /api/posts] Found ${bundesligaPosts127.length} Bundesliga posts from 2026-01-27`);
        
        res.json(posts);
    } catch (err) {
        console.error('Error fetching posts:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/posts/published - Get only published posts (for public website)
app.get('/api/posts/published', async (req: express.Request, res: express.Response) => {
    try {
        // We use the `->>` operator to access the 'status' key as text within the JSONB `data` column.
        const result = await pool.query(`SELECT data FROM posts WHERE (data->>'status') = 'published' ORDER BY "updatedAt" DESC`);
        const posts = result.rows.map(row => row.data);
        
        // Debug logging
        console.log(`[GET /api/posts/published] Returning ${posts.length} published posts`);
        posts.forEach((post, idx) => {
            console.log(`  [${idx + 1}] ${post.websiteStory?.headline?.substring(0, 40)}`, {
                id: post.id,
                status: post.status,
                matchupScheduledDate: post.matchupScheduledDate,
                hasImage: !!(post.websiteStory?.image || post.websiteStory?.imageUrl),
                imagePath: post.websiteStory?.image || post.websiteStory?.imageUrl || 'none'
            });
        });
        
        res.json(posts);
    } catch (err) {
        console.error('Error fetching published posts:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/posts/published-by-date-league - Get published posts by date and league (for Heat Picks)
app.get('/api/posts/published-by-date-league', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    try {
        const date = String(req.query.date || '').trim();
        const league = String(req.query.league || '').trim();
        
        if (!date || !league) {
            return res.status(400).json({ message: 'Missing required query params: date and league' });
        }
        
        // Query posts matching date and league
        // Check both matchupScheduledDate and createdAt fields
        const query = `
            SELECT data FROM posts 
            WHERE (data->>'status') = 'published' 
            AND (data->>'league') = $1
            AND (
                (data->>'matchupScheduledDate')::date = $2::date 
                OR (data->>'matchupScheduledDate') IS NULL AND (data->>'createdAt')::date = $2::date
            )
            ORDER BY "updatedAt" DESC
        `;
        
        const result = await pool.query(query, [league, date]);
        const posts = result.rows.map(row => row.data);
        
        console.log(`[GET /api/posts/published-by-date-league] Returning ${posts.length} published posts for ${league} on ${date}`);
        
        res.json(posts);
    } catch (err) {
        console.error('Error fetching published posts by date/league:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/posts/slug/:slug - Get a single published post by its slug
app.get('/api/posts/slug/:slug', async (req: express.Request, res: express.Response) => {
    const { slug } = req.params;
    try {
        // This query navigates the nested JSONB to find the slug.
        const result = await pool.query(
            `SELECT data FROM posts WHERE (data->'websiteStory'->'seo'->>'slug') = $1 AND (data->>'status') = 'published'`,
            [slug]
        );

        if (result.rows.length > 0) {
            res.json(result.rows[0].data);
        } else {
            res.status(404).json({ message: 'Post not found' });
        }
    } catch (err) {
        console.error(`Error fetching post by slug "${slug}":`, err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/match-pack-v3 - Get MatchPackV3 JSON from nba_heat_sheet DB (auth required)
app.get('/api/match-pack-v3', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    try {
        if (!nbaHeatSheetPool) {
            return res.status(500).json({ message: 'NBA_HEAT_SHEET_DATABASE_URL is not configured on the server.' });
        }

        const teamA = String(req.query.teamA || '').trim();
        const teamB = String(req.query.teamB || '').trim();
        const gameDateEstRaw = req.query.gameDateEst ? String(req.query.gameDateEst).trim() : '';
        const seasonRaw = req.query.season ? String(req.query.season).trim() : '';

        const closeMargin = req.query.closeMargin ? Number(req.query.closeMargin) : 6;
        const formLeaders = req.query.formLeaders ? Number(req.query.formLeaders) : 3;

        if (!teamA || !teamB) {
            return res.status(400).json({ message: 'Missing required query params: teamA and teamB' });
        }
        if (!Number.isFinite(closeMargin) || closeMargin <= 0 || closeMargin > 50) {
            return res.status(400).json({ message: 'Invalid closeMargin; expected 1-50' });
        }
        if (!Number.isFinite(formLeaders) || formLeaders <= 0 || formLeaders > 10) {
            return res.status(400).json({ message: 'Invalid formLeaders; expected 1-10' });
        }

        // Validate optional date format (YYYY-MM-DD) if provided
        let gameDateEst: string | null = null;
        if (gameDateEstRaw) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDateEstRaw)) {
                return res.status(400).json({ message: 'Invalid gameDateEst; expected YYYY-MM-DD' });
            }
            gameDateEst = gameDateEstRaw;
        }

        const season: string | null = seasonRaw || null;

        const result = await nbaHeatSheetPool.query(
            'select public.get_match_pack_v3($1::text,$2::text,$3::date,$4::varchar,$5::int,$6::int) as pack',
            [teamA, teamB, gameDateEst, season, closeMargin, formLeaders]
        );

        const pack = result.rows?.[0]?.pack ?? null;
        res.json({ pack });
    } catch (err: any) {
        console.error('Error fetching MatchPackV3:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/match-pack-v3/soccer - Get Soccer MatchPackV3 JSON from soccerdata DB (auth required)
app.get('/api/match-pack-v3/soccer', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    try {
        if (!soccerDataPool) {
            return res.status(500).json({ message: 'SOCCER_DATA_DATABASE_URL is not configured on the server.' });
        }

        const teamA = String(req.query.teamA || '').trim();
        const teamB = String(req.query.teamB || '').trim();
        const gameDateRaw = req.query.gameDate ? String(req.query.gameDate).trim() : '';
        const seasonRaw = req.query.season ? String(req.query.season).trim() : '';

        const closeXgDiff = req.query.closeXgDiff ? Number(req.query.closeXgDiff) : 0.5;
        const formLeaders = req.query.formLeaders ? Number(req.query.formLeaders) : 3;

        if (!teamA || !teamB) {
            return res.status(400).json({ message: 'Missing required query params: teamA and teamB' });
        }
        if (!Number.isFinite(closeXgDiff) || closeXgDiff <= 0 || closeXgDiff > 5) {
            return res.status(400).json({ message: 'Invalid closeXgDiff; expected 0.1-5.0' });
        }
        if (!Number.isFinite(formLeaders) || formLeaders <= 0 || formLeaders > 10) {
            return res.status(400).json({ message: 'Invalid formLeaders; expected 1-10' });
        }

        // Validate optional date format (YYYY-MM-DD) if provided
        let gameDate: string | null = null;
        if (gameDateRaw) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDateRaw)) {
                return res.status(400).json({ message: 'Invalid gameDate; expected YYYY-MM-DD' });
            }
            gameDate = gameDateRaw;
        }

        const season: string | null = seasonRaw || null;

        const result = await soccerDataPool.query(
            'select public.get_match_pack_v3_soccer($1::text,$2::text,$3::date,$4::varchar,$5::numeric,$6::int) as pack',
            [teamA, teamB, gameDate, season, closeXgDiff, formLeaders]
        );

        const pack = result.rows?.[0]?.pack ?? null;
        res.json({ pack });
    } catch (err: any) {
        console.error('Error fetching Soccer MatchPackV3:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/odds/game/:eventId - Fetch game odds from OddsAPI (player props disabled) (auth required)
app.get('/api/odds/game/:eventId', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    try {
        if (!ODDS_API_KEY) {
            return res.status(500).json({ message: 'THE_ODDS_API_KEY is not configured on the server.' });
        }

        const eventId = String(req.params.eventId || '').trim();
        const sport = String(req.query.sport || 'basketball_nba').trim();

        if (!eventId) {
            return res.status(400).json({ message: 'Missing required param: eventId' });
        }

        const baseUrl = 'https://api.the-odds-api.com/v4';

        // Fetch game markets (moneyline, spread, total)
        const gameParams = new URLSearchParams({
            apiKey: ODDS_API_KEY,
            regions: 'us',
            markets: 'h2h,spreads,totals',
            dateFormat: 'iso',
            oddsFormat: 'american'
        });
        const gameUrl = `${baseUrl}/sports/${sport}/events/${eventId}/odds?${gameParams.toString()}`;

        // Skip player props - only fetch game markets
        // Fetch game markets only
        const gameResponse = await fetch(gameUrl);

        if (!gameResponse.ok) {
            const errorText = await gameResponse.text();
            console.error(`[GET /api/odds/game/:eventId] Game odds error (${gameResponse.status}):`, errorText);
            
            // Check for quota/usage errors
            let errorData: any = {};
            try {
                errorData = JSON.parse(errorText);
            } catch {
                errorData = { message: errorText };
            }
            
            // Detect quota issues
            const isQuotaError = gameResponse.status === 401 || 
                                errorData.error_code === 'OUT_OF_USAGE_CREDITS' ||
                                errorText.includes('quota') ||
                                errorText.includes('usage');
            
            const errorMessage = isQuotaError 
                ? 'TheOddsAPI usage quota has been reached. Please upgrade your plan or wait for quota reset.'
                : 'Failed to fetch game odds from OddsAPI';
            
            return res.status(gameResponse.status).json({ 
                message: errorMessage,
                error: errorText.substring(0, 500),
                errorCode: errorData.error_code || null,
                isQuotaError: isQuotaError
            });
        }

        const gameData = await gameResponse.json();
        // Player props are no longer fetched - always return null
        const propData = null;

        // Structure the response
        const result: {
            eventId: string;
            gameMarkets: any;
            playerProps: any;
            retrievedAt: string;
        } = {
            eventId,
            gameMarkets: gameData,
            playerProps: propData,
            retrievedAt: new Date().toISOString()
        };

        console.log(`[GET /api/odds/game/:eventId] Returning odds data. Game markets: ${Array.isArray(gameData) ? gameData.length : 'object'}, Player props: disabled (not fetched)`);
        res.json(result);
    } catch (error: any) {
        console.error('[GET /api/odds/game/:eventId] Error:', error);
        res.status(500).json({ message: 'Internal server error', error: error.message });
    }
});

// GET /api/odds/find-event - Find OddsAPI event ID by team names and date (auth required)
app.get('/api/odds/find-event', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    try {
        if (!ODDS_API_KEY) {
            return res.status(500).json({ message: 'THE_ODDS_API_KEY is not configured on the server.' });
        }

        const teamA = String(req.query.teamA || '').trim();
        const teamB = String(req.query.teamB || '').trim();
        let gameDate = String(req.query.gameDate || '').trim();
        const sport = String(req.query.sport || 'basketball_nba').trim();
        
        // Normalize gameDate to YYYY-MM-DD format (handle ISO datetime strings)
        if (gameDate) {
            // If it's already in YYYY-MM-DD format, use it
            if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate)) {
                // Try to parse as ISO datetime and extract date part
                try {
                    const dateObj = new Date(gameDate);
                    if (!isNaN(dateObj.getTime())) {
                        gameDate = dateObj.toISOString().split('T')[0];
                    } else {
                        gameDate = ''; // Invalid date, clear it
                    }
                } catch (e) {
                    console.warn(`[GET /api/odds/find-event] Could not parse gameDate: ${gameDate}`, e);
                    gameDate = ''; // Invalid date, clear it
                }
            }
        }

        if (!teamA || !teamB) {
            return res.status(400).json({ message: 'Missing required query params: teamA and teamB' });
        }

        console.log(`[GET /api/odds/find-event] Sport parameter: "${sport}"`);
        console.log(`[GET /api/odds/find-event] Searching for: "${teamA}" vs "${teamB}" on ${gameDate || 'any date'} (normalized from original)`);
        
        const baseUrl = 'https://api.the-odds-api.com/v4';
        const params = new URLSearchParams({
            apiKey: ODDS_API_KEY,
            regions: 'us',
            markets: 'h2h',
            dateFormat: 'iso',
            oddsFormat: 'american'
        });
        
        const url = `${baseUrl}/sports/${sport}/odds?${params.toString()}`;
        console.log(`[GET /api/odds/find-event] OddsAPI URL: ${url.replace(ODDS_API_KEY || '', 'REDACTED')}`);
        const response = await fetch(url);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[GET /api/odds/find-event] OddsAPI error (${response.status}):`, errorText);
            
            // Check for quota/usage errors
            let errorData: any = {};
            try {
                errorData = JSON.parse(errorText);
            } catch {
                errorData = { message: errorText };
            }
            
            // Detect quota issues
            const isQuotaError = response.status === 401 || 
                                errorData.error_code === 'OUT_OF_USAGE_CREDITS' ||
                                errorText.includes('quota') ||
                                errorText.includes('usage');
            
            const errorMessage = isQuotaError 
                ? 'TheOddsAPI usage quota has been reached. Please upgrade your plan or wait for quota reset.'
                : 'Failed to fetch games from OddsAPI';
            
            return res.status(response.status).json({ 
                message: errorMessage,
                error: errorText.substring(0, 500),
                errorCode: errorData.error_code || null,
                isQuotaError: isQuotaError
            });
        }

        const games = await response.json();
        if (!Array.isArray(games)) {
            return res.status(500).json({ message: 'Invalid response format from OddsAPI' });
        }

        // Enhanced team name normalization
        const normalizeTeamName = (name: string) => {
            return name.toLowerCase()
                .replace(/\s+/g, ' ')
                .replace(/^la\s+/i, 'los angeles ') // "LA Clippers" -> "los angeles clippers"
                .replace(/^ny\s+/i, 'new york ') // "NY Knicks" -> "new york knicks"
                .replace(/^phx\s+/i, 'phoenix ') // "PHX Suns" -> "phoenix suns"
                // Handle RB Leipzig / RasenBallsport Leipzig - normalize both to "rb leipzig" for matching
                .replace(/^rasenballsport\s+/i, 'rb ') // "RasenBallsport Leipzig" -> "rb leipzig"
                // Remove common German/European team prefixes
                .replace(/^(sv|tsg|fc|sc|cf|ac|as|rc|ud|cd|cf|real|athletic|club)\s+/i, '')
                .replace(/\s+(sv|tsg|fc|sc|cf|ac|as|rc|ud|cd|cf)$/i, '')
                // Remove year prefixes (e.g., "1899 Hoffenheim")
                .replace(/^\d{4}\s+/i, '')
                .trim();
        };

        // Extract core team name (removes prefixes and gets main identifier)
        const getTeamNameOnly = (fullName: string) => {
            const normalized = normalizeTeamName(fullName);
            const parts = normalized.split(/\s+/);
            if (parts.length <= 1) return normalized;
            
            // For German teams, try to get meaningful parts
            // "SV Werder Bremen" -> "werder bremen" or "bremen"
            // "TSG Hoffenheim" -> "hoffenheim"
            // "1899 Hoffenheim" -> "hoffenheim"
            
            // If last word is a city name that's also the team name, use it
            // Otherwise, use last 2 words if they form a meaningful name
            if (parts.length >= 2) {
                const lastTwo = parts.slice(-2).join(' ');
                // If the last two words together are meaningful (like "Werder Bremen"), use both
                if (lastTwo.length > 6) {
                    return lastTwo;
                }
            }
            // Otherwise, return last word
            return parts[parts.length - 1];
        };

        const teamANorm = normalizeTeamName(teamA);
        const teamBNorm = normalizeTeamName(teamB);
        const teamANameOnly = getTeamNameOnly(teamA);
        const teamBNameOnly = getTeamNameOnly(teamB);

        console.log(`[GET /api/odds/find-event] Searching for: "${teamA}" vs "${teamB}" on ${gameDate || 'any date'}`);
        console.log(`[GET /api/odds/find-event] Normalized: "${teamANorm}" vs "${teamBNorm}"`);
        console.log(`[GET /api/odds/find-event] Team names only: "${teamANameOnly}" vs "${teamBNameOnly}"`);
        console.log(`[GET /api/odds/find-event] Total games available: ${games.length}`);

        // Helper to check if two team names match (exact or partial)
        const teamsMatch = (team1: string, team2: string, team1NameOnly: string, team2NameOnly: string) => {
            // Exact match
            if (team1 === team2) return true;
            
            // Partial match (one contains the other) - more flexible
            if (team1.includes(team2) || team2.includes(team1)) return true;
            
            // Team name only match (e.g., "Clippers" matches "Los Angeles Clippers")
            // Also handles "bremen" matching "werder bremen" or "sv werder bremen"
            if (team1.includes(team2NameOnly) || team2.includes(team1NameOnly)) return true;
            
            // Reverse check: if one name only is contained in the other full name
            // "werder bremen" should match "bremen" or "sv werder bremen"
            if (team1NameOnly.includes(team2) || team2NameOnly.includes(team1)) return true;
            
            // Exact match on name only (avoid false matches on very short names)
            if (team1NameOnly === team2NameOnly && team1NameOnly.length > 3) return true;
            
            // For multi-word names, check if any significant word matches
            // "werder bremen" vs "bremen" - both contain "bremen"
            const team1Words = team1.split(/\s+/).filter(w => w.length > 3);
            const team2Words = team2.split(/\s+/).filter(w => w.length > 3);
            const commonWords = team1Words.filter(w => team2Words.includes(w));
            if (commonWords.length > 0 && commonWords.some(w => w.length > 4)) return true;
            
            return false;
        };

        // Find matching game
        let matchedGame = null;
        const availableGames: string[] = []; // For debugging
        
        for (const game of games) {
            const homeTeam = normalizeTeamName(game.home_team || '');
            const awayTeam = normalizeTeamName(game.away_team || '');
            const homeTeamNameOnly = getTeamNameOnly(game.home_team || '');
            const awayTeamNameOnly = getTeamNameOnly(game.away_team || '');
            
            // Log available games for debugging (first 10, and all that might match)
            if (availableGames.length < 10) {
                availableGames.push(`${game.home_team} vs ${game.away_team} (${game.commence_time})`);
            }
            
            // Also log games that might match based on partial team name
            const homeNormalized = normalizeTeamName(game.home_team || '');
            const awayNormalized = normalizeTeamName(game.away_team || '');
            if ((homeNormalized.includes(teamANameOnly) || homeNormalized.includes(teamBNameOnly) ||
                 awayNormalized.includes(teamANameOnly) || awayNormalized.includes(teamBNameOnly)) &&
                availableGames.length < 20) {
                availableGames.push(`[POTENTIAL MATCH] ${game.home_team} vs ${game.away_team} (${game.commence_time})`);
            }
            
            // Check if teams match (either order, with flexible matching)
            const matches = (
                (teamsMatch(homeTeam, teamANorm, homeTeamNameOnly, teamANameOnly) && 
                 teamsMatch(awayTeam, teamBNorm, awayTeamNameOnly, teamBNameOnly)) ||
                (teamsMatch(homeTeam, teamBNorm, homeTeamNameOnly, teamBNameOnly) && 
                 teamsMatch(awayTeam, teamANorm, awayTeamNameOnly, teamANameOnly))
            );

            if (matches) {
                // If gameDate provided, check date (convert to EST for comparison)
                if (gameDate) {
                    if (game.commence_time) {
                        try {
                            const gameDateObj = new Date(game.commence_time);
                            
                            // Validate the date object
                            if (isNaN(gameDateObj.getTime())) {
                                console.warn(`[GET /api/odds/find-event] Invalid commence_time: ${game.commence_time}`);
                                // If date is invalid but teams match, use it if no date filter was really needed
                                if (!gameDate) {
                                    matchedGame = game;
                                    break;
                                }
                                continue; // Skip this game
                            }
                            
                            // Convert game date to EST/EDT (America/New_York timezone)
                            let gameDateEST: string;
                            try {
                                gameDateEST = new Intl.DateTimeFormat('en-CA', {
                                    timeZone: 'America/New_York',
                                    year: 'numeric',
                                    month: '2-digit',
                                    day: '2-digit'
                                }).format(gameDateObj);
                            } catch (e) {
                                console.warn(`[GET /api/odds/find-event] Error formatting date to EST:`, e);
                                // Fallback to UTC date string
                                gameDateEST = gameDateObj.toISOString().split('T')[0];
                            }
                            
                            // Compare with target date (which should already be in YYYY-MM-DD format)
                            // gameDateEST will be in YYYY-MM-DD format from Intl.DateTimeFormat
                            if (gameDateEST === gameDate) {
                                console.log(`[GET /api/odds/find-event] Date match found: ${gameDateEST} === ${gameDate}`);
                                matchedGame = game;
                                break;
                            }
                            
                            // Also check if dates are within 1 day (for edge cases)
                            try {
                                const gameDateESTObj = new Date(gameDateEST + 'T00:00:00');
                                const targetDateESTObj = new Date(gameDate + 'T00:00:00');
                                
                                if (!isNaN(gameDateESTObj.getTime()) && !isNaN(targetDateESTObj.getTime())) {
                                    const daysDiffEST = Math.abs(Math.floor((gameDateESTObj.getTime() - targetDateESTObj.getTime()) / (1000 * 60 * 60 * 24)));
                                    
                                    if (daysDiffEST <= 1) {
                                        console.log(`[GET /api/odds/find-event] Date within 1 day: ${gameDateEST} vs ${gameDate} (${daysDiffEST} days)`);
                                        matchedGame = game;
                                        break;
                                    }
                                }
                            } catch (e) {
                                console.warn(`[GET /api/odds/find-event] Error comparing dates (EST):`, e);
                            }
                            
                            // Fallback: also check UTC date and within 1 day
                            try {
                                const gameDateStr = gameDateObj.toISOString().split('T')[0];
                                const targetDateObj = new Date(gameDate + 'T00:00:00Z');
                                
                                if (!isNaN(targetDateObj.getTime())) {
                                    const targetDateStr = targetDateObj.toISOString().split('T')[0];
                                    const daysDiff = Math.abs(Math.floor((gameDateObj.getTime() - targetDateObj.getTime()) / (1000 * 60 * 60 * 24)));
                                    
                                    if (gameDateStr === targetDateStr || daysDiff <= 1) {
                                        matchedGame = game;
                                        break;
                                    }
                                }
                            } catch (e) {
                                console.warn(`[GET /api/odds/find-event] Error comparing dates (UTC):`, e);
                            }
                        } catch (e) {
                            console.warn(`[GET /api/odds/find-event] Error processing date for game ${game.home_team} vs ${game.away_team}:`, e);
                            // If date processing fails but teams match, continue to next game
                            continue;
                        }
                    } else {
                        // No commence_time, but teams match - use it if no date filter
                        if (!gameDate) {
                            matchedGame = game;
                            break;
                        }
                    }
                } else {
                    // No date filter, use first match
                    matchedGame = game;
                    break;
                }
            }
        }

        if (!matchedGame) {
            console.warn(`[GET /api/odds/find-event] Game not found. Searched: "${teamA}" vs "${teamB}" on ${gameDate || 'any'}`);
            console.warn(`[GET /api/odds/find-event] Normalized search: "${teamANorm}" vs "${teamBNorm}"`);
            console.warn(`[GET /api/odds/find-event] Team names only: "${teamANameOnly}" vs "${teamBNameOnly}"`);
            console.warn(`[GET /api/odds/find-event] Available games (showing potential matches):`, availableGames);
            
            // Show all team names from available games for debugging
            const allTeamNames = new Set<string>();
            games.forEach((game: any) => {
                if (game.home_team) allTeamNames.add(game.home_team);
                if (game.away_team) allTeamNames.add(game.away_team);
            });
            console.warn(`[GET /api/odds/find-event] All unique team names in OddsAPI (${allTeamNames.size}):`, Array.from(allTeamNames).slice(0, 30));
            
            return res.status(404).json({ 
                message: 'Event not found in OddsAPI',
                searched: { teamA, teamB, gameDate: gameDate || 'any', normalized: { teamA: teamANorm, teamB: teamBNorm }, nameOnly: { teamA: teamANameOnly, teamB: teamBNameOnly } },
                availableGamesSample: availableGames.slice(0, 20), // Return more for debugging
                allTeamNames: Array.from(allTeamNames).slice(0, 50) // Return team names for debugging
            });
        }
        
        console.log(`[GET /api/odds/find-event] ✅ Match found: ${matchedGame.home_team} vs ${matchedGame.away_team} (ID: ${matchedGame.id})`);

        res.json({
            eventId: matchedGame.id,
            homeTeam: matchedGame.home_team,
            awayTeam: matchedGame.away_team,
            commenceTime: matchedGame.commence_time
        });
    } catch (error: any) {
        console.error('[GET /api/odds/find-event] Error:', error);
        res.status(500).json({ message: 'Internal server error', error: error.message });
    }
});

// POST /api/posts - Create a new post (as a draft)
app.post('/api/posts', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    const now = new Date().toISOString();
    const newPostData = req.body;
    
    const newPost: HeatcheckPost = {
        ...newPostData,
        id: crypto.randomUUID(), // Generate a secure, unique ID
        createdAt: now,
        updatedAt: now,
        status: 'draft',
    };

    try {
        const result = await pool.query(
            'INSERT INTO posts (id, "updatedAt", data) VALUES ($1, $2, $3) RETURNING data',
            [newPost.id, newPost.updatedAt, newPost]
        );
        res.status(201).json(result.rows[0].data);
    } catch (err) {
        console.error('Error creating post:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// PUT /api/posts/:id - Update a post (status or content)
app.put('/api/posts/:id', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const updatedPostData = req.body;
    
    // Get previous status from database to detect status changes
    let previousStatus: string | null = null;
    try {
        const previousResult = await pool.query('SELECT data->>\'status\' as status FROM posts WHERE id = $1', [id]);
        if (previousResult.rows.length > 0) {
            previousStatus = previousResult.rows[0].status;
        }
    } catch (err) {
        console.error('Error fetching previous post status:', err);
        // Continue anyway - this is not critical
    }
    
    // Handle previousSlugs tracking when slug changes
    let updatedPostDataWithSlugs = { ...updatedPostData };
    if (updatedPostData.websiteStory?.seo?.slug) {
        try {
            const previousResult = await pool.query('SELECT data->\'websiteStory\'->\'seo\'->>\'slug\' as slug, data->\'websiteStory\'->\'seo\'->\'previousSlugs\' as previousSlugs FROM posts WHERE id = $1', [id]);
            if (previousResult.rows.length > 0) {
                const oldSlug = previousResult.rows[0].slug;
                const oldPreviousSlugs = previousResult.rows[0].previousSlugs || [];
                const newSlug = updatedPostData.websiteStory.seo.slug;
                
                // If slug changed and old slug exists, add it to previousSlugs
                if (oldSlug && oldSlug !== newSlug && !oldPreviousSlugs.includes(oldSlug)) {
                    updatedPostDataWithSlugs.websiteStory.seo.previousSlugs = [...(Array.isArray(oldPreviousSlugs) ? oldPreviousSlugs : []), oldSlug];
                } else if (oldPreviousSlugs && Array.isArray(oldPreviousSlugs)) {
                    // Preserve existing previousSlugs if slug didn't change
                    updatedPostDataWithSlugs.websiteStory.seo.previousSlugs = oldPreviousSlugs;
                }
            }
        } catch (err) {
            console.error('Error fetching previous slug:', err);
            // Continue anyway - this is not critical
        }
    }
    
    // Sync long_form_markdown from theBackstory (canonical source)
    if (updatedPostDataWithSlugs.websiteStory?.theBackstory) {
        if (!updatedPostDataWithSlugs.heatCheckData) {
            updatedPostDataWithSlugs.heatCheckData = {};
        }
        if (!updatedPostDataWithSlugs.heatCheckData.article) {
            updatedPostDataWithSlugs.heatCheckData.article = {};
        }
        updatedPostDataWithSlugs.heatCheckData.article.long_form_markdown = updatedPostDataWithSlugs.websiteStory.theBackstory;
    }
    
    // Auto-generate SEO slug in prediction format when publishing (if not already in that format)
    const isNowPublished = updatedPostDataWithSlugs.status === 'published';
    const statusChangedToPublished = isNowPublished && previousStatus !== 'published';
    
    if (statusChangedToPublished) {
        // Ensure websiteStory.seo exists
        if (!updatedPostDataWithSlugs.websiteStory) {
            updatedPostDataWithSlugs.websiteStory = {} as any;
        }
        if (!updatedPostDataWithSlugs.websiteStory.seo) {
            updatedPostDataWithSlugs.websiteStory.seo = { slug: '', metaTitle: '', metaDescription: '' };
        }
        
        const currentSlug = updatedPostDataWithSlugs.websiteStory.seo.slug || '';
        const isAlreadyPredictionFormat = currentSlug.includes('-prediction-preview-') && currentSlug.match(/\d{4}-\d{2}-\d{2}$/);
        
        // Only generate if slug is missing or not in prediction format
        if (!currentSlug || !isAlreadyPredictionFormat) {
            const teamA = updatedPostDataWithSlugs.teamA || '';
            const teamB = updatedPostDataWithSlugs.teamB || '';
            const gameDate = updatedPostDataWithSlugs.matchupScheduledDate || updatedPostDataWithSlugs.createdAt || new Date().toISOString();
            
            if (teamA && teamB) {
                const newSlug = generatePredictionSlug(teamA, teamB, gameDate);
                console.log(`[SEO Slug] Auto-generating prediction slug for published post: ${newSlug}`);
                
                // Track old slug if it exists
                if (currentSlug && currentSlug !== newSlug) {
                    const previousSlugs = updatedPostDataWithSlugs.websiteStory.seo.previousSlugs || [];
                    if (!previousSlugs.includes(currentSlug)) {
                        updatedPostDataWithSlugs.websiteStory.seo.previousSlugs = [...previousSlugs, currentSlug];
                    }
                }
                
                updatedPostDataWithSlugs.websiteStory.seo.slug = newSlug;
                
                // Generate basic meta title and description if missing
                if (!updatedPostDataWithSlugs.websiteStory.seo.metaTitle) {
                    updatedPostDataWithSlugs.websiteStory.seo.metaTitle = updatedPostDataWithSlugs.websiteStory.headline || '';
                }
                if (!updatedPostDataWithSlugs.websiteStory.seo.metaDescription) {
                    updatedPostDataWithSlugs.websiteStory.seo.metaDescription = updatedPostDataWithSlugs.websiteStory.dek || '';
                }
            }
        }
    }
    
    const updatedPost: HeatcheckPost = {
        ...updatedPostDataWithSlugs,
        id,
        updatedAt: new Date().toISOString(),
    };

    try {
        const result = await pool.query(
            'UPDATE posts SET data = $1, "updatedAt" = $2 WHERE id = $3 RETURNING data',
            [updatedPost, updatedPost.updatedAt, id]
        );
        
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Post not found' });
        }

        // Check if status changed to "published" or if a published post was updated (trigger static site regeneration)
        const isNowPublished = updatedPost.status === 'published';
        const wasPublished = previousStatus === 'published';
        const statusChangedToPublished = isNowPublished && previousStatus !== 'published';
        const publishedPostWasUpdated = isNowPublished && wasPublished;
        
        // Trigger static site generation if:
        // 1. Post was just published (status changed to published), OR
        // 2. A published post was updated (to reflect changes on the static site)
        if (statusChangedToPublished || publishedPostWasUpdated) {
            const reason = statusChangedToPublished 
                ? `just published (status changed from "${previousStatus}" to "published")`
                : `published post was updated`;
            console.log(`[Static Site] Post ${id} was ${reason}. Regenerating static site...`);
            
            // Run static site generation asynchronously (don't block the API response)
            // Use npm run to use the configured script, which handles cross-platform compatibility
            const command = 'npm run build:static';
            
            execAsync(command, { 
                cwd: process.cwd(),
                maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large output
                env: { ...process.env } // Pass through environment variables (especially DATABASE_URL)
            }).then(({ stdout, stderr }) => {
                if (stdout) {
                    console.log('[Static Site] Generation output:', stdout.substring(0, 1000)); // Limit output length
                }
                if (stderr && !stderr.includes('WARN')) {
                    console.warn('[Static Site] Generation warnings:', stderr.substring(0, 500));
                }
                console.log('[Static Site] ✓ Static site regeneration completed successfully');
            }).catch((error) => {
                console.error('[Static Site] ✗ Error regenerating static site:', error.message);
                if (error.stdout) {
                    console.error('[Static Site] stdout:', error.stdout.substring(0, 500));
                }
                if (error.stderr) {
                    console.error('[Static Site] stderr:', error.stderr.substring(0, 500));
                }
                // Don't fail the API request if static generation fails
                // The site will still work, it just won't have the latest static pages until manual regeneration
            });
        }

        res.json(result.rows[0].data);
    } catch (err) {
        console.error(`Error updating post with id "${id}":`, err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// DELETE /api/posts/:id - Delete a post
app.delete('/api/posts/:id', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    
    console.log(`DELETE /api/posts/${id} - Request received`);

    try {
        const result = await pool.query('DELETE FROM posts WHERE id = $1', [id]);
        
        if (result.rowCount === 0) {
            console.log(`DELETE /api/posts/${id} - Post not found`);
            return res.status(404).json({ message: 'Post not found' });
        }

        console.log(`DELETE /api/posts/${id} - Post deleted successfully`);
        res.json({ message: 'Post deleted successfully' });
    } catch (err) {
        console.error(`Error deleting post with id "${id}":`, err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/matchups - Get all available matchups
app.get('/api/matchups', async (req: express.Request, res: express.Response) => {
    try {
        const result = await pool.query(`
            SELECT 
                m.id,
                m.league,
                m.scheduled_date,
                m.scheduled_time,
                m.game_status,
                m.venue,
                ta.name as team_a_name,
                tb.name as team_b_name
            FROM matchups m
            JOIN teams ta ON m.team_a_id = ta.id
            JOIN teams tb ON m.team_b_id = tb.id
            WHERE m.game_status = 'scheduled'
            ORDER BY m.scheduled_date ASC, m.scheduled_time ASC
        `);
        
        const matchups = result.rows.map(row => {
            // Normalize scheduled_time from HH:MM:SS to HH:MM for HTML time input compatibility
            let normalizedTime: string | null = null;
            if (row.scheduled_time) {
                const timeStr = String(row.scheduled_time).trim();
                const timeMatch = timeStr.match(/^(\d{2}):(\d{2})(?::\d{2})?/);
                if (timeMatch) {
                    normalizedTime = `${timeMatch[1]}:${timeMatch[2]}`; // HH:MM format
                }
            }
            
            return {
                id: row.id,
                league: row.league,
                teamA: row.team_a_name,
                teamB: row.team_b_name,
                scheduledDate: row.scheduled_date,
                scheduledTime: normalizedTime,
                venue: row.venue,
                status: row.game_status
            };
        });
        
        res.json(matchups);
    } catch (err) {
        console.error('Error fetching matchups:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/matchups/v3 - List upcoming NBA games from nba_heat_sheet DB for HeatArticleV3 picker
// Returns the same general shape as /api/matchups so the existing modal can be reused.
app.get('/api/matchups/v3', async (req: express.Request, res: express.Response) => {
    try {
        if (!nbaHeatSheetPool) {
            return res.status(500).json({ message: 'NBA_HEAT_SHEET_DATABASE_URL is not configured on the server.' });
        }

        const startDate = req.query.startDate ? String(req.query.startDate).trim() : '';
        const endDate = req.query.endDate ? String(req.query.endDate).trim() : '';

        const params: any[] = [];
        let where = `g.game_date_utc >= now() - interval '6 hours'`;

        if (startDate) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
                return res.status(400).json({ message: 'Invalid startDate; expected YYYY-MM-DD' });
            }
            params.push(startDate);
            where += ` AND g.game_date_est >= $${params.length}::date`;
        }
        if (endDate) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
                return res.status(400).json({ message: 'Invalid endDate; expected YYYY-MM-DD' });
            }
            params.push(endDate);
            where += ` AND g.game_date_est <= $${params.length}::date`;
        }

        const sql = `
            select
                g.game_id as id,
                'NBA' as league,
                ta.full_name as "teamA",
                tb.full_name as "teamB",
                to_char(g.game_date_est, 'YYYY-MM-DD') as "scheduledDate",
                to_char((g.game_date_utc at time zone 'America/New_York'), 'HH24:MI') as "scheduledTime",
                g.venue_name as venue,
                coalesce(g.game_status, 'scheduled') as status
            from public.games g
            join public.teams ta on ta.team_id = g.away_team_id
            join public.teams tb on tb.team_id = g.home_team_id
            where ${where}
            order by g.game_date_utc asc
            limit 300;
        `;

        const result = await nbaHeatSheetPool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching V3 matchups:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// GET /api/matchups/v3/soccer - List upcoming soccer games from soccerdata DB for HeatArticleV3 picker
// Returns the same general shape as /api/matchups/v3 so the existing modal can be reused.
app.get('/api/matchups/v3/soccer', async (req: express.Request, res: express.Response) => {
    try {
        if (!soccerDataPool) {
            return res.status(500).json({ message: 'SOCCER_DATA_DATABASE_URL is not configured on the server.' });
        }

        const league = req.query.league ? String(req.query.league).trim() : '';
        const startDate = req.query.startDate ? String(req.query.startDate).trim() : '';
        const endDate = req.query.endDate ? String(req.query.endDate).trim() : '';

        const params: any[] = [];
        let where = `m.date_utc >= now() - interval '6 hours'`;

        // Filter by league if provided
        // Map common league names to database format
        const leagueMap: Record<string, string> = {
            'EPL': 'ENG-Premier League',
            'Premier League': 'ENG-Premier League',
            'La Liga': 'ESP-La Liga',
            'Serie A': 'ITA-Serie A',
            'Bundesliga': 'GER-Bundesliga',
            'Ligue 1': 'FRA-Ligue 1'
        };
        const dbLeague = league ? (leagueMap[league] || league) : '';

        if (dbLeague) {
            params.push(dbLeague);
            where += ` AND m.league = $${params.length}`;
        }

        if (startDate) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
                return res.status(400).json({ message: 'Invalid startDate; expected YYYY-MM-DD' });
            }
            params.push(startDate);
            where += ` AND m.date_utc::date >= $${params.length}::date`;
        }
        if (endDate) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
                return res.status(400).json({ message: 'Invalid endDate; expected YYYY-MM-DD' });
            }
            params.push(endDate);
            where += ` AND m.date_utc::date <= $${params.length}::date`;
        }

        const sql = `
            select
                m.match_id as id,
                coalesce(m.league, 'ENG-Premier League') as league,
                at.team_name_std as "teamA",
                ht.team_name_std as "teamB",
                to_char(m.date_utc::date, 'YYYY-MM-DD') as "scheduledDate",
                to_char(m.date_utc, 'HH24:MI') as "scheduledTime",
                m.venue as venue,
                coalesce(m.status, 'scheduled') as status
            from public.matches m
            join public.dim_team at on at.team_id = m.away_team_id
            join public.dim_team ht on ht.team_id = m.home_team_id
            where ${where}
            order by m.date_utc asc
            limit 300;
        `;

        const result = await soccerDataPool.query(sql, params);
        res.json(result.rows);
    } catch (err) {
        console.error('Error fetching V3 soccer matchups:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// PUT /api/matchups/:id - Update matchup date and time
app.put('/api/matchups/:id', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { scheduledDate, scheduledTime } = req.body;
    
    console.log(`PUT /api/matchups/${id} - Request received`);
    console.log(`Request body:`, { scheduledDate, scheduledTime });
    
    if (!scheduledDate) {
        console.log(`PUT /api/matchups/${id} - Missing scheduledDate`);
        return res.status(400).json({ message: 'Missing required field: scheduledDate' });
    }
    
    // Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(scheduledDate)) {
        return res.status(400).json({ message: 'Invalid date format. Expected YYYY-MM-DD' });
    }
    
    // Normalize and validate time format (HH:MM or HH:MM:SS -> HH:MM)
    let normalizedTime: string | null = null;
    if (scheduledTime && scheduledTime !== null && scheduledTime !== '') {
        // Remove whitespace and extract HH:MM format (handle both HH:MM and HH:MM:SS)
        // Ensure scheduledTime is a string before calling trim()
        const trimmed = String(scheduledTime).trim();
        const timeMatch = trimmed.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
        if (timeMatch) {
            normalizedTime = `${timeMatch[1]}:${timeMatch[2]}`; // Ensure HH:MM format
        } else {
            console.log(`PUT /api/matchups/${id} - Invalid time format: "${scheduledTime}"`);
            return res.status(400).json({ message: 'Invalid time format. Expected HH:MM (e.g., 20:00)' });
        }
    }
    
    try {
        const result = await pool.query(
            `UPDATE matchups 
             SET scheduled_date = $1, 
                 scheduled_time = $2,
                 updated_at = NOW()
             WHERE id = $3
             RETURNING id, scheduled_date, scheduled_time`,
            [scheduledDate, normalizedTime, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Matchup not found' });
        }
        
        // Normalize scheduled_time in response (HH:MM:SS -> HH:MM)
        let responseTime: string | null = null;
        if (result.rows[0].scheduled_time) {
            const timeStr = String(result.rows[0].scheduled_time).trim();
            const timeMatch = timeStr.match(/^(\d{2}):(\d{2})(?::\d{2})?/);
            if (timeMatch) {
                responseTime = `${timeMatch[1]}:${timeMatch[2]}`; // HH:MM format
            }
        }
        
        console.log(`Updated matchup ${id}: date=${scheduledDate}, time=${normalizedTime || 'null'}`);
        
        res.json({
            success: true,
            matchup: {
                id: result.rows[0].id,
                scheduledDate: result.rows[0].scheduled_date,
                scheduledTime: responseTime
            }
        });
    } catch (err) {
        console.error('Error updating matchup:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// POST /api/matchups/import - Import matchups from OddsAPI
app.post('/api/matchups/import', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    const { startDate, endDate, leagues } = req.body;
    
    if (!startDate || !endDate || !Array.isArray(leagues) || leagues.length === 0) {
        return res.status(400).json({ message: 'Missing required fields: startDate, endDate, leagues' });
    }
    
    if (!ODDS_API_KEY) {
        return res.status(500).json({ message: 'THE_ODDS_API_KEY not configured' });
    }
    
    const importedGames: Array<{ league: string; teamA: string; teamB: string; date: string }> = [];
    let totalImported = 0;
    let totalGamesFromAPI = 0;
    
    try {
        // Process each league
        console.log(`=== IMPORT MATCHUPS REQUEST ===`);
        console.log(`Leagues: ${leagues.join(', ')}`);
        console.log(`Date Range: ${startDate} to ${endDate}`);
        console.log(`ODDS_API_KEY configured: ${ODDS_API_KEY ? 'YES' : 'NO'}`);
        
        for (const league of leagues) {
            const leagueUpper = league.toUpperCase();
            const oddsApiSport = LEAGUE_TO_ODDS_API[leagueUpper];
            if (!oddsApiSport) {
                console.warn(`[${leagueUpper}] Unknown league, skipping. Available leagues:`, Object.keys(LEAGUE_TO_ODDS_API).join(', '));
                continue;
            }
            
            console.log(`[${leagueUpper}] Mapping to OddsAPI sport: ${oddsApiSport}`);
            
            // Fetch games from OddsAPI
            // OddsAPI v4 uses: /sports/{sport}/odds?apiKey=...&regions=us&markets=h2h&dateFormat=iso&oddsFormat=american
            const oddsApiUrl = `https://api.the-odds-api.com/v4/sports/${oddsApiSport}/odds`;
            const params = new URLSearchParams({
                apiKey: ODDS_API_KEY,
                regions: 'us',
                markets: 'h2h',
                dateFormat: 'iso',
                oddsFormat: 'american'
            });
            
            try {
                const fullUrl = `${oddsApiUrl}?${params.toString()}`;
                console.log(`[${leagueUpper}] Fetching from OddsAPI...`);
                console.log(`[${leagueUpper}] URL: ${oddsApiUrl}`);
                console.log(`[${leagueUpper}] Params: regions=us, markets=h2h, dateFormat=iso, oddsFormat=american`);
                
                const response = await fetch(fullUrl);
                
                if (!response.ok) {
                    const errorText = await response.text();
                    console.error(`[${leagueUpper}] OddsAPI error (${response.status}):`, errorText);
                    continue;
                }
                
                const games = await response.json();
                totalGamesFromAPI += Array.isArray(games) ? games.length : 0;
                
                console.log(`[${leagueUpper}] OddsAPI returned ${Array.isArray(games) ? games.length : 0} games`);
                
                if (!Array.isArray(games)) {
                    console.error(`[${leagueUpper}] Unexpected response format from OddsAPI:`, typeof games, games);
                    continue;
                }
                
                if (games.length === 0) {
                    console.warn(`[${leagueUpper}] No games returned from OddsAPI for this league`);
                    continue;
                }
                
                console.log(`[${leagueUpper}] Processing ${games.length} games, filtering by EST date range: ${startDate} to ${endDate}`);
                
                // Process each game
                let gamesProcessed = 0;
                let gamesInDateRange = 0;
                let gamesSkipped = 0;
                
                for (const game of games) {
                    gamesProcessed++;
                    // Extract team names first (needed for logging)
                    const homeTeam = game.home_team || game.away_team;
                    const awayTeam = game.away_team || game.home_team;
                    
                    if (!homeTeam || !awayTeam) {
                        console.warn(`[${leagueUpper}] Skipping game with missing teams:`, game);
                        continue;
                    }
                    
                    // Parse game date and convert to EST timezone
                    if (!game.commence_time) {
                        console.warn(`[${leagueUpper}] Missing commence_time for ${homeTeam} vs ${awayTeam}`);
                        continue;
                    }
                    
                    const commenceTimeStr = String(game.commence_time);
                    let gameDateStr: string;
                    let gameTime: string;
                    
                    try {
                        // Parse the UTC time from OddsAPI
                        const utcDate = new Date(commenceTimeStr);
                        
                        if (isNaN(utcDate.getTime())) {
                            console.warn(`[${leagueUpper}] Invalid commence_time format for ${homeTeam} vs ${awayTeam}:`, commenceTimeStr);
                            continue;
                        }
                        
                        // Convert UTC to America/New_York timezone using Intl.DateTimeFormat
                        // This automatically handles DST correctly (no manual offset calculation needed)
                        const tz = "America/New_York";
                        gameDateStr = formatYmdInTimeZone(utcDate, tz);
                        gameTime = formatHmInTimeZone(utcDate, tz);
                        
                        // Debug logging for date conversion
                        console.log(`[${leagueUpper}] Date conversion:`, {
                            commenceTime: commenceTimeStr,
                            utcDate: utcDate.toISOString(),
                            nyDate: gameDateStr,
                            nyTime: gameTime,
                            timezone: tz
                        });
                    } catch (e) {
                        console.warn(`[${leagueUpper}] Error parsing commence_time for ${homeTeam} vs ${awayTeam}:`, commenceTimeStr, e);
                        continue;
                    }
                    
                    // Check if game is within date range (America/New_York dates)
                    const inDateRange = gameDateStr >= startDate && gameDateStr <= endDate;
                    if (!inDateRange) {
                        gamesSkipped++;
                        console.log(`[${leagueUpper}] [${gamesProcessed}/${games.length}] ❌ Skipping ${homeTeam} vs ${awayTeam}: NY date ${gameDateStr} not in range ${startDate} to ${endDate}`);
                        continue;
                    }
                    
                    gamesInDateRange++;
                    console.log(`[${leagueUpper}] [${gamesProcessed}/${games.length}] ✓ Processing ${homeTeam} vs ${awayTeam} on ${gameDateStr} at ${gameTime} (America/New_York)`);
                    
                    // Find or create teams
                    const teamAId = await findOrCreateTeam(homeTeam, league, pool);
                    const teamBId = await findOrCreateTeam(awayTeam, league, pool);
                    
                    // Check if matchup already exists (prevent duplicates)
                    const existingCheck = await pool.query(
                        `SELECT id FROM matchups 
                         WHERE team_a_id = $1 AND team_b_id = $2 AND scheduled_date = $3 AND league = $4`,
                        [teamAId, teamBId, gameDateStr, league]
                    );
                    
                    if (existingCheck.rows.length > 0) {
                        console.log(`[${leagueUpper}] ⚠ Skipping duplicate: ${homeTeam} vs ${awayTeam} on ${gameDateStr} already exists in database`);
                        continue; // Skip duplicate
                    }
                    
                    // Store odds data in metadata
                    const metadata = {
                        oddsApiId: game.id,
                        oddsApiData: game.bookmakers || [],
                        commenceTime: game.commence_time
                    };
                    
                    // Insert matchup (gameTime already calculated above using formatHmInTimeZone)
                    await pool.query(
                        `INSERT INTO matchups 
                         (id, league, team_a_id, team_b_id, scheduled_date, scheduled_time, game_status, metadata, created_at, updated_at)
                         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'scheduled', $6, NOW(), NOW())`,
                        [league, teamAId, teamBId, gameDateStr, gameTime, JSON.stringify(metadata)]
                    );
                    
                    // Get team names for log
                    const teamAName = await pool.query('SELECT name FROM teams WHERE id = $1', [teamAId]);
                    const teamBName = await pool.query('SELECT name FROM teams WHERE id = $1', [teamBId]);
                    
                    importedGames.push({
                        league,
                        teamA: teamAName.rows[0]?.name || homeTeam,
                        teamB: teamBName.rows[0]?.name || awayTeam,
                        date: gameDateStr
                    });
                    
                    totalImported++;
                    console.log(`[${leagueUpper}] ✅ Successfully imported: ${homeTeam} vs ${awayTeam} on ${gameDateStr}`);
                }
                
                console.log(`[${leagueUpper}] League summary: ${gamesProcessed} games processed, ${gamesInDateRange} in date range, ${gamesSkipped} skipped, ${totalImported - (importedGames.length - gamesInDateRange)} imported`);
            } catch (fetchError: any) {
                console.error(`[${leagueUpper}] ❌ Error fetching games from OddsAPI:`, fetchError.message || fetchError);
                if (fetchError.stack) {
                    console.error(`[${leagueUpper}] Error stack:`, fetchError.stack);
                }
                // Continue with other leagues even if one fails
            }
        }
        
        console.log(`=== IMPORT SUMMARY ===`);
        console.log(`Total games from API: ${totalGamesFromAPI}`);
        console.log(`Total games imported: ${totalImported}`);
        console.log(`Games in response: ${importedGames.length}`);
        console.log(`Date range: ${startDate} to ${endDate}`);
        console.log(`======================`);
        
        res.json({
            success: true,
            imported: totalImported,
            games: importedGames
        });
    } catch (err: any) {
        console.error('Error importing matchups:', err);
        res.status(500).json({ 
            message: 'Internal server error', 
            error: err.message,
            imported: totalImported,
            games: importedGames
        });
    }
});

// POST /api/matchups/import-upcoming-week-games - Import matchups from upcoming_week_games.txt
app.post('/api/matchups/import-upcoming-week-games', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    const league = String(req.body?.league || 'NBA').toUpperCase();
    if (league !== 'NBA') {
        return res.status(400).json({ message: 'Only NBA is supported for this importer right now.' });
    }

    const sourceFile = String(req.body?.sourceFile || 'upcoming_week_games.txt');
    const sourcePath = path.join(process.cwd(), sourceFile);
    if (!fs.existsSync(sourcePath)) {
        return res.status(404).json({ message: `Source file not found: ${sourceFile}` });
    }

    const rawText = fs.readFileSync(sourcePath, 'utf8');
    const rows = parseUpcomingWeekGamesText(rawText);
    if (rows.length === 0) {
        return res.status(400).json({ message: 'No rows parsed from source file.' });
    }

    const importedGames: Array<{ league: string; teamA: string; teamB: string; date: string }> = [];
    let totalImported = 0;
    let totalSkipped = 0;

    try {
        for (const row of rows) {
            const homeAbbrev = row.homeAbbrev.trim().toUpperCase();
            const awayAbbrev = row.awayAbbrev.trim().toUpperCase();

            const homeName = NBA_ABBREV_TO_TEAM[homeAbbrev];
            const awayName = NBA_ABBREV_TO_TEAM[awayAbbrev];
            if (!homeName || !awayName) {
                totalSkipped++;
                console.warn(`[IMPORT upcoming_week_games] Unknown abbrev(s):`, { homeAbbrev, awayAbbrev, scheduledDate: row.scheduledDate });
                continue;
            }

            let scheduledTime: string;
            try {
                scheduledTime = parseEtTimeTo24h(row.timeEt.trim());
            } catch (e: any) {
                totalSkipped++;
                console.warn(`[IMPORT upcoming_week_games] Bad time format:`, { timeEt: row.timeEt, scheduledDate: row.scheduledDate, homeAbbrev, awayAbbrev });
                continue;
            }

            const teamAId = await findOrCreateTeam(homeName, league, pool);
            const teamBId = await findOrCreateTeam(awayName, league, pool);
            await ensureTeamAbbreviation(pool, teamAId, homeAbbrev);
            await ensureTeamAbbreviation(pool, teamBId, awayAbbrev);

            const existingCheck = await pool.query(
                `SELECT id FROM matchups 
                 WHERE team_a_id = $1 AND team_b_id = $2 AND scheduled_date = $3 AND league = $4`,
                [teamAId, teamBId, row.scheduledDate, league]
            );
            if (existingCheck.rows.length > 0) {
                totalSkipped++;
                continue;
            }

            const metadata = {
                source: 'upcoming_week_games.txt',
                sourceFile,
                timezone: 'America/New_York',
                time_et: row.timeEt.trim(),
                home_abbrev: homeAbbrev,
                away_abbrev: awayAbbrev,
            };

            await pool.query(
                `INSERT INTO matchups
                 (id, league, team_a_id, team_b_id, scheduled_date, scheduled_time, game_status, venue, metadata, created_at, updated_at)
                 VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'scheduled', $6, $7, NOW(), NOW())`,
                [league, teamAId, teamBId, row.scheduledDate, scheduledTime, row.venueName || null, JSON.stringify(metadata)]
            );

            importedGames.push({
                league,
                teamA: homeName,
                teamB: awayName,
                date: row.scheduledDate,
            });
            totalImported++;
        }

        return res.json({
            success: true,
            imported: totalImported,
            skipped: totalSkipped,
            games: importedGames,
        });
    } catch (err: any) {
        console.error('Error importing upcoming week games:', err);
        return res.status(500).json({
            message: 'Internal server error',
            error: err.message,
            imported: totalImported,
            skipped: totalSkipped,
            games: importedGames,
        });
    }
});

// GET /api/odds/sports - List all available sports from TheOddsAPI (for debugging)
app.get('/api/odds/sports', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    try {
        if (!ODDS_API_KEY) {
            return res.status(500).json({ message: 'THE_ODDS_API_KEY is not configured on the server.' });
        }

        const baseUrl = 'https://api.the-odds-api.com/v4';
        const url = `${baseUrl}/sports?apiKey=${ODDS_API_KEY}`;
        
        console.log(`[GET /api/odds/sports] Fetching available sports from TheOddsAPI...`);
        const response = await fetch(url);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[GET /api/odds/sports] OddsAPI error (${response.status}):`, errorText);
            return res.status(response.status).json({ 
                message: 'Failed to fetch sports from OddsAPI',
                error: errorText.substring(0, 500)
            });
        }

        const sports = await response.json();
        console.log(`[GET /api/odds/sports] Found ${Array.isArray(sports) ? sports.length : 0} sports`);
        
        // Filter for soccer-related sports
        const soccerSports = Array.isArray(sports) 
            ? sports.filter((s: any) => s.key && s.key.toLowerCase().includes('soccer'))
            : [];
        
        return res.json({
            total: Array.isArray(sports) ? sports.length : 0,
            allSports: sports,
            soccerSports: soccerSports,
            soccerKeys: soccerSports.map((s: any) => s.key)
        });
    } catch (error: any) {
        console.error('[GET /api/odds/sports] Error:', error);
        return res.status(500).json({ message: 'Internal server error', error: error.message });
    }
});

// POST /api/matchups/import-soccer - Import soccer matchups from soccerdata DB
app.post('/api/matchups/import-soccer', apiKeyAuth, async (req: express.Request, res: express.Response) => {
    if (!soccerDataPool) {
        return res.status(500).json({ message: 'SOCCER_DATA_DATABASE_URL is not configured on the server.' });
    }

    const startDate = req.body?.startDate ? String(req.body.startDate).trim() : '';
    const endDate = req.body?.endDate ? String(req.body.endDate).trim() : '';
    const leagues = Array.isArray(req.body?.leagues) ? req.body.leagues.map((l: any) => String(l).trim()) : [];

    if (!startDate || !endDate) {
        return res.status(400).json({ message: 'Missing required fields: startDate and endDate' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return res.status(400).json({ message: 'Invalid date format. Expected YYYY-MM-DD' });
    }

    // Map frontend league names to database format
    const leagueMap: Record<string, string> = {
        'EPL': 'ENG-Premier League',
        'Premier League': 'ENG-Premier League',
        'La Liga': 'ESP-La Liga',
        'Serie A': 'ITA-Serie A',
        'Bundesliga': 'GER-Bundesliga',
        'Ligue 1': 'FRA-Ligue 1'
    };

    // Map database format back to frontend format for storage
    const reverseLeagueMap: Record<string, string> = {
        'ENG-Premier League': 'EPL',
        'ESP-La Liga': 'La Liga',
        'ITA-Serie A': 'Serie A',
        'GER-Bundesliga': 'Bundesliga',
        'FRA-Ligue 1': 'Ligue 1'
    };

    const importedGames: Array<{ league: string; teamA: string; teamB: string; date: string }> = [];
    let totalImported = 0;
    let totalSkipped = 0;

    try {
        // Determine which leagues to import
        const leaguesToImport = leagues.length > 0 
            ? leagues.map(l => leagueMap[l] || l)
            : Object.values(leagueMap); // Import all if none specified

        console.log(`=== IMPORT SOCCER MATCHUPS ===`);
        console.log(`Date Range: ${startDate} to ${endDate}`);
        console.log(`Leagues: ${leaguesToImport.join(', ')}`);

        for (const dbLeague of leaguesToImport) {
            const frontendLeague = reverseLeagueMap[dbLeague] || dbLeague;
            console.log(`\n[${frontendLeague}] Processing league: ${dbLeague}`);

            // Map each league to its local timezone for date filtering
            const leagueTimezoneMap: Record<string, string> = {
                'EPL': 'Europe/London',
                'La Liga': 'Europe/Madrid',
                'Serie A': 'Europe/Rome',
                'Bundesliga': 'Europe/Berlin',
                'Ligue 1': 'Europe/Paris'
            };
            const leagueTz = leagueTimezoneMap[frontendLeague] || 'UTC';
            
            // Query soccer database for matches in date range
            // Use timezone conversion for date filtering to match the league's local timezone
            const sql = `
                SELECT 
                    m.match_id,
                    m.league,
                    m.season,
                    m.date_utc,
                    m.date_utc::date as game_date,
                    m.home_team_id,
                    m.away_team_id,
                    m.venue,
                    m.status,
                    ht.team_name_std as home_team_name,
                    at.team_name_std as away_team_name
                FROM public.matches m
                JOIN public.dim_team ht ON ht.team_id = m.home_team_id
                JOIN public.dim_team at ON at.team_id = m.away_team_id
                WHERE m.league = $1
                    AND (m.date_utc AT TIME ZONE '${leagueTz}')::date >= $2::date
                    AND (m.date_utc AT TIME ZONE '${leagueTz}')::date <= $3::date
                    AND (m.status IS NULL OR m.status = 'scheduled' OR m.status = 'not_started')
                ORDER BY m.date_utc ASC
            `;

            const matches = await soccerDataPool.query(sql, [dbLeague, startDate, endDate]);
            console.log(`[${frontendLeague}] Found ${matches.rows.length} match(es) in date range`);

            for (const match of matches.rows) {
                try {
                    const homeTeam = match.home_team_name;
                    const awayTeam = match.away_team_name;
                    
                    // Convert UTC date_utc to the league's local timezone for accurate date handling
                    // European leagues use their local timezones, not America/New_York
                    const dateUtc = new Date(match.date_utc);
                    if (isNaN(dateUtc.getTime())) {
                        console.warn(`[${frontendLeague}] Invalid date_utc for ${homeTeam} vs ${awayTeam}:`, match.date_utc);
                        totalSkipped++;
                        continue;
                    }
                    
                    // Map each league to its local timezone
                    const leagueTimezoneMap: Record<string, string> = {
                        'EPL': 'Europe/London',
                        'La Liga': 'Europe/Madrid',
                        'Serie A': 'Europe/Rome',
                        'Bundesliga': 'Europe/Berlin',
                        'Ligue 1': 'Europe/Paris'
                    };
                    
                    // Use league-specific timezone, fallback to America/New_York for consistency
                    const tz = leagueTimezoneMap[frontendLeague] || "America/New_York";
                    const gameDate = formatYmdInTimeZone(dateUtc, tz);
                    const gameTime = formatHmInTimeZone(dateUtc, tz);
                    
                    // Debug logging for date conversion
                    console.log(`[${frontendLeague}] Date conversion:`, {
                        dateUtc: match.date_utc,
                        utcDate: dateUtc.toISOString(),
                        localDate: gameDate,
                        localTime: gameTime,
                        timezone: tz
                    });

                    // Find or create teams in main database
                    const teamAId = await findOrCreateTeam(homeTeam, frontendLeague, pool);
                    const teamBId = await findOrCreateTeam(awayTeam, frontendLeague, pool);

                    // Check if matchup already exists
                    const existingCheck = await pool.query(
                        `SELECT id FROM matchups 
                         WHERE team_a_id = $1 AND team_b_id = $2 AND scheduled_date = $3 AND league = $4`,
                        [teamAId, teamBId, gameDate, frontendLeague]
                    );

                    if (existingCheck.rows.length > 0) {
                        console.log(`[${frontendLeague}] ⚠ Skipping duplicate: ${homeTeam} vs ${awayTeam} on ${gameDate}`);
                        totalSkipped++;
                        continue;
                    }

                    // Store metadata
                    const metadata = {
                        source: 'soccerdata_db',
                        matchId: match.match_id,
                        season: match.season,
                        dateUtc: match.date_utc,
                        venue: match.venue || null
                    };

                    // Insert matchup
                    await pool.query(
                        `INSERT INTO matchups 
                         (id, league, team_a_id, team_b_id, scheduled_date, scheduled_time, game_status, venue, metadata, created_at, updated_at)
                         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'scheduled', $6, $7, NOW(), NOW())`,
                        [frontendLeague, teamAId, teamBId, gameDate, gameTime, match.venue || null, JSON.stringify(metadata)]
                    );

                    importedGames.push({
                        league: frontendLeague,
                        teamA: homeTeam,
                        teamB: awayTeam,
                        date: gameDate
                    });

                    totalImported++;
                    console.log(`[${frontendLeague}] ✅ Imported: ${homeTeam} vs ${awayTeam} on ${gameDate} at ${gameTime}`);
                } catch (matchError: any) {
                    console.error(`[${frontendLeague}] ❌ Error importing match:`, matchError.message);
                    totalSkipped++;
                }
            }
        }

        console.log(`\n=== IMPORT SUMMARY ===`);
        console.log(`Total imported: ${totalImported}`);
        console.log(`Total skipped: ${totalSkipped}`);

        return res.json({
            success: true,
            imported: totalImported,
            skipped: totalSkipped,
            games: importedGames
        });
    } catch (err: any) {
        console.error('Error importing soccer matchups:', err);
        return res.status(500).json({
            message: 'Internal server error',
            error: err.message,
            imported: totalImported,
            skipped: totalSkipped,
            games: importedGames
        });
    }
});

// --- STATIC FILE ROUTES (XML/TXT) ---
// Serve sitemap.xml with correct content-type
app.get('/sitemap.xml', (req: express.Request, res: express.Response) => {
    const sitemapPath = path.join(process.cwd(), 'public', 'sitemap.xml');
    if (fs.existsSync(sitemapPath)) {
        res.setHeader('Content-Type', 'application/xml');
        res.sendFile(sitemapPath);
    } else {
        res.status(404).json({ error: 'Sitemap not found' });
    }
});

// Serve robots.txt with correct content-type
app.get('/robots.txt', (req: express.Request, res: express.Response) => {
    const robotsPath = path.join(process.cwd(), 'public', 'robots.txt');
    if (fs.existsSync(robotsPath)) {
        res.setHeader('Content-Type', 'text/plain');
        res.sendFile(robotsPath);
    } else {
        res.status(404).json({ error: 'Robots.txt not found' });
    }
});

// --- SERVER START ---
app.listen(port, () => {
    console.log(`Heatchecks Backend API listening at http://localhost:${port}`);
    console.log('Registered routes:');
    console.log('  GET    /api/images');
    console.log('  GET    /api/posts');
    console.log('  GET    /api/posts/published');
    console.log('  GET    /api/posts/slug/:slug');
    console.log('  GET    /api/match-pack-v3 (auth required)');
    console.log('  GET    /api/odds/game/:eventId (auth required)');
    console.log('  GET    /api/odds/find-event (auth required)');
    console.log('  POST   /api/posts (auth required)');
    console.log('  PUT    /api/posts/:id (auth required)');
    console.log('  DELETE /api/posts/:id (auth required)');
    console.log('  GET    /api/matchups');
    console.log('  GET    /api/matchups/v3');
    console.log('  GET    /api/matchups/v3/soccer');
    console.log('  GET    /api/match-pack-v3/soccer (auth required)');
    console.log('  PUT    /api/matchups/:id (auth required)');
    console.log('  POST   /api/matchups/import (auth required)');
    console.log('  POST   /api/matchups/import-soccer (auth required)');
    console.log('  GET    /sitemap.xml');
    console.log('  GET    /robots.txt');
    console.log(`API Key configured: ${SECRET_API_KEY ? 'YES (***' + SECRET_API_KEY.slice(-4) + ')' : 'NO (using default)'}`);
    console.log(`NBA Heat Sheet DB configured: ${nbaHeatSheetPool ? 'YES' : 'NO (set NBA_HEAT_SHEET_DATABASE_URL)'}`);
    console.log(`Soccer Data DB configured: ${soccerDataPool ? 'YES' : 'NO (set SOCCER_DATA_DATABASE_URL)'}`);
});