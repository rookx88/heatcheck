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
    seo: {slug: string, metaTitle: string, metaDescription: string};
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
    heatchecksEdge: HeatchecksEdge;
}

const app = express();
const port = 3001;

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// --- DATABASE CONNECTION ---
// The Pool will use the DATABASE_URL from your .env file automatically.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

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
    
    const updatedPost: HeatcheckPost = {
        ...updatedPostData,
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

        // Check if status changed to "published" (trigger static site regeneration)
        const isNowPublished = updatedPost.status === 'published';
        const statusChangedToPublished = isNowPublished && previousStatus !== 'published';
        
        // Trigger static site generation if post was just published
        if (statusChangedToPublished) {
            console.log(`[Static Site] Post ${id} was just published (status changed from "${previousStatus}" to "published"). Regenerating static site...`);
            
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
    console.log('  POST   /api/posts (auth required)');
    console.log('  PUT    /api/posts/:id (auth required)');
    console.log('  DELETE /api/posts/:id (auth required)');
    console.log('  GET    /api/matchups');
    console.log('  PUT    /api/matchups/:id (auth required)');
    console.log('  POST   /api/matchups/import (auth required)');
    console.log('  GET    /sitemap.xml');
    console.log('  GET    /robots.txt');
    console.log(`API Key configured: ${SECRET_API_KEY ? 'YES (***' + SECRET_API_KEY.slice(-4) + ')' : 'NO (using default)'}`);
});