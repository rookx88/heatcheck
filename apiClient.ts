import type { HeatcheckPost } from './index';

// ===================================================================================
// BACKEND API CLIENT
// ===================================================================================
// This client connects to the real backend server (backend.ts) running on port 3001.
// Make sure the backend server is running before using these functions.
// ===================================================================================

// Always use the backend API server - use environment variable if set, otherwise default to localhost:3001
// Note: For Vite to use env vars in the browser, they must be prefixed with VITE_
// The backend runs on port 3001, so API calls should always go there regardless of where the frontend is served from
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// API_KEY should be in .env.local as VITE_API_KEY (not just API_KEY, needs VITE_ prefix for browser)
const API_KEY = import.meta.env.VITE_API_KEY || '';

// Debug logging - helps identify issues
if (typeof window !== 'undefined') {
    console.log('API Client Config:', { 
        API_URL, 
        hasAPIKey: !!API_KEY,
        currentOrigin: window.location.origin,
        viteEnv: {
            VITE_API_URL: import.meta.env.VITE_API_URL || 'not set (using default: http://localhost:3001)',
            VITE_API_KEY: import.meta.env.VITE_API_KEY ? 'set' : 'not set'
        }
    });
}

// Helper to make authenticated API requests
const apiRequest = async (endpoint: string, options: RequestInit = {}): Promise<Response> => {
    // Ensure we always use an absolute URL
    // If endpoint already starts with http, use it as-is, otherwise prepend API_URL
    const url = endpoint.startsWith('http://') || endpoint.startsWith('https://') 
        ? endpoint 
        : `${API_URL}${endpoint}`;
    
    console.log('API Request:', { 
        method: options.method || 'GET', 
        endpoint, 
        url, 
        apiUrl: API_URL,
        currentOrigin: typeof window !== 'undefined' ? window.location.origin : 'N/A'
    });
    
    const headers = {
        'Content-Type': 'application/json',
        ...(API_KEY && { 'X-API-Key': API_KEY }),
        ...options.headers,
    };
    
    console.log('Making request with headers:', { 
        'X-API-Key': API_KEY ? '***' + API_KEY.slice(-4) : 'NOT SET',
        'Content-Type': headers['Content-Type'],
        method: options.method || 'GET'
    });
    
    let response: Response;
    try {
        response = await fetch(url, {
            ...options,
            headers,
        });
    } catch (fetchError: any) {
        // Handle network errors (server not running, CORS, connection refused, etc.)
        console.error('Fetch Error (Network/CORS/Server):', {
            error: fetchError.message || fetchError,
            url,
            method: options.method || 'GET',
            apiUrl: API_URL,
            currentOrigin: typeof window !== 'undefined' ? window.location.origin : 'N/A',
            apiKeySet: !!API_KEY
        });
        
        // Provide helpful error message
        if (fetchError.message?.includes('Failed to fetch') || fetchError.message?.includes('NetworkError')) {
            throw new Error(`Failed to connect to backend server at ${API_URL}. Please ensure the backend server is running on port 3001. Original error: ${fetchError.message}`);
        }
        throw new Error(`Network error: ${fetchError.message || fetchError}`);
    }
    
    if (!response.ok) {
        const errorText = await response.text();
        console.error('API Error Response:', { 
            status: response.status, 
            statusText: response.statusText, 
            errorText, 
            url,
            method: options.method || 'GET',
            headersSent: {
                'X-API-Key': API_KEY ? 'set (***' + API_KEY.slice(-4) + ')' : 'NOT SET',
                'Content-Type': headers['Content-Type']
            }
        });
        throw new Error(`API Error (${response.status}): ${errorText || response.statusText}`);
    }
    
    return response;
};

type HeatcheckPostDraft = Omit<HeatcheckPost, 'id' | 'createdAt' | 'updatedAt' | 'status'>;

export const apiClient = {
    async listPosts(): Promise<HeatcheckPost[]> {
        const response = await apiRequest('/api/posts');
        return response.json();
    },

    async listPublishedPosts(): Promise<HeatcheckPost[]> {
        const response = await apiRequest('/api/posts/published');
        return response.json();
    },

    async getPublishedPostsByDateLeague(date: string, league: string): Promise<HeatcheckPost[]> {
        const response = await apiRequest(`/api/posts/published-by-date-league?date=${encodeURIComponent(date)}&league=${encodeURIComponent(league)}`, {
            method: 'GET',
        });
        return response.json();
    },

    async createDraft(postData: HeatcheckPostDraft): Promise<HeatcheckPost> {
        const response = await apiRequest('/api/posts', {
            method: 'POST',
            body: JSON.stringify(postData),
        });
        return response.json();
    },

    async updatePost(id: string, postData: HeatcheckPost): Promise<HeatcheckPost> {
        const response = await apiRequest(`/api/posts/${id}`, {
            method: 'PUT',
            body: JSON.stringify(postData),
        });
        return response.json();
    },
    
    async deletePost(id: string): Promise<{ message: string }> {
        console.log('deletePost called with id:', id, 'API_KEY present:', !!API_KEY);
        const response = await apiRequest(`/api/posts/${id}`, {
            method: 'DELETE',
        });
        const result = await response.json();
        console.log('deletePost response:', result);
        return result;
    },
    
    async getPostBySlug(slug: string): Promise<HeatcheckPost | null> {
        try {
            const response = await apiRequest(`/api/posts/slug/${slug}`);
            return response.json();
        } catch (error: any) {
            if (error.message.includes('404')) {
                return null;
            }
            throw error;
        }
    },
    
    async importMatchups(startDate: string, endDate: string, leagues: string[]): Promise<{ imported: number; games: Array<{ league: string; teamA: string; teamB: string; date: string }> }> {
        const response = await apiRequest('/api/matchups/import', {
            method: 'POST',
            body: JSON.stringify({ startDate, endDate, leagues }),
        });
        return response.json();
    },

    async importSoccerMatchups(startDate: string, endDate: string, leagues?: string[]): Promise<{ success: boolean; imported: number; skipped: number; games: Array<{ league: string; teamA: string; teamB: string; date: string }> }> {
        const response = await apiRequest('/api/matchups/import-soccer', {
            method: 'POST',
            body: JSON.stringify({ startDate, endDate, leagues: leagues || [] }),
        });
        return response.json();
    },
    
    async getMatchups(): Promise<Array<{ id: string; league: string; teamA: string; teamB: string; scheduledDate: string; scheduledTime: string | null; venue: string | null; status: string }>> {
        const response = await apiRequest('/api/matchups');
        return response.json();
    },

    async getMatchupsV3(startDate?: string, endDate?: string): Promise<Array<{ id: string; league: string; teamA: string; teamB: string; scheduledDate: string; scheduledTime: string | null; venue: string | null; status: string }>> {
        const params = new URLSearchParams();
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
        const qs = params.toString();
        const response = await apiRequest(`/api/matchups/v3${qs ? `?${qs}` : ''}`);
        return response.json();
    },

    async getMatchupsV3Soccer(league?: string, startDate?: string, endDate?: string): Promise<Array<{ id: string; league: string; teamA: string; teamB: string; scheduledDate: string; scheduledTime: string | null; venue: string | null; status: string }>> {
        const params = new URLSearchParams();
        if (league) params.set('league', league);
        if (startDate) params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
        const qs = params.toString();
        const response = await apiRequest(`/api/matchups/v3/soccer${qs ? `?${qs}` : ''}`);
        return response.json();
    },
    
    async updateMatchup(id: string, scheduledDate: string, scheduledTime?: string | null): Promise<{ success: boolean; matchup: { id: string; scheduledDate: string; scheduledTime: string | null } }> {
        const response = await apiRequest(`/api/matchups/${id}`, {
            method: 'PUT',
            body: JSON.stringify({ scheduledDate, scheduledTime: scheduledTime || null }),
        });
        return response.json();
    },
    
    async getImages(): Promise<string[]> {
        const response = await apiRequest('/api/images');
        return response.json();
    },

    async getMatchPackV3(
        teamA: string,
        teamB: string,
        gameDateEst?: string | null,
        season?: string | null
    ): Promise<{ pack: any }> {
        const params = new URLSearchParams();
        params.set('teamA', teamA);
        params.set('teamB', teamB);
        if (gameDateEst) params.set('gameDateEst', gameDateEst);
        if (season) params.set('season', season);

        const response = await apiRequest(`/api/match-pack-v3?${params.toString()}`, {
            method: 'GET',
        });
        return response.json();
    },

    async getMatchPackV3Soccer(
        teamA: string,
        teamB: string,
        gameDate?: string | null,
        season?: string | null
    ): Promise<{ pack: any }> {
        const params = new URLSearchParams();
        params.set('teamA', teamA);
        params.set('teamB', teamB);
        if (gameDate) params.set('gameDate', gameDate);
        if (season) params.set('season', season);

        const response = await apiRequest(`/api/match-pack-v3/soccer?${params.toString()}`, {
            method: 'GET',
        });
        return response.json();
    },

    async getOddsForGame(eventId: string, sport: string = 'basketball_nba'): Promise<{
        eventId: string;
        gameMarkets: any;
        playerProps: any;
        retrievedAt: string;
    }> {
        try {
            const response = await apiRequest(`/api/odds/game/${eventId}?sport=${encodeURIComponent(sport)}`, {
                method: 'GET',
            });
            const result = await response.json();
            
            // Check if response indicates quota error
            if (result.isQuotaError || result.errorCode === 'OUT_OF_USAGE_CREDITS') {
                const error: any = new Error(result.message || 'TheOddsAPI quota exceeded');
                error.isQuotaError = true;
                throw error;
            }
            
            return result;
        } catch (error: any) {
            // Preserve quota error information
            if (error.message && (error.message.includes('quota') || error.message.includes('OUT_OF_USAGE_CREDITS'))) {
                (error as any).isQuotaError = true;
            }
            throw error;
        }
    },

    async findOddsEventId(teamA: string, teamB: string, gameDate?: string, sport: string = 'basketball_nba'): Promise<{
        eventId: string;
        homeTeam: string;
        awayTeam: string;
        commenceTime: string;
    }> {
        const params = new URLSearchParams();
        params.set('teamA', teamA);
        params.set('teamB', teamB);
        if (gameDate) params.set('gameDate', gameDate);
        params.set('sport', sport);
        
        try {
            const response = await apiRequest(`/api/odds/find-event?${params.toString()}`, {
                method: 'GET',
            });
            const result = await response.json();
            
            // Check if response indicates quota error
            if (result.isQuotaError || result.errorCode === 'OUT_OF_USAGE_CREDITS') {
                const error: any = new Error(result.message || 'TheOddsAPI quota exceeded');
                error.isQuotaError = true;
                throw error;
            }
            
            return result;
        } catch (error: any) {
            // Preserve quota error information
            if (error.message && (error.message.includes('quota') || error.message.includes('OUT_OF_USAGE_CREDITS'))) {
                (error as any).isQuotaError = true;
            }
            throw error;
        }
    }
};
