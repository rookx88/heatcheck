import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { markdownToHtml } from '../utils/markdown-converter';
import { escapeHtml } from '../utils/html-escape';
import { formatDateISO, normalizeLeague, getShortTeamName, getTeamAcronym } from '../utils/date-formatter';
import { generateSlug, generateNarrativeSlug, generateMatchupSlug, generatePredictionSlug, extractNarrativeKeywords } from '../utils/slug-generator';
import { calculateV4HeatScore } from '../shared/heat-score-v4';

export interface HeatcheckPost {
    id: string;
    league: string;
    teamA: string;
    teamB: string;
    matchupScheduledDate?: string;
    createdAt: string;
    updatedAt: string;
    storyType?: string;
    websiteStory: {
        headline: string;
        dek: string;
        theBackstory: string;
        seo: {
            slug: string;
            metaTitle: string;
            metaDescription: string;
            previousSlugs?: string[];
        };
        image?: string;
        imageUrl?: string;
    };
    heatCheckData?: {
        narratives?: {
            candidate_cards?: Array<{
                narrative_id: string;
                title: string;
                claim: string;
                emotion_tags?: string[];
                total_score?: number;
            }>;
            selected?: {
                primary_narrative_id: string;
            };
        };
        evidenceBundle?: {
            quotes?: Array<{
                quote: string;
                speaker?: string;
                team?: string;
            }>;
            timeline_events?: Array<{
                event_type?: string;
                summary: string;
                date_utc?: string;
            }>;
        };
        evidence_bundle?: {
            quotes?: Array<{
                quote: string;
                speaker?: string;
                team?: string;
            }>;
            timeline_events?: Array<{
                event_type?: string;
                summary: string;
                date_utc?: string;
            }>;
        };
        article?: {
            long_form_markdown?: string;
        };
        humanPassHtmlBlocks?: {
            early?: string;
            mid?: string;
            closing?: string;
        };
        dfsPlayers?: Array<{
            rank: number;
            playerName: string;
            position: string;
            team: string;
            opponent: string;
            salary: string | number;
            narrativeType: string;
            confidenceScore: number;
            analysis: string;
            keyStat?: string;
        }>;
    };
    heatchecksEdge?: {
        finalCall?: string;
    };
}

/**
 * Get heat score tier label based on unified thresholds
 * Matches the tiers used in radar modals: COOL (0-59), WARM (60-69), HOT (70-79), SCORCHING (80+)
 */
function getHeatScoreTier(heatScore: number): 'COOL' | 'WARM' | 'HOT' | 'SCORCHING' {
    if (heatScore >= 80) return 'SCORCHING';
    if (heatScore >= 70) return 'HOT';
    if (heatScore >= 60) return 'WARM';
    return 'COOL';
}

/**
 * Unified Heat Score Calculation (0-100)
 * Always calculates using V4 -> V3 -> fallback (no stored scores)
 * This ensures consistency across all pages: radar modals, article posts, and Heat Picks cards
 */
function calculateHeatScoreFromMatchupData(post: HeatcheckPost): { total: number; breakdown: { stakes: number; recency: number; payback: number; history: number; emotion: number } } {
    // Special handling for DFS articles
    if (post.storyType === 'dfs_article') {
        const heatCheckData = post.heatCheckData as any;
        const dfsPlayers = heatCheckData?.dfsPlayers || [];
        const articleDate = post.matchupScheduledDate || post.createdAt;
        
        // Calculate days since article date
        let daysAgo = 365;
        if (articleDate) {
            try {
                const articleDateTime = new Date(articleDate);
                const now = new Date();
                const diffTime = Math.abs(now.getTime() - articleDateTime.getTime());
                daysAgo = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            } catch {
                daysAgo = 365;
            }
        }
        
        let recencyScore = 0;
        if (daysAgo === 0) recencyScore = 20;
        else if (daysAgo === 1) recencyScore = 15;
        else if (daysAgo === 2) recencyScore = 10;
        else if (daysAgo <= 7) recencyScore = 8;
        else if (daysAgo <= 30) recencyScore = 5;
        else recencyScore = 2;
        
        let stakesScore = 0;
        const playerCount = dfsPlayers.length;
        if (playerCount >= 10) stakesScore = 18;
        else if (playerCount >= 8) stakesScore = 15;
        else if (playerCount >= 5) stakesScore = 12;
        else if (playerCount >= 3) stakesScore = 8;
        else stakesScore = 5;
            
        let emotionScore = 0;
        if (playerCount > 0) {
            const avgConfidence = dfsPlayers.reduce((sum: number, p: any) => sum + (p.confidenceScore || 0), 0) / playerCount;
            if (avgConfidence >= 80) emotionScore = 18;
            else if (avgConfidence >= 70) emotionScore = 15;
            else if (avgConfidence >= 60) emotionScore = 12;
            else if (avgConfidence >= 50) emotionScore = 8;
            else emotionScore = 5;
        }
        
        const narrativeTypes = new Set(dfsPlayers.map((p: any) => p.narrativeType || '').filter(Boolean));
        let historyScore = 0;
        if (narrativeTypes.size >= 5) historyScore = 18;
        else if (narrativeTypes.size >= 4) historyScore = 15;
        else if (narrativeTypes.size >= 3) historyScore = 12;
        else if (narrativeTypes.size >= 2) historyScore = 8;
        else historyScore = 5;
        
        let paybackScore = 0;
        const paybackNarratives = dfsPlayers.filter((p: any) => {
            const type = (p.narrativeType || '').toLowerCase();
            return type.includes('revenge') || type.includes('motivation') || type.includes('homecoming');
        }).length;
        if (paybackNarratives >= 5) paybackScore = 18;
        else if (paybackNarratives >= 3) paybackScore = 15;
        else if (paybackNarratives >= 2) paybackScore = 12;
        else if (paybackNarratives >= 1) paybackScore = 8;
        else paybackScore = 5;
        
        const total = stakesScore + recencyScore + paybackScore + historyScore + emotionScore;
        
        return {
            total: Math.min(100, Math.max(0, total)),
            breakdown: {
                stakes: stakesScore,
                recency: recencyScore,
                payback: paybackScore,
                history: historyScore,
                emotion: emotionScore
            }
        };
    }
    
    if (!post.heatCheckData) {
        return {
            total: 0,
            breakdown: { stakes: 0, recency: 0, payback: 0, history: 0, emotion: 0 }
        };
    }
    
    const heatCheckData = post.heatCheckData as any;
    
    // Always calculate using V4 -> V3 -> fallback (no stored scores)
    // Check if V4 heat score calculation is available
    const matchPackV4 = heatCheckData.matchPackV4;
    if (matchPackV4?.factDrop?.raw?.advancedHeatStats) {
        try {
            const v4Result = calculateV4HeatScore(post as any);
            return {
                total: v4Result.heatScore,
                breakdown: {
                    stakes: Math.round(v4Result.pillars.controlStress.score * 0.2),
                    recency: Math.round(v4Result.pillars.emotionalLoad.components.availabilityShock.score * 0.2),
                    payback: Math.round(v4Result.pillars.emotionalLoad.components.revenge.score * 0.2),
                    history: Math.round(v4Result.pillars.emotionalLoad.components.history.score * 0.2),
                    emotion: Math.round(v4Result.pillars.emotionalLoad.score * 0.2)
                }
            };
        } catch (e) {
            // Fall through to V3 calculation if V4 fails
        }
    }
    
    const matchPackV3 = heatCheckData.matchPackV3;
    const factPack = heatCheckData.fact_pack || heatCheckData.factPack || {};
    const evidenceBundle = heatCheckData.evidence_bundle || heatCheckData.evidenceBundle || {};
    const narratives = heatCheckData.narratives || {};
    
    let baseScore = 0;
    let momentumScore = 0;
    let availabilityScore = 0;
    let closeGamesScore = 0;
    let comparisonsScore = 0;
    
    // If matchPackV3 exists, use Heat Picks signals (preferred method)
    if (matchPackV3?.factDrop) {
        const factDrop = matchPackV3.factDrop;
        const teamForm = factDrop.raw?.teamForm || {};
        const comparisons = factDrop.comparisons || [];
        const availability = factDrop.raw?.availability;
        
        // 1. MOMENTUM (0-25 points)
        const aMargin10 = teamForm.A?.margin10 || teamForm.A?.xgDiff10 || 0;
        const aMargin3 = teamForm.A?.margin3 || teamForm.A?.xgDiff3 || 0;
        const bMargin10 = teamForm.B?.margin10 || teamForm.B?.xgDiff10 || 0;
        const bMargin3 = teamForm.B?.margin3 || teamForm.B?.xgDiff3 || 0;
        const momentumDivergence = Math.abs((aMargin3 - aMargin10) - (bMargin3 - bMargin10));
        momentumScore = Math.min(25, momentumDivergence * 2.5);
        
        // 2. AVAILABILITY (0-20 points)
        if (availability?.majorAbsences) {
            const aAbsences = availability.majorAbsences.A?.count || 0;
            const bAbsences = availability.majorAbsences.B?.count || 0;
            const availabilityDiff = Math.abs(aAbsences - bAbsences);
            availabilityScore = Math.min(20, availabilityDiff * 4);
        }
        
        // 3. CLOSE GAMES (0-20 points)
        const closeMarginComp = comparisons.find((c: any) => c?.key === 'closeMargin');
        if (closeMarginComp) {
            const aCloseW = teamForm.A?.closeW10 || 0;
            const aCloseL = teamForm.A?.closeL10 || 0;
            const bCloseW = teamForm.B?.closeW10 || 0;
            const bCloseL = teamForm.B?.closeL10 || 0;
            const aCloseRate = aCloseW + aCloseL > 0 ? aCloseW / (aCloseW + aCloseL) : 0;
            const bCloseRate = bCloseW + bCloseL > 0 ? bCloseW / (bCloseW + bCloseL) : 0;
            const closeGameDiff = Math.abs(aCloseRate - bCloseRate);
            closeGamesScore = Math.min(20, closeGameDiff * 40);
        }
        
        // 4. COMPARISONS (0-15 points)
        let comparisonsTotal = 0;
        comparisons.forEach((comp: any) => {
            if (comp?.key && comp.key !== 'closeMargin') {
                const aVal = comp.A || 0;
                const bVal = comp.B || 0;
                const diff = Math.abs(aVal - bVal);
                if (diff > 0.1) {
                    comparisonsTotal += Math.min(3, diff * 1.5);
                }
            }
        });
        comparisonsScore = Math.min(15, comparisonsTotal);
    } else {
        // Fallback: Use legacy factPack data if matchPackV3 not available
        const odds = factPack.odds || {};
        const markets = odds.markets || [];
        const spreadMarket = markets.find((m: any) => m.market === 'Spread');
        
        if (spreadMarket && typeof spreadMarket.point === 'number') {
            const spread = Math.abs(spreadMarket.point);
            if (spread <= 3) momentumScore = 22;
            else if (spread <= 6) momentumScore = 18;
            else if (spread <= 10) momentumScore = 15;
            else momentumScore = 12;
        } else {
            momentumScore = 15;
        }
    }
    
    baseScore = momentumScore + availabilityScore + closeGamesScore + comparisonsScore;
    
    // NARRATIVE STRENGTH (0-35 points)
    let narrativeScore = 0;
    if (narratives?.candidate_cards && narratives.candidate_cards.length > 0) {
        const primaryNarrativeId = narratives.selected?.primary_narrative_id;
        const primaryCard = narratives.candidate_cards.find(
            (c: any) => c.narrative_id === primaryNarrativeId
        );
        
        if (primaryCard) {
            if (primaryCard.total_score !== undefined) {
                narrativeScore += Math.min(20, (primaryCard.total_score / 35) * 20);
            } else {
                const breakdown = primaryCard.score_breakdown || {};
                const breakdownScore = (breakdown.factual_support || 0) + 
                                      (breakdown.stakes || 0) + 
                                      (breakdown.performance_alignment || 0);
                narrativeScore += Math.min(20, (breakdownScore / 20) * 20);
            }
        }
        
        const secondaryIds = narratives.selected?.secondary_narrative_ids || [];
        if (secondaryIds.length >= 2) narrativeScore += 8;
        else if (secondaryIds.length === 1) narrativeScore += 4;
        
        const allEmotionTags = narratives.candidate_cards
            .flatMap((c: any) => c.emotion_tags || []);
        const uniqueEmotionTags = [...new Set(allEmotionTags)];
        if (uniqueEmotionTags.length >= 4) narrativeScore += 7;
        else if (uniqueEmotionTags.length >= 3) narrativeScore += 5;
        else if (uniqueEmotionTags.length >= 2) narrativeScore += 2;
    }
    
    narrativeScore = Math.min(35, Math.round(narrativeScore));
    
    // EVIDENCE QUALITY (0-23 points)
    let evidenceScore = 0;
    const quotes = evidenceBundle.quotes || [];
    const timelineEvents = evidenceBundle.timeline_events || [];
    
    if (quotes.length >= 5) evidenceScore += 12;
    else if (quotes.length >= 3) evidenceScore += 9;
    else if (quotes.length >= 2) evidenceScore += 6;
    else if (quotes.length === 1) evidenceScore += 3;
    
    if (timelineEvents.length >= 5) evidenceScore += 6;
    else if (timelineEvents.length >= 3) evidenceScore += 5;
    else if (timelineEvents.length >= 2) evidenceScore += 3;
    else if (timelineEvents.length === 1) evidenceScore += 2;
    
    const now = new Date();
    const recentQuotes = quotes.filter((q: any) => {
        if (!q || !q.date_utc) return false;
        try {
            const quoteDate = new Date(q.date_utc);
            const daysAgo = Math.floor((now.getTime() - quoteDate.getTime()) / (1000 * 60 * 60 * 24));
            return daysAgo <= 30;
        } catch {
            return false;
        }
    });
    if (recentQuotes.length >= 3) evidenceScore += 5;
    else if (recentQuotes.length >= 2) evidenceScore += 3;
    else if (recentQuotes.length >= 1) evidenceScore += 2;
    
    evidenceScore = Math.min(23, evidenceScore);
    
    // Total score with base temperature: 40 = baseline
    const baseTemperature = 40;
    const rawTotal = baseTemperature + baseScore + narrativeScore + evidenceScore;
    const total = Math.round(Math.min(100, Math.max(40, rawTotal)));
    
    // Map to legacy breakdown format
    const stakes = Math.round((momentumScore + closeGamesScore) / 2);
    const recency = Math.round(evidenceScore * 0.8);
    const payback = Math.round(narrativeScore * 0.3);
    const history = Math.round(comparisonsScore + (narrativeScore * 0.2));
    const emotion = Math.round((narrativeScore * 0.5) + (evidenceScore * 0.2));
    
    return {
        total: Math.min(100, Math.max(0, total)),
        breakdown: {
            stakes: Math.min(20, stakes),
            recency: Math.min(20, recency),
            payback: Math.min(20, payback),
            history: Math.min(20, history),
            emotion: Math.min(20, emotion)
        }
    };
}

/**
 * Generate article page HTML
 */
export function generateArticlePage(
    post: HeatcheckPost,
    relatedPosts: HeatcheckPost[],
    baseUrl: string = 'https://heatchecks.io'
): string {
    const league = normalizeLeague(post.league);
    const date = post.matchupScheduledDate 
        ? formatDateISO(post.matchupScheduledDate)
        : formatDateISO(post.createdAt);
    
    // Extract heatCheckData first
    const heatCheckData = post.heatCheckData || {};
    const narratives = heatCheckData.narratives || {};
    const candidateCards = narratives.candidate_cards || [];
    const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
    
    // Get narrative keywords from emotion tags
    const activeCard = candidateCards.find(card => card.narrative_id === primaryNarrativeId);
    const emotionTags = activeCard?.emotion_tags || [];
    
    // Extract narrative keyword for use in alt text and meta description
    const narrativeKeyword = emotionTags.length > 0 
        ? emotionTags[0].toLowerCase().replace(/\s+/g, '-')
        : extractNarrativeKeywords(post.websiteStory.headline, emotionTags);
    
    // Check if SEO slug is in prediction format (new SEO-optimized format)
    const storedSlug = post.websiteStory.seo?.slug || '';
    const isPredictionFormat = storedSlug.includes('-prediction-preview-') && storedSlug.match(/\d{4}-\d{2}-\d{2}$/);
    
    let articleUrl: string;
    let canonicalUrl: string;
    
    if (isPredictionFormat) {
        // Use prediction format: /{league}/{prediction-slug}/
        articleUrl = `${baseUrl}/${league}/${storedSlug}/`;
        canonicalUrl = `${baseUrl}/${league}/${storedSlug}/`;
    } else {
        // Fallback to old format: /{league}/{date}/{matchup}/{narrative-slug}/
        // Generate matchup slug: teamA-vs-teamB
        const matchupSlug = generateMatchupSlug(post.teamA || '', post.teamB || '', getShortTeamName);
        
        // Generate narrative-based slug
        const narrativeSlug = generateNarrativeSlug(
            post.websiteStory.headline,
            post.teamA || '',
            post.teamB || '',
            emotionTags
        );
        
        articleUrl = `${baseUrl}/${league}/${date}/${matchupSlug}/${narrativeSlug}/`;
        canonicalUrl = articleUrl; // Use same URL as canonical for old format
    }
    const evidenceBundle = heatCheckData.evidenceBundle || heatCheckData.evidence_bundle || {};
    const quotes = evidenceBundle.quotes || [];
    const timelineEvents = evidenceBundle.timeline_events || [];
    
    // Generate filler quote if no quotes found
    const todayDate = formatDateISO(new Date().toISOString());
    const isToday = date === todayDate;
    const displayQuotes = quotes.length > 0 ? quotes : [{
        quote: `${post.teamA} and ${post.teamB} meet ${isToday ? 'tonight' : 'in a seasonal matchup'} in ${post.league.toUpperCase()}.`,
        speaker: 'Matchup Preview',
        team: undefined
    }];
    
    // Get article content (prefer long_form_markdown from heatCheckData, fallback to theBackstory)
    const articleContent = heatCheckData.article?.long_form_markdown || post.websiteStory.theBackstory || '';
    let htmlContent = markdownToHtml(articleContent);
    
    // Note: QUOTE/STAT anchors are now rendered as HTML directly in renderHeatArticleV3Markdown()
    // They are wrapped in HTML_BLOCK markers, so markdownToHtml preserves them correctly
    // This eliminates the need for regex workarounds to fix nesting issues
    
    // Fix escaped headings that appear inside paragraph divs anywhere
    htmlContent = htmlContent.replace(
        /<div style="margin-top: 0\.5rem;">\s*&lt;div style=&quot;color: #ff8000[^&]*&quot;&gt;([^&]+)&lt;\/div&gt;\s*<\/div>/g,
        (match, headingText) => {
            const cleanHeading = headingText.trim();
            return '<div style="color: #ff8000; font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.75rem; font-weight: bold;">' + escapeHtml(cleanHeading) + '</div>';
        }
    );
    
    // Fix any other escaped heading HTML that appears as text
    htmlContent = htmlContent.replace(
        /&lt;div style=&quot;color: #ff8000[^&]*&quot;&gt;([^&]+)&lt;\/div&gt;/g,
        (match, headingText) => {
            const cleanHeading = headingText.trim();
            return '<div style="color: #ff8000; font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.75rem; font-weight: bold;">' + escapeHtml(cleanHeading) + '</div>';
        }
    );
    
    // Get image path - use relative path for local development
    const imageName = post.websiteStory.image || post.websiteStory.imageUrl || '';
    const imagePath = imageName 
        ? (imageName.startsWith('http') 
            ? imageName 
            : imageName.startsWith('/')
            ? imageName
            : imageName.includes('/assets/images/')
            ? (() => {
                // Extract filename from full path like "/assets/images/filename.png"
                const parts = imageName.split('/assets/images/');
                const filename = parts.length > 1 ? parts[parts.length - 1] : imageName.split('/').pop();
                return `/assets/images/${filename}`;
            })()
            : `/assets/images/${imageName}`)
        : '';
    
    // Debug logging (can remove later)
    if (imageName) {
        console.log(`[Article Template] Image for "${post.websiteStory.headline}":`, {
            rawImage: imageName,
            finalPath: imagePath
        });
    }
    
    // Generate narrative cards HTML
    const narrativeCardsHtml = candidateCards.map(card => {
        const isActive = card.narrative_id === primaryNarrativeId;
        const tagsHtml = (card.emotion_tags || []).map(tag => 
            `<span style="color: rgba(248, 66, 66, 0.9); margin-left: 0.25rem; padding: 0.15rem 0.35rem; background: rgba(248, 66, 66, 0.15); border: 1px solid rgba(248, 66, 66, 0.3); border-radius: 3px; font-family: 'Courier New', monospace; text-transform: lowercase;">${escapeHtml(tag)}</span>`
        ).join('');
        
        return `
            <div style="padding: 0.75rem; background: ${isActive ? 'rgba(0, 255, 65, 0.1)' : 'rgba(0, 20, 10, 0.3)'}; border: 1px solid ${isActive ? 'rgba(0, 255, 65, 0.5)' : 'rgba(0, 255, 65, 0.2)'}; border-left: 3px solid ${isActive ? 'rgba(0, 255, 65, 0.8)' : 'rgba(0, 255, 65, 0.3)'}; font-family: 'Courier New', monospace; font-size: 0.8rem;">
                <div style="margin-bottom: 0.5rem; color: ${isActive ? 'rgba(255, 255, 255, 0.95)' : 'rgba(255, 255, 255, 0.7)'}; font-size: 0.85rem; font-weight: bold; text-transform: uppercase;">
                    ${isActive ? '&gt; [ACTIVE]' : '&gt;'} ${escapeHtml(card.title)}
                </div>
                <div style="font-size: 0.75rem; color: #aaa; margin-bottom: 0.5rem; line-height: 1.5;">
                    ${escapeHtml(card.claim)}
                </div>
                <div style="font-size: 0.7rem; color: #666; border-top: 1px dashed #333; padding-top: 0.5rem; margin-top: 0.5rem;">
                    SCORE: ${card.total_score || 0}/35 | TAGS: ${tagsHtml}
                </div>
            </div>`;
    }).join('');

    // Temperature Check (HeatArticleV3/V4): sits above Narrative.log (Narrative Rack)
    // V4 articles use matchPackV4 but have the same structure as V3 (V4 extends V3)
    const matchPackV4: any = (heatCheckData as any).matchPackV4;
    const matchPackV3: any = (heatCheckData as any).matchPackV3;
    // Use V4 if available, fallback to V3
    const matchPack: any = matchPackV4 || matchPackV3;
    const tempCheck: any = (heatCheckData as any).temperatureCheck;
    const tempSummary: any = tempCheck?.summary || null;
    const tempAI: any = tempCheck?.ai || null;
    
    // Calculate unified heat score for TEMP log (all data is available here)
    const heatScoreResult = calculateHeatScoreFromMatchupData(post);
    const unifiedHeatScore = heatScoreResult.total;
    const heatScoreTier = getHeatScoreTier(unifiedHeatScore);
    
    // Check if edge exists for button display
    const hasEdge = post.heatchecksEdge && (
        (typeof post.heatchecksEdge === 'object' && 'game' in post.heatchecksEdge && 'player_props' in post.heatchecksEdge) ||
        (typeof post.heatchecksEdge === 'object' && 'finalCall' in post.heatchecksEdge)
    );

    const temperatureCheckHtml = matchPack ? (() => {
        const renderedOverride = typeof tempCheck?.renderedMarkdown === 'string' && tempCheck.renderedMarkdown.trim()
            ? tempCheck.renderedMarkdown.trim()
            : null;

        const bullets: any[] = Array.isArray(matchPack?.factDrop?.bullets) ? matchPack.factDrop.bullets : [];
        const comparisons: any[] = Array.isArray(matchPack?.factDrop?.comparisons) ? matchPack.factDrop.comparisons : [];
        const sections: any[] = Array.isArray(matchPack?.factDrop?.sections) ? matchPack.factDrop.sections : [];
        const charts: any = matchPack?.factDrop?.charts || null;

        const visibleKeys: string[] = Array.isArray(tempSummary?.visibleBulletKeys) && tempSummary.visibleBulletKeys.length > 0
            ? tempSummary.visibleBulletKeys
            : bullets.map(b => b?.key).filter(Boolean);

        const visibleBullets = bullets.filter(b => visibleKeys.includes(b?.key)).map(b => ({
            key: b?.key,
            label: b.label || b.key || 'BULLET',
            display: b.display || '',
            raw: (b as any)?.raw
        }));

        const getWinner = (key: string, raw: any): 'A' | 'B' | 'even' | null => {
            try {
                if (!raw) return null;
                const k = String(key || '').toLowerCase();
                const num = (v: any) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));
                const isFiniteNum = (v: any) => typeof v === 'number' && Number.isFinite(v);

                if (k === 'last10') {
                    // Check margin (basketball) or xgDiff (soccer) first
                    const aM = num(raw?.A?.margin10) || num(raw?.A?.xgDiff10);
                    const bM = num(raw?.B?.margin10) || num(raw?.B?.xgDiff10);
                    if (isFiniteNum(aM) && isFiniteNum(bM) && aM !== bM) return aM > bM ? 'A' : 'B';
                    // Fall back to wins
                    const aW = num(raw?.A?.w10);
                    const bW = num(raw?.B?.w10);
                    if (isFiniteNum(aW) && isFiniteNum(bW) && aW !== bW) return aW > bW ? 'A' : 'B';
                    return 'even';
                }

                if (k === 'last3') {
                    // Check margin (basketball) or xgDiff (soccer) first
                    const aM = num(raw?.A?.margin3) || num(raw?.A?.xgDiff3);
                    const bM = num(raw?.B?.margin3) || num(raw?.B?.xgDiff3);
                    if (isFiniteNum(aM) && isFiniteNum(bM) && aM !== bM) return aM > bM ? 'A' : 'B';
                    // Fall back to wins
                    const aW = num(raw?.A?.w3);
                    const bW = num(raw?.B?.w3);
                    if (isFiniteNum(aW) && isFiniteNum(bW) && aW !== bW) return aW > bW ? 'A' : 'B';
                    return 'even';
                }

                if (k === 'momentum') {
                    const a = num(raw?.A);
                    const b = num(raw?.B);
                    if (isFiniteNum(a) && isFiniteNum(b) && a !== b) return a > b ? 'A' : 'B';
                    return 'even';
                }

                if (k === 'closegames') {
                    const aW = num(raw?.A?.closeW10);
                    const bW = num(raw?.B?.closeW10);
                    if (isFiniteNum(aW) && isFiniteNum(bW) && aW !== bW) return aW > bW ? 'A' : 'B';
                    const aL = num(raw?.A?.closeL10);
                    const bL = num(raw?.B?.closeL10);
                    if (isFiniteNum(aL) && isFiniteNum(bL) && aL !== bL) return aL < bL ? 'A' : 'B';
                    return 'even';
                }

                if (k === 'standings') {
                    // Check rank (basketball) or position (soccer) first
                    const aR = num(raw?.A?.rank) || num(raw?.A?.position);
                    const bR = num(raw?.B?.rank) || num(raw?.B?.position);
                    if (isFiniteNum(aR) && isFiniteNum(bR) && aR !== bR) return aR < bR ? 'A' : 'B';
                    // Fall back to points (soccer) or wins (basketball)
                    const aP = num(raw?.A?.points) || num(raw?.A?.wins);
                    const bP = num(raw?.B?.points) || num(raw?.B?.wins);
                    if (isFiniteNum(aP) && isFiniteNum(bP) && aP !== bP) return aP > bP ? 'A' : 'B';
                    return 'even';
                }

                return null;
            } catch {
                return null;
            }
        };

        const renderWinnerSplit = (b: any) => {
            const winner = getWinner(String(b?.key || ''), b?.raw);
            const disp = String(b?.display || '');
            const parts = disp.split(' | ');
            if (parts.length < 2 || !winner) return escapeHtml(disp);

            const left = escapeHtml(parts[0]);
            const right = escapeHtml(parts.slice(1).join(' | '));

            const base = 'padding:0.22rem 0.35rem; border-radius:8px; border:1px solid rgba(0,255,65,0.20);';
            const win = 'background:rgba(0,255,65,0.10); border:1px solid rgba(0,255,65,0.28); color:rgba(255,255,255,0.92); font-weight:900; box-shadow:0 0 12px rgba(0,255,65,0.10);';
            const lose = 'background:transparent; border:1px solid rgba(0,255,65,0.15); color:rgba(255,255,255,0.72); font-weight:700;';
            const even = 'background:rgba(0,255,65,0.05); border:1px solid rgba(0,255,65,0.20); color:rgba(255,255,255,0.80); font-weight:800;';

            const leftStyle = base + (winner === 'A' ? win : winner === 'B' ? lose : even);
            const rightStyle = base + (winner === 'B' ? win : winner === 'A' ? lose : even);

            return `<span style="display:inline-flex; gap:0.35rem; flex-wrap:wrap; align-items:center;"><span style="${leftStyle}">${left}</span><span style="color:rgba(255,255,255,0.35); font-weight:900;">|</span><span style="${rightStyle}">${right}</span></span>`;
        };

        const highlightComparisonKey = tempSummary?.highlightComparisonKey || 'margin10';
        const highlightComparison = comparisons.find(c => c?.key === highlightComparisonKey) || comparisons[0] || null;

        const availability = matchPack?.factDrop?.raw?.availability?.majorAbsences || null;
        const availabilityCounts = availability ? {
            A: availability?.A?.count ?? 0,
            B: availability?.B?.count ?? 0
        } : null;

        const formLeaders = sections.find(s => s?.key === 'formLeaders') || null;
        const priorityPlayers = Array.isArray(tempSummary?.priorityPlayersOverride) && tempSummary.priorityPlayersOverride.length > 0
            ? tempSummary.priorityPlayersOverride
            : (Array.isArray(formLeaders?.priorityPlayers) ? formLeaders.priorityPlayers.map((p: any) => p.displayText || '').filter(Boolean) : []);

        const availabilityOverride = typeof tempSummary?.availabilityDisplayOverride === 'string' && tempSummary.availabilityDisplayOverride.trim()
            ? tempSummary.availabilityDisplayOverride.trim()
            : null;

        const aiTakeaways = Array.isArray(tempAI?.takeaways) ? tempAI.takeaways : [];
        const aiRisks = Array.isArray(tempAI?.risks) ? tempAI.risks : [];

        const buildDefaultMarkdown = () => {
            const lines: string[] = [];
            // Use unified heat score tier instead of AI tempScore
            const label = heatScoreTier; // COOL, WARM, HOT, or SCORCHING
            // Only show button if edge section exists (hasEdge is from outer scope)
            const buttonHtml = hasEdge ? `<button onclick="document.getElementById('heatchecks-edge-section')?.scrollIntoView({behavior: 'smooth', block: 'start'}); return false;" style="margin-left: 0.75rem; padding: 0.3rem 0.6rem; background: rgba(255, 255, 255, 0.15); border: 1px solid rgba(255, 255, 255, 0.4); color: rgba(255, 255, 255, 0.95); font-family: 'Courier New', monospace; font-size: 0.7rem; font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; cursor: pointer; transition: all 0.2s ease; border-radius: 3px; white-space: nowrap;" onmouseover="this.style.background='rgba(255,255,255,0.25)'; this.style.borderColor='rgba(255,255,255,0.6)'; this.style.color='#fff';" onmouseout="this.style.background='rgba(255,255,255,0.15)'; this.style.borderColor='rgba(255,255,255,0.4)'; this.style.color='rgba(255,255,255,0.95)';">See Prediction</button>` : '';
            lines.push(`<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; color:rgba(255,255,255,0.78); font-family:'Courier New', monospace; font-size:0.8rem; letter-spacing:0.08em;"><span>TEMP: <span style="color:#00ff41; font-weight:900; text-shadow:0 0 10px rgba(0,255,65,0.25);">${escapeHtml(label)}</span></span>${buttonHtml}</div>`);
            const teamA = String(matchPack?.matchup?.teamA || matchPack?.matchup?.teamAAbbr || 'Team A');
            const teamB = String(matchPack?.matchup?.teamB || matchPack?.matchup?.teamBAbbr || 'Team B');
            const haA = String(matchPack?.matchup?.homeAway?.A || '');
            const haB = String(matchPack?.matchup?.homeAway?.B || '');
            if (haA || haB) {
                lines.push(`<div style="margin-top:0.15rem; color:rgba(255,255,255,0.72); font-family:'Courier New', monospace; font-size:0.78rem;">HOME/AWAY: <span style="color:rgba(255,255,255,0.9); font-weight:700;">${escapeHtml(teamA)}</span> (${escapeHtml(haA || 'n/a')}) | <span style="color:rgba(255,255,255,0.9); font-weight:700;">${escapeHtml(teamB)}</span> (${escapeHtml(haB || 'n/a')})</div>`);
            }
            if (availabilityOverride) {
                lines.push(`<div style="margin-top:0.35rem; padding:0.45rem 0.55rem; background:rgba(0,0,0,0.25); border:1px solid rgba(0,255,65,0.18); border-left:2px solid rgba(0,255,65,0.45); border-radius:8px; color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.78rem;"><span style="color:#00ff41; font-weight:900; letter-spacing:0.1em;">AVAIL</span> ${escapeHtml(availabilityOverride)}</div>`);
            }
            if (visibleBullets.length > 0) {
                lines.push(`<div style="margin-top:0.55rem; color:#00ff41; font-weight:900; letter-spacing:0.14em; font-family:'Courier New', monospace; font-size:0.75rem; text-transform:uppercase;">FACTDROP</div>`);
                lines.push(`<div style="margin-top:0.25rem; display:flex; flex-direction:column; gap:0.25rem;">${visibleBullets.map(b => `
                    <div style="padding:0.35rem 0.45rem; background:rgba(0,0,0,0.18); border:1px solid rgba(0,255,65,0.14); border-radius:8px;">
                        <div style="color:rgba(255,255,255,0.9); font-weight:800; font-family:'Courier New', monospace; font-size:0.78rem;">${escapeHtml(b.label)}:</div>
                        <div style="margin-top:0.12rem; color:rgba(255,255,255,0.76); font-family:'Courier New', monospace; font-size:0.78rem; line-height:1.35;">${renderWinnerSplit(b)}</div>
                    </div>
                `).join('')}</div>`);
            }
            if (highlightComparison) {
                const metric = escapeHtml(String(highlightComparison.metric || highlightComparison.key || 'comparison'));
                const aDisp = escapeHtml(String(highlightComparison.display?.A || String(highlightComparison.A || '')));
                const bDisp = escapeHtml(String(highlightComparison.display?.B || String(highlightComparison.B || '')));
                const winnerRaw = String(highlightComparison.winner || 'even');
                
                // Get team names - prefer matchPackV3 data, fallback to post data
                const teamAName = getShortTeamName(matchPack?.matchup?.teamA || post.teamA || 'Team A');
                const teamBName = getShortTeamName(matchPack?.matchup?.teamB || post.teamB || 'Team B');
                
                // Map winner to team name
                let winnerDisplay = winnerRaw;
                if (winnerRaw === 'A') {
                    winnerDisplay = teamAName;
                } else if (winnerRaw === 'B') {
                    winnerDisplay = teamBName;
                } else {
                    winnerDisplay = escapeHtml(winnerRaw);
                }
                
                lines.push(`<div style="margin-top:0.55rem; color:#00ff41; font-weight:900; letter-spacing:0.14em; font-family:'Courier New', monospace; font-size:0.75rem; text-transform:uppercase;">KEY_COMP</div>`);
                lines.push(`<div style="margin-top:0.2rem; padding:0.45rem 0.55rem; background:rgba(0,0,0,0.22); border:1px solid rgba(0,255,65,0.16); border-radius:10px; color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.78rem;">${metric}: ${escapeHtml(teamAName)}=${aDisp} | ${escapeHtml(teamBName)}=${bDisp} <span style="color:rgba(255,255,255,0.6);">(winner: ${winnerDisplay})</span></div>`);
            }

            // Replace "AI takeaways/risks" with a human-first impact block
            const hook = (aiTakeaways.find((t: string) => t && t.trim().length <= 130) || '').trim();
            const watchFor = (aiRisks.find((r: string) => r && r.trim().length <= 140) || '').trim();

            lines.push(`<div style="margin-top:0.65rem; color:#00ff41; font-weight:900; letter-spacing:0.14em; font-family:'Courier New', monospace; font-size:0.75rem; text-transform:uppercase;">IMPACT</div>`);
            if (hook) {
                lines.push(`<div style="margin-top:0.2rem; color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.8rem; line-height:1.35;">${escapeHtml(hook)}</div>`);
            }
            if (highlightComparison) {
                const metric = (highlightComparison.metric || highlightComparison.key || 'edge');
                const aDisp = highlightComparison.display?.A || String(highlightComparison.A || '');
                const bDisp = highlightComparison.display?.B || String(highlightComparison.B || '');
                const winner =
                    highlightComparison.winner === 'A' ? teamA :
                    highlightComparison.winner === 'B' ? teamB : 'Neither side';
                lines.push(`<div style="margin-top:0.25rem; color:rgba(255,255,255,0.78); font-family:'Courier New', monospace; font-size:0.78rem;">EDGE: <span style="color:rgba(255,255,255,0.92); font-weight:800;">${escapeHtml(winner)}</span> ${escapeHtml(metric)} (${escapeHtml(aDisp)} vs ${escapeHtml(bDisp)})</div>`);
            }

            const swing =
                availabilityOverride ||
                ((availabilityCounts && (availabilityCounts.A > 0 || availabilityCounts.B > 0))
                    ? 'Availability is the swing—late scratches can flip the entire script.'
                    : 'Health looks stable—this swings on execution and shot-making.');
            lines.push(`<div style="margin-top:0.25rem; color:rgba(255,255,255,0.78); font-family:'Courier New', monospace; font-size:0.78rem;">SWING: ${escapeHtml(swing)}</div>`);

            if (watchFor) {
                lines.push(`<div style="margin-top:0.25rem; color:rgba(255,255,255,0.7); font-family:'Courier New', monospace; font-size:0.78rem;">WATCH: ${escapeHtml(watchFor)}</div>`);
            }
            return lines.join('');
        };

        const finalMarkdown = renderedOverride || buildDefaultMarkdown();
        // IMPORTANT:
        // - buildDefaultMarkdown() returns styled HTML blocks already.
        // - renderedOverride is often ALSO pre-rendered HTML (we store it that way for V3).
        // Passing HTML through markdownToHtml() can introduce <br/> whitespace between tags,
        // which creates the "dead space" you're seeing in FACTDROP cards.
        const renderedOverrideLooksHtml =
            !!renderedOverride && /<\s*(div|section|span|canvas|table|p|ul|ol|h[1-6]|br)\b/i.test(renderedOverride);
        
        // If there's a rendered override, replace the TEMP line with unified heat score tier
        let processedRenderedOverride = renderedOverride;
        if (renderedOverride) {
            // Replace TEMP line in rendered markdown with unified heat score tier
            // Match both formats: TEMP: <span>...</span> and TEMP: <span style="...">...</span>
            const tempLineRegex = /<div[^>]*>TEMP:\s*<span[^>]*>([^<]*)<\/span>[^<]*<\/div>/i;
            const newTempLine = `<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; color:rgba(255,255,255,0.78); font-family:'Courier New', monospace; font-size:0.8rem; letter-spacing:0.08em;"><span>TEMP: <span style="color:#00ff41; font-weight:900; text-shadow:0 0 10px rgba(0,255,65,0.25);">${escapeHtml(heatScoreTier)}</span></span>${hasEdge ? `<button onclick="document.getElementById('heatchecks-edge-section')?.scrollIntoView({behavior: 'smooth', block: 'start'}); return false;" style="margin-left: 0.75rem; padding: 0.3rem 0.6rem; background: rgba(255, 255, 255, 0.15); border: 1px solid rgba(255, 255, 255, 0.4); color: rgba(255, 255, 255, 0.95); font-family: 'Courier New', monospace; font-size: 0.7rem; font-weight: bold; text-transform: uppercase; letter-spacing: 0.08em; cursor: pointer; transition: all 0.2s ease; border-radius: 3px; white-space: nowrap;" onmouseover="this.style.background='rgba(255,255,255,0.25)'; this.style.borderColor='rgba(255,255,255,0.6)'; this.style.color='#fff';" onmouseout="this.style.background='rgba(255,255,255,0.15)'; this.style.borderColor='rgba(255,255,255,0.4)'; this.style.color='rgba(255,255,255,0.95)';">See Prediction</button>` : ''}</div>`;
            processedRenderedOverride = renderedOverride.replace(tempLineRegex, newTempLine);
        }
        
        const finalContentHtml = processedRenderedOverride
            ? (renderedOverrideLooksHtml ? processedRenderedOverride : markdownToHtml(processedRenderedOverride))
            : finalMarkdown;

        const chartsDataId = `v3-charts-data-${post.id}`;
        const momentumCanvasId = `v3-chart-momentum-${post.id}`;
        const starLoadCanvasId = `v3-chart-starload-${post.id}`;
        const pressureCanvasId = `v3-chart-pressure-${post.id}`;
        const volatilityCanvasId = `v3-chart-volatility-${post.id}`;

        const hasCharts =
            charts &&
            (charts?.momentumLine || charts?.starLoad || charts?.pressureBar || charts?.roleVolatility);

        const momentumLegendA = String(charts?.momentumLine?.series?.A?.label || matchPack?.matchup?.teamAAbbr || 'A');
        const momentumLegendB = String(charts?.momentumLine?.series?.B?.label || matchPack?.matchup?.teamBAbbr || 'B');

        const chartsJson = (() => {
            try {
                return JSON.stringify(charts || {}).replace(/</g, '\\u003c');
            } catch {
                return '{}';
            }
        })();

        const chartsHtml = hasCharts ? `
            <div style="margin-top:0.75rem;">
                <div style="color:#00ff41; font-weight:900; letter-spacing:0.14em; font-family:'Courier New', monospace; font-size:0.75rem; text-transform:uppercase;">CHARTS</div>

                <div style="margin-top:0.35rem; display:flex; flex-direction:column; gap:0.5rem;">
                    <div style="padding:0.55rem; background:rgba(0, 8, 4, 0.88); border:1px solid rgba(0, 255, 65, 0.18); border-radius:10px;">
                        <div style="color:rgba(255,255,255,0.86); font-family:'Courier New', monospace; font-size:0.78rem; line-height:1.35;">
                            Rolling margin trend (last 12): who’s actually building momentum right now.
                        </div>
                        <div style="margin-top:0.35rem; display:flex; gap:0.75rem; align-items:center; flex-wrap:wrap; font-family:'Courier New', monospace; font-size:0.75rem; color:rgba(255,255,255,0.72);">
                            <div style="display:flex; align-items:center; gap:0.35rem;">
                                <span style="display:inline-block; width:10px; height:10px; border-radius:999px; background:rgba(255,26,26,0.95); box-shadow:0 0 10px rgba(255,26,26,0.18);"></span>
                                <span>${escapeHtml(momentumLegendA)}</span>
                            </div>
                            <div style="display:flex; align-items:center; gap:0.35rem;">
                                <span style="display:inline-block; width:10px; height:10px; border-radius:999px; background:rgba(255,230,109,0.95); box-shadow:0 0 10px rgba(255,230,109,0.12);"></span>
                                <span>${escapeHtml(momentumLegendB)}</span>
                            </div>
                        </div>
                        <div style="margin-top:0.35rem; height:170px;">
                            <canvas id="${momentumCanvasId}" style="width:100%; height:100%;"></canvas>
                        </div>
                        <div style="margin-top:0.25rem; color:rgba(255,255,255,0.70); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.35;">
                            Read it like a heartbeat: sustained above-zero stretches are real control; whiplash swings mean volatility.
                        </div>
                    </div>

                    <div style="padding:0.55rem; background:rgba(0, 8, 4, 0.88); border:1px solid rgba(0, 255, 65, 0.18); border-radius:10px;">
                        <div style="color:rgba(255,255,255,0.86); font-family:'Courier New', monospace; font-size:0.78rem; line-height:1.35;">
                            Usage vs minutes stress: which stars are carrying the load (and whose role is quietly spiking).
                        </div>
                        <div style="margin-top:0.35rem; height:200px;">
                            <canvas id="${starLoadCanvasId}" style="width:100%; height:100%;"></canvas>
                        </div>
                        <div style="margin-top:0.25rem; color:rgba(255,255,255,0.70); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.35;">
                            When MIN10 climbs with USG10, late-game decision volume rises—and so does the swing potential.
                        </div>
                    </div>

                    <div style="padding:0.55rem; background:rgba(0, 8, 4, 0.88); border:1px solid rgba(0, 255, 65, 0.18); border-radius:10px;">
                        <div style="color:rgba(255,255,255,0.86); font-family:'Courier New', monospace; font-size:0.78rem; line-height:1.35;">
                            Close-game record (≤ ${escapeHtml(String(matchPack?.factDrop?.charts?.pressureBar?.closeMargin ?? matchPack?.factDrop?.meta?.closeMargin ?? 6))}): who survives the pressure possessions.
                        </div>
                        <div style="margin-top:0.35rem; height:140px;">
                            <canvas id="${pressureCanvasId}" style="width:100%; height:100%;"></canvas>
                        </div>
                        <div style="margin-top:0.25rem; color:rgba(255,255,255,0.70); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.35;">
                            Tight-game reps matter: teams that win these tend to execute cleaner in the final two minutes.
                        </div>
                    </div>

                    <div style="padding:0.55rem; background:rgba(0, 8, 4, 0.88); border:1px solid rgba(0, 255, 65, 0.18); border-radius:10px;">
                        <div style="color:rgba(255,255,255,0.86); font-family:'Courier New', monospace; font-size:0.78rem; line-height:1.35;">
                            Role volatility (ΔUSG last 3 vs season): who’s being asked to do more (or less) right now.
                        </div>
                        <div style="margin-top:0.35rem; height:220px;">
                            <canvas id="${volatilityCanvasId}" style="width:100%; height:100%;"></canvas>
                        </div>
                        <div style="margin-top:0.25rem; color:rgba(255,255,255,0.70); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.35;">
                            Big positive spikes usually mean injuries or tactical shifts; big negatives often mean role compression or foul/rotation swings.
                        </div>
                    </div>
                </div>

                <script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js"></script>
                <script type="application/json" id="${chartsDataId}">${chartsJson}</script>
                <script>
                (function(){
                  var tries = 0;
                  function padFront(arr, len){
                    var a = Array.isArray(arr) ? arr.slice() : [];
                    while(a.length < len) a.unshift(null);
                    return a;
                  }
                  function buildLabels(len){
                    var out = [];
                    for (var i=0;i<len;i++) out.push('G' + (i+1));
                    return out;
                  }
                  function colorForVol(v){
                    if (typeof v !== 'number' || !isFinite(v)) return 'rgba(255,255,255,0.25)';
                    return v >= 0 ? 'rgba(255,26,26,0.85)' : 'rgba(255,230,109,0.80)';
                  }
                  function go(){
                    try {
                      var dataEl = document.getElementById('${chartsDataId}');
                      if (!dataEl) return;
                      var payload = JSON.parse(dataEl.textContent || '{}');
                      if (!payload || !window.Chart) {
                        if (tries++ < 60) return setTimeout(go, 50);
                        return;
                      }

                      var common = {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: { duration: 0 },
                        plugins: {
                          legend: { display: false },
                          tooltip: {
                            backgroundColor: 'rgba(0,0,0,0.92)',
                            borderColor: 'rgba(0,255,65,0.25)',
                            borderWidth: 1,
                            titleColor: 'rgba(255,255,255,0.92)',
                            bodyColor: 'rgba(255,255,255,0.85)'
                          }
                        },
                        scales: {
                          x: {
                            ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } },
                            grid: { color: 'rgba(255,255,255,0.08)' }
                          },
                          y: {
                            ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } },
                            grid: { color: function(ctx){ return ctx.tick && ctx.tick.value === 0 ? 'rgba(0,255,65,0.25)' : 'rgba(255,255,255,0.08)'; } }
                          }
                        }
                      };

                      // 1) Momentum line
                      var m = payload.momentumLine || null;
                      if (m && m.series) {
                        // Handle both NBA (margins) and soccer (xgDiff) data structures
                        var a = (m.series.A && (m.series.A.margins || m.series.A.xgDiff)) || [];
                        var b = (m.series.B && (m.series.B.margins || m.series.B.xgDiff)) || [];
                        var aLabel = (m.series.A && m.series.A.label) || 'A';
                        var bLabel = (m.series.B && m.series.B.label) || 'B';
                        var len = Math.max(a.length, b.length, 1);
                        var labels = buildLabels(len);
                        var ctx1 = document.getElementById('${momentumCanvasId}');
                        if (ctx1 && (a.length > 0 || b.length > 0)) {
                          new Chart(ctx1, {
                            type: 'line',
                            data: {
                              labels: labels,
                              datasets: [
                                { label: aLabel, data: padFront(a, len), borderColor: 'rgba(255,26,26,0.95)', backgroundColor: 'rgba(255,26,26,0.15)', tension: 0.25, pointRadius: 0, borderWidth: 2 },
                                { label: bLabel, data: padFront(b, len), borderColor: 'rgba(255,230,109,0.95)', backgroundColor: 'rgba(255,230,109,0.12)', tension: 0.25, pointRadius: 0, borderWidth: 2 }
                              ]
                            },
                            options: common
                          });
                        }
                      }

                      // 2) Star load (USG10 vs MIN10 for NBA, xG5 vs min5 for soccer)
                      var s = payload.starLoad || null;
                      var players = (s && Array.isArray(s.players)) ? s.players : [];
                      if (players.length > 0) {
                        // Handle both NBA (teamAbbr) and soccer (teamName) structures
                        var labels2 = players.map(function(p){
                          var ta = (p.teamAbbr || p.teamName || '').toString();
                          var nm = (p.playerName || '').toString();
                          return (ta ? (ta + ' ') : '') + nm;
                        });
                        // Handle both NBA (USG10/MIN10) and soccer (xG5/min5) field names
                        var usg = players.map(function(p){ 
                          var val = p.USG10 !== undefined ? p.USG10 : p.xG5;
                          return (typeof val === 'number' && isFinite(val)) ? val : null; 
                        });
                        var min = players.map(function(p){ 
                          var val = p.MIN10 !== undefined ? p.MIN10 : (p.MIN5 !== undefined ? p.MIN5 : p.min5);
                          return (typeof val === 'number' && isFinite(val)) ? val : null; 
                        });
                        var ctx2 = document.getElementById('${starLoadCanvasId}');
                        if (ctx2 && (usg.some(function(v){ return v !== null; }) || min.some(function(v){ return v !== null; }))) {
                          new Chart(ctx2, {
                            type: 'bar',
                            data: {
                              labels: labels2,
                              datasets: [
                                { label: 'USG10/xG5', data: usg, yAxisID: 'yUSG', backgroundColor: 'rgba(255,26,26,0.80)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1 },
                                { label: 'MIN10/MIN5', data: min, yAxisID: 'yMIN', backgroundColor: 'rgba(255,230,109,0.78)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1 }
                              ]
                            },
                            options: {
                              responsive: true,
                              maintainAspectRatio: false,
                              animation: { duration: 0 },
                              plugins: { legend: { display: false }, tooltip: common.plugins.tooltip },
                              scales: {
                                x: { ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                yUSG: { position: 'left', beginAtZero: true, ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                yMIN: { position: 'right', beginAtZero: true, ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { drawOnChartArea: false } }
                              }
                            }
                          });
                        }
                      }

                      // 3) Pressure bar (close-game record)
                      var p = payload.pressureBar || null;
                      if (p && p.A && p.B) {
                        var labels3 = [p.A.label || 'A', p.B.label || 'B'];
                        var wins = [p.A.wins || 0, p.B.wins || 0];
                        var losses = [p.A.losses || 0, p.B.losses || 0];
                        var ctx3 = document.getElementById('${pressureCanvasId}');
                        if (ctx3) {
                          new Chart(ctx3, {
                            type: 'bar',
                            data: {
                              labels: labels3,
                              datasets: [
                                { label: 'Wins', data: wins, backgroundColor: 'rgba(255,26,26,0.78)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1, stack: 's' },
                                { label: 'Losses', data: losses, backgroundColor: 'rgba(255,255,255,0.18)', borderColor: 'rgba(0,0,0,0.65)', borderWidth: 1, stack: 's' }
                              ]
                            },
                            options: {
                              indexAxis: 'y',
                              responsive: true,
                              maintainAspectRatio: false,
                              animation: { duration: 0 },
                              plugins: { legend: { display: false }, tooltip: common.plugins.tooltip },
                              scales: {
                                x: { stacked: true, beginAtZero: true, ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                y: { stacked: true, ticks: { color: 'rgba(255,255,255,0.70)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } }
                              }
                            }
                          });
                        }
                      }

                      // 4) Role volatility (ΔUSG3 vs season for NBA, xGChange for soccer)
                      var rv = payload.roleVolatility || null;
                      var rvPlayers = (rv && Array.isArray(rv.players)) ? rv.players : [];
                      if (rvPlayers.length > 0) {
                        // Handle both NBA (teamAbbr) and soccer (teamName) structures
                        var labels4 = rvPlayers.map(function(p){
                          var ta = (p.teamAbbr || p.teamName || '').toString();
                          var nm = (p.playerName || '').toString();
                          return (ta ? (ta + ' ') : '') + nm;
                        });
                        // Handle both NBA (deltaUSG3vsSeason) and soccer (xGChange) field names
                        var vals4 = rvPlayers.map(function(p){
                          var v = p.deltaUSG3vsSeason !== undefined ? p.deltaUSG3vsSeason : p.xGChange;
                          return (typeof v === 'number' && isFinite(v)) ? v : 0;
                        });
                        var maxAbs = 1;
                        for (var i=0;i<vals4.length;i++) maxAbs = Math.max(maxAbs, Math.abs(vals4[i] || 0));
                        var ctx4 = document.getElementById('${volatilityCanvasId}');
                        if (ctx4 && vals4.some(function(v){ return v !== 0; })) {
                          new Chart(ctx4, {
                            type: 'bar',
                            data: {
                              labels: labels4,
                              datasets: [
                                {
                                  label: 'ΔUSG3/ΔxG',
                                  data: vals4,
                                  backgroundColor: rvPlayers.map(function(p){ 
                                    var val = p.deltaUSG3vsSeason !== undefined ? p.deltaUSG3vsSeason : (p.xGChange || 0);
                                    return colorForVol(val); 
                                  }),
                                  borderColor: 'rgba(0,0,0,0.65)',
                                  borderWidth: 1
                                }
                              ]
                            },
                            options: {
                              indexAxis: 'y',
                              responsive: true,
                              maintainAspectRatio: false,
                              animation: { duration: 0 },
                              plugins: { legend: { display: false }, tooltip: common.plugins.tooltip },
                              scales: {
                                x: {
                                  suggestedMin: -maxAbs,
                                  suggestedMax: maxAbs,
                                  ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } },
                                  grid: { color: function(ctx){ return ctx.tick && ctx.tick.value === 0 ? 'rgba(0,255,65,0.25)' : 'rgba(255,255,255,0.08)'; } }
                                },
                                y: { ticks: { color: 'rgba(255,255,255,0.70)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } }
                              }
                            }
                          });
                        }
                      }
                    } catch (e) {
                      try { console.error('V3 charts init failed', e); } catch(_) {}
                    }
                  }
                  go();
                })();
                </script>
            </div>
        ` : '';

        return `
            <section aria-label="Temperature Check" id="temperature-check-section" style="flex: 0 0 auto; display: flex; flex-direction: column; background: rgba(0, 12, 6, 0.96); border: 2px solid rgba(0, 136, 51, 0.85); box-shadow: 0 0 18px rgba(0, 136, 51, 0.25), inset 0 0 14px rgba(0, 255, 65, 0.06); overflow-y: visible; overflow-x: hidden;">
                <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.15); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);"></div>
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; margin-left: 0.5rem; letter-spacing: 0.1em; font-weight: bold;">TEMPERATURE_CHECK.log</div>
                </div>
                <div style="position: relative; padding: 0.75rem; font-family: 'Courier New', monospace; font-size: 0.9rem; color: rgba(255, 255, 255, 0.88); line-height: 1.6; background: radial-gradient(circle at 60% 35%, rgba(0, 255, 65, 0.06) 0%, transparent 70%);">
                    <div style="position:absolute; inset:0; pointer-events:none; opacity:0.20; background-image: radial-gradient(circle at center, rgba(0, 255, 65, 0.16) 1px, transparent 1px), radial-gradient(circle at center, rgba(0, 255, 65, 0.08) 2px, transparent 2px); background-size: 52px 52px, 104px 104px; background-position:center;"></div>
                    <div style="position:absolute; inset:0; pointer-events:none; opacity:0.06; background: linear-gradient(180deg, rgba(0,255,65,0.0) 0%, rgba(0,255,65,0.12) 50%, rgba(0,255,65,0.0) 100%);"></div>
                    <div style="position:relative;">
                        ${finalContentHtml}
                        ${chartsHtml}
                    </div>
                </div>
            </section>
        `;
    })() : '';
    
    // Generate quotes HTML
    const quotesHtml = displayQuotes.map(quote => `
        <div style="padding: 0.6rem; margin-bottom: 0.5rem; background: rgba(0, 0, 0, 0.3); border-left: 2px solid rgba(255, 255, 255, 0.3); font-family: 'Courier New', monospace; font-size: 0.75rem;">
            <div style="color: #888; margin-bottom: 0.3rem; line-height: 1.4; font-style: italic;">
                "${escapeHtml(quote.quote)}"
            </div>
            <div style="font-size: 0.7rem; color: #666; border-top: 1px dashed #333; padding-top: 0.3rem; margin-top: 0.3rem;">
                SOURCE: ${escapeHtml(quote.speaker || 'Unknown')}${quote.team ? ` | TEAM: ${escapeHtml(quote.team)}` : ''}
            </div>
        </div>
    `).join('');
    
    // Generate timeline events HTML
    const timelineHtml = timelineEvents.map(event => `
        <div style="padding: 0.6rem; margin-bottom: 0.5rem; background: rgba(0, 0, 0, 0.3); border-left: 2px solid rgba(255, 255, 255, 0.3); font-family: 'Courier New', monospace; font-size: 0.75rem;">
            <div style="color: rgba(255, 255, 255, 0.85); font-size: 0.7rem; margin-bottom: 0.3rem; font-weight: bold; text-transform: uppercase;">
                [ ${escapeHtml(event.event_type || 'event')} ]
            </div>
            <div style="color: #aaa; margin-bottom: 0.3rem; line-height: 1.4;">
                ${escapeHtml(event.summary)}
            </div>
            ${event.date_utc ? `<div style="font-size: 0.7rem; color: #666; border-top: 1px dashed #333; padding-top: 0.3rem; margin-top: 0.3rem;">TIMESTAMP: ${escapeHtml(event.date_utc)}</div>` : ''}
        </div>
    `).join('');
    
    // Generate related articles HTML with new URL structure
    const relatedArticlesHtml = relatedPosts.slice(0, 3).map(relatedPost => {
        const relatedLeague = normalizeLeague(relatedPost.league);
        const relatedDate = relatedPost.matchupScheduledDate 
            ? formatDateISO(relatedPost.matchupScheduledDate)
            : formatDateISO(relatedPost.createdAt);
        
        // Check if related post has prediction format slug
        const relatedStoredSlug = relatedPost.websiteStory.seo?.slug || '';
        const relatedIsPredictionFormat = relatedStoredSlug.includes('-prediction-preview-') && relatedStoredSlug.match(/\d{4}-\d{2}-\d{2}$/);
        
        let relatedUrl: string;
        if (relatedIsPredictionFormat) {
            // Use prediction format: /{league}/{prediction-slug}/
            relatedUrl = `/${relatedLeague}/${relatedStoredSlug}/`;
        } else {
            // Fallback to old format
            const relatedHeatCheckData = relatedPost.heatCheckData || {};
            const relatedNarratives = relatedHeatCheckData.narratives || {};
            const relatedCandidateCards = relatedNarratives.candidate_cards || [];
            const relatedPrimaryNarrativeId = relatedNarratives.selected?.primary_narrative_id || '';
            const relatedActiveCard = relatedCandidateCards.find(card => card.narrative_id === relatedPrimaryNarrativeId);
            const relatedEmotionTags = relatedActiveCard?.emotion_tags || [];
            
            const relatedMatchupSlug = generateMatchupSlug(relatedPost.teamA || '', relatedPost.teamB || '', getShortTeamName);
            const relatedNarrativeSlug = generateNarrativeSlug(
                relatedPost.websiteStory.headline,
                relatedPost.teamA || '',
                relatedPost.teamB || '',
                relatedEmotionTags
            );
            relatedUrl = `/${relatedLeague}/${relatedDate}/${relatedMatchupSlug}/${relatedNarrativeSlug}/`;
        }
        
        // Generate descriptive anchor text with matchup info
        const relatedTeamAShort = getShortTeamName(relatedPost.teamA || '');
        const relatedTeamBShort = getShortTeamName(relatedPost.teamB || '');
        const relatedMatchup = `${relatedTeamAShort} vs ${relatedTeamBShort}`;
        
        return `
            <div style="margin-bottom: 0.75rem; padding: 0.5rem; background: rgba(255, 255, 255, 0.03); border-left: 2px solid rgba(255, 255, 255, 0.2);">
                <a href="${relatedUrl}" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; font-family: 'Courier New', monospace; font-size: 0.8rem; line-height: 1.4; display: block; transition: all 0.2s ease;" onmouseover="this.style.color='#f84242'; this.parentElement.style.borderLeftColor='rgba(248, 66, 66, 0.6)'; this.parentElement.style.background='rgba(248, 66, 66, 0.05)';" onmouseout="this.style.color='rgba(255, 255, 255, 0.85)'; this.parentElement.style.borderLeftColor='rgba(255, 255, 255, 0.2)'; this.parentElement.style.background='rgba(255, 255, 255, 0.03)';">
                    &gt; ${escapeHtml(relatedPost.websiteStory.headline)}
                </a>
                <div style="color: rgba(255, 255, 255, 0.6); font-size: 0.7rem; margin-top: 0.25rem; margin-left: 1rem;">${escapeHtml(relatedMatchup)} • ${relatedPost.league}</div>
            </div>
        `;
    }).join('');
    
    // Generate HeatChecks Edge HTML (support both old and new schemas)
    const edge = post.heatchecksEdge;
    let edgeHtml = '';
    
    // Check if it's the new V2 schema (has 'game' and 'player_props' properties)
    const isEdgeV2 = edge && typeof edge === 'object' && 'game' in edge && 'player_props' in edge;
    
    if (isEdgeV2) {
        // New V2 schema
        const edgeV2 = edge as any;
        const hasGame = edgeV2.game && edgeV2.game.market !== 'none';
        const hasProps = edgeV2.player_props && edgeV2.player_props.length > 0;
        const noEdgeReason = edgeV2.no_edge_reason;
        
        // Show edge if there's a game, props, or a reason explaining why there's no edge
        // This ensures users see the edge section even when no edge is found
        if (hasGame || hasProps || noEdgeReason) {
            edgeHtml = `
        <div id="heatchecks-edge-section" style="margin-top: 3rem; margin-bottom: 2rem; padding: 2rem; background: rgba(255, 255, 255, 0.08); border: 2px solid rgba(255, 255, 255, 0.3); border-left: 4px solid rgba(255, 255, 255, 0.5); border-right: 4px solid rgba(255, 255, 255, 0.5); border-radius: 4px; box-shadow: 0 0 40px rgba(0, 0, 0, 0.4), inset 0 0 30px rgba(255, 255, 255, 0.05), 0 4px 20px rgba(0, 0, 0, 0.5); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); position: relative; isolation: isolate;">
            <div style="position: absolute; top: 0.75rem; right: 0.75rem; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2); animation: pulse 2s infinite;"></div>
            <div style="position: absolute; bottom: 0.75rem; right: 0.75rem; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2); animation: pulse 2s infinite 1s;"></div>
            <div style="position: absolute; top: 0.75rem; left: 0.75rem; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2); animation: pulse 2s infinite 0.5s;"></div>
            <style>@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.1); } }</style>
            <div style="display: flex; align-items: center; gap: 0.75rem; margin-top: -1rem; margin-bottom: 0; padding-bottom: 0; border-bottom: 2px solid rgba(255, 255, 255, 0.3);">
                <div style="width: 4px; height: 30px; background: rgba(255, 255, 255, 0.5); box-shadow: 0 0 10px rgba(255, 255, 255, 0.3);"></div>
                <img src="/assets/images/heatchecksedge-3.png" alt="HeatChecks Edge" style="height: 160px; width: auto; display: block; margin-bottom: -1rem;" />
            </div>
            ${hasGame ? `
            <div style="margin-bottom: 1.5rem;">
                <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.9rem; font-family: 'Courier New', monospace; font-weight: bold; margin-bottom: 0.5rem; text-transform: uppercase;">
                    GAME: ${escapeHtml(edgeV2.game.market.toUpperCase())} ${(() => {
                        if (edgeV2.game.selection === 'none') return '';
                        if (edgeV2.game.selection === 'TEAM_A') return escapeHtml(post.teamA);
                        if (edgeV2.game.selection === 'TEAM_B') return escapeHtml(post.teamB);
                        return escapeHtml(edgeV2.game.selection); // OVER/UNDER for totals
                    })()}
                </div>
                <div style="color: rgba(255, 255, 255, 0.95); font-size: 1.1rem; line-height: 1.8; font-family: 'Courier New', monospace; font-weight: bold; text-shadow: 0 0 15px rgba(255, 255, 255, 0.3), 0 2px 10px rgba(0, 0, 0, 0.5); padding: 1rem; background: rgba(0, 0, 0, 0.3); border-radius: 2px; border: 1px solid rgba(248, 66, 66, 0.4);">
                    ${escapeHtml((edgeV2.game.one_sentence_call || '').replace(/TEAM_A/g, post.teamA).replace(/TEAM_B/g, post.teamB))}
                    ${edgeV2.game.receipts && edgeV2.game.receipts.filter((r: string) => r).length > 0 ? `
                    <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(255, 255, 255, 0.2);">
                        <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.5rem; font-weight: bold;">RECEIPTS:</div>
                        <ul style="margin: 0; padding-left: 1.5rem; color: rgba(255, 255, 255, 0.9); font-size: 0.85rem; line-height: 1.6;">
                            ${edgeV2.game.receipts.filter((r: string) => r).map((r: string) => `<li>${escapeHtml(r.replace(/TEAM_A/g, post.teamA).replace(/TEAM_B/g, post.teamB))}</li>`).join('')}
                        </ul>
                    </div>
                    ` : ''}
                    ${edgeV2.game.risks && edgeV2.game.risks.filter((r: string) => r).length > 0 ? `
                    <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(255, 152, 0, 0.3);">
                        <div style="color: rgba(255, 152, 0, 0.9); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.5rem; font-weight: bold;">RISKS:</div>
                        <ul style="margin: 0; padding-left: 1.5rem; color: rgba(255, 152, 0, 0.9); font-size: 0.85rem; line-height: 1.6;">
                            ${edgeV2.game.risks.filter((r: string) => r).map((r: string) => `<li>${escapeHtml(r.replace(/TEAM_A/g, post.teamA).replace(/TEAM_B/g, post.teamB))}</li>`).join('')}
                        </ul>
                    </div>
                    ` : ''}
                </div>
            </div>
            ` : ''}
            ${hasProps ? edgeV2.player_props.map((prop: any, idx: number) => `
            <div style="margin-bottom: ${idx < edgeV2.player_props.length - 1 ? '1.5rem' : '0'}; padding-top: ${idx > 0 ? '1.5rem' : '0'}; border-top: ${idx > 0 ? '1px solid rgba(255, 255, 255, 0.2)' : 'none'};">
                <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.9rem; font-family: 'Courier New', monospace; font-weight: bold; margin-bottom: 0.5rem; text-transform: uppercase;">
                    PROP: ${escapeHtml(prop.player_name)} ${escapeHtml(prop.market.replace('player_', '').toUpperCase())} ${escapeHtml(prop.selection)} ${prop.line}
                </div>
                ${prop.one_sentence_call ? `
                <div style="color: rgba(255, 255, 255, 0.95); font-size: 1.1rem; line-height: 1.8; font-family: 'Courier New', monospace; font-weight: bold; text-shadow: 0 0 15px rgba(255, 255, 255, 0.3), 0 2px 10px rgba(0, 0, 0, 0.5); padding: 1rem; background: rgba(0, 0, 0, 0.3); border-radius: 2px; border: 1px solid rgba(0, 255, 65, 0.4);">
                    ${escapeHtml((prop.one_sentence_call || '').replace(/TEAM_A/g, post.teamA).replace(/TEAM_B/g, post.teamB))}
                    ${prop.receipts && prop.receipts.filter((r: string) => r).length > 0 ? `
                    <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(255, 255, 255, 0.2);">
                        <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.5rem; font-weight: bold;">RECEIPTS:</div>
                        <ul style="margin: 0; padding-left: 1.5rem; color: rgba(255, 255, 255, 0.9); font-size: 0.85rem; line-height: 1.6;">
                            ${prop.receipts.filter((r: string) => r).map((r: string) => `<li>${escapeHtml(r.replace(/TEAM_A/g, post.teamA).replace(/TEAM_B/g, post.teamB))}</li>`).join('')}
                        </ul>
                    </div>
                    ` : ''}
                    ${prop.risks && prop.risks.filter((r: string) => r).length > 0 ? `
                    <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(255, 152, 0, 0.3);">
                        <div style="color: rgba(255, 152, 0, 0.9); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.5rem; font-weight: bold;">RISKS:</div>
                        <ul style="margin: 0; padding-left: 1.5rem; color: rgba(255, 152, 0, 0.9); font-size: 0.85rem; line-height: 1.6;">
                            ${prop.risks.filter((r: string) => r).map((r: string) => `<li>${escapeHtml(r.replace(/TEAM_A/g, post.teamA).replace(/TEAM_B/g, post.teamB))}</li>`).join('')}
                        </ul>
                    </div>
                    ` : ''}
                </div>
                ` : prop.receipts && prop.receipts.filter((r: string) => r).length > 0 ? `
                <div style="margin-top: 0.5rem;">
                    <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.5rem;">RECEIPTS:</div>
                    <ul style="margin: 0; padding-left: 1.5rem; color: rgba(255, 255, 255, 0.9); font-size: 0.85rem; line-height: 1.6;">
                        ${prop.receipts.filter((r: string) => r).map((r: string) => `<li>${escapeHtml(r.replace(/TEAM_A/g, post.teamA).replace(/TEAM_B/g, post.teamB))}</li>`).join('')}
                    </ul>
                </div>
                ` : ''}
            </div>
            `).join('') : ''}
            ${noEdgeReason && !hasGame && !hasProps ? `
            <div style="color: rgba(255, 255, 255, 0.95); font-size: 1.1rem; line-height: 1.8; font-family: 'Courier New', monospace; font-weight: bold; text-shadow: 0 0 15px rgba(255, 255, 255, 0.3), 0 2px 10px rgba(0, 0, 0, 0.5); padding: 1rem; background: rgba(0, 0, 0, 0.3); border-radius: 2px; border: 1px solid rgba(255, 255, 255, 0.2);">
                ${escapeHtml(noEdgeReason)}
            </div>
            ` : noEdgeReason ? `
            <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(255, 255, 255, 0.2); color: rgba(255, 255, 255, 0.7); font-size: 0.85rem; font-style: italic;">
                ${escapeHtml(noEdgeReason)}
            </div>
            ` : ''}
        </div>
    `;
        }
    } else if (edge && typeof edge === 'object' && 'finalCall' in edge) {
        // Old schema (backward compatibility)
        const edgeCall = (edge as any).finalCall || '';
        if (edgeCall) {
            edgeHtml = `
        <div id="heatchecks-edge-section" style="margin-top: 3rem; margin-bottom: 2rem; padding: 2rem; background: rgba(255, 255, 255, 0.08); border: 2px solid rgba(255, 255, 255, 0.3); border-left: 4px solid rgba(255, 255, 255, 0.5); border-right: 4px solid rgba(255, 255, 255, 0.5); border-radius: 4px; box-shadow: 0 0 40px rgba(0, 0, 0, 0.4), inset 0 0 30px rgba(255, 255, 255, 0.05), 0 4px 20px rgba(0, 0, 0, 0.5); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); position: relative; isolation: isolate;">
            <div style="position: absolute; top: 0.75rem; right: 0.75rem; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2); animation: pulse 2s infinite;"></div>
            <div style="position: absolute; bottom: 0.75rem; right: 0.75rem; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2); animation: pulse 2s infinite 1s;"></div>
            <div style="position: absolute; top: 0.75rem; left: 0.75rem; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2); animation: pulse 2s infinite 0.5s;"></div>
            <style>@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.1); } }</style>
            <div style="display: flex; align-items: center; gap: 0.75rem; margin-top: -1rem; margin-bottom: 0; padding-bottom: 0; border-bottom: 2px solid rgba(255, 255, 255, 0.3);">
                <div style="width: 4px; height: 30px; background: rgba(255, 255, 255, 0.5); box-shadow: 0 0 10px rgba(255, 255, 255, 0.3);"></div>
                <img src="/assets/images/heatchecksedge-3.png" alt="HeatChecks Edge" style="height: 160px; width: auto; display: block; margin-bottom: -1rem;" />
            </div>
            <div style="color: rgba(255, 255, 255, 0.95); font-size: 1.2rem; line-height: 2; font-family: 'Courier New', monospace; font-weight: bold; text-shadow: 0 0 15px rgba(255, 255, 255, 0.3), 0 2px 10px rgba(0, 0, 0, 0.5); padding: 1rem; background: rgba(0, 0, 0, 0.3); border-radius: 2px; border: 1px solid rgba(248, 66, 66, 0.4);">
                ${escapeHtml(edgeCall)}
            </div>
        </div>
    `;
        }
    }
    
    // Get short team names for meta tags and breadcrumbs (define once, reuse)
    const teamAShort = getShortTeamName(post.teamA || '');
    const teamBShort = getShortTeamName(post.teamB || '');
    const matchupMeta = `${getTeamAcronym(post.teamA || '', post.league)} vs ${getTeamAcronym(post.teamB || '', post.league)}`;
    
    // Generate breadcrumb navigation
    // Only Home, League, and Date should be links; Matchup and Article Title are just text labels
    const breadcrumbItems = [
        { name: 'Home', url: `${baseUrl}/` },
        { name: post.league.toUpperCase(), url: `${baseUrl}/${league}/` },
        { name: date, url: `${baseUrl}/${league}/${date}/` },
        { name: matchupMeta, url: null }, // Matchup is NOT a link - just a label
        { name: post.websiteStory.headline.substring(0, 40) + (post.websiteStory.headline.length > 40 ? '...' : ''), url: null } // Article title is NOT a link
    ];
    
    const breadcrumbHtml = `
        <nav aria-label="Breadcrumb" style="margin-bottom: 1.5rem; padding: 0.75rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1); font-family: 'Courier New', monospace; font-size: 0.75rem;">
            <ol style="list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;">
                ${breadcrumbItems.map((item, index) => `
                    <li style="display: inline-flex; align-items: center;">
                        ${index > 0 ? '<span style="color: rgba(255, 255, 255, 0.4); margin: 0 0.5rem;">▶</span>' : ''}
                        ${!item.url || index >= breadcrumbItems.length - 2
                            ? `<span style="color: ${index === breadcrumbItems.length - 1 ? '#ff0040' : 'rgba(255, 255, 255, 0.7)'}; font-weight: ${index === breadcrumbItems.length - 1 ? '600' : 'normal'};">${escapeHtml(item.name)}</span>`
                            : `<a href="${item.url}" style="color: rgba(255, 255, 255, 0.7); text-decoration: none; transition: color 0.2s ease;" onmouseover="this.style.color='#ff0040';" onmouseout="this.style.color='rgba(255, 255, 255, 0.7)';">${escapeHtml(item.name)}</a>`
                        }
                    </li>
                `).join('')}
            </ol>
        </nav>
    `;
    
    // Main content area (two-column layout) with semantic HTML
    const content = `
        <style>
            /* Mobile responsive styles */
            @media (max-width: 768px) {
                .article-content-grid {
                    grid-template-columns: 1fr !important;
                    grid-template-rows: auto auto !important;
                }
                .article-main-column {
                    grid-column: 1 !important;
                    grid-row: 1 !important;
                }
                .article-sidebar-column {
                    grid-column: 1 !important;
                    grid-row: 2 !important;
                    overflow-y: visible !important;
                    overflow-x: hidden !important;
                    max-height: none !important;
                }
                section[aria-label="Temperature Check"] {
                    overflow-y: visible !important;
                    overflow-x: hidden !important;
                    max-height: none !important;
                }
                /* Hide "See Prediction" button in temperature check (we show it in header instead) */
                section[aria-label="Temperature Check"] button {
                    display: none !important;
                }
                /* Show mobile matchup titles with acronyms, hide full names */
                .matchup-title-full {
                    display: none !important;
                }
                .matchup-title-mobile {
                    display: inline !important;
                }
                .matchup-info-full {
                    display: none !important;
                }
                .matchup-info-mobile {
                    display: inline !important;
                }
            }
        </style>
        ${breadcrumbHtml}
        <article class="article-content-grid" style="display: grid; grid-template-columns: 2fr 1fr; grid-template-rows: auto 1fr; gap: 0.5rem; padding: 0.5rem;">
            <!-- Left Column: Main Article -->
            <section class="article-main-column" style="grid-column: 1; grid-row: 1 / -1; display: flex; flex-direction: column; background: rgba(0, 20, 10, 0.4); border: 1px solid rgba(0, 255, 65, 0.4); box-shadow: inset 0 0 20px rgba(0, 255, 65, 0.08), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden;">
                <div class="main-document-header terminal-style" style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.15); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);"></div>
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; margin-left: 0.5rem; letter-spacing: 0.1em;">MAIN_DOCUMENT.log</div>
                </div>
                <div style="flex: 1; overflow-y: auto; padding: 1.5rem; font-family: 'Courier New', monospace; color: rgba(255, 255, 255, 0.85); font-size: 0.95rem; line-height: 1.8; scrollbar-width: none; -ms-overflow-style: none;">
                    <style>.main-article-content::-webkit-scrollbar { display: none; }</style>
                    <header style="margin-bottom: 2rem; border-bottom: 1px dashed rgba(0, 255, 65, 0.4); padding-bottom: 1rem;">
                        <h1 style="color: rgba(255, 255, 255, 0.95); font-size: 1.3rem; margin-bottom: 0.5rem; font-weight: bold; line-height: 1.3;">
                            <span class="matchup-title-full">${escapeHtml(post.storyType === 'heat_article_v3' ? `${matchupMeta} Preview` : post.websiteStory.headline)}</span>
                            <span class="matchup-title-mobile" style="display: none;">${escapeHtml(post.storyType === 'heat_article_v3' ? `${getTeamAcronym(post.teamA || '', post.league)} vs ${getTeamAcronym(post.teamB || '', post.league)} Preview` : post.websiteStory.headline)}</span>
                        </h1>
                        <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap;">
                            ${hasEdge ? `<button onclick="(function() { const tempCheckSection = document.getElementById('temperature-check-section'); const isMobile = window.innerWidth <= 768; if (isMobile && tempCheckSection) { tempCheckSection.scrollIntoView({behavior: 'smooth', block: 'start'}); } else { const edgeSections = document.querySelectorAll('#heatchecks-edge-section'); let visibleEdge = null; edgeSections.forEach(el => { const rect = el.getBoundingClientRect(); const style = window.getComputedStyle(el); if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') { visibleEdge = el; } }); if (visibleEdge) { visibleEdge.scrollIntoView({behavior: 'smooth', block: 'start'}); } else if (edgeSections.length > 0) { edgeSections[0].scrollIntoView({behavior: 'smooth', block: 'start'}); } } })(); return false;" style="display: inline-block; padding: 0.4rem 0.8rem; background: #000; border: 1px solid #00ff41; color: #00ff41; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.9rem; cursor: pointer; transition: all 0.3s ease; white-space: nowrap;" onmouseover="this.style.background='rgba(0,255,65,0.1)'; this.style.borderColor='#00ff41';" onmouseout="this.style.background='#000'; this.style.borderColor='#00ff41';">See Prediction/Stats</button>` : ''}
                            <a href="/" class="article-back-btn" style="display: inline-block; padding: 0.4rem 0.8rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(248, 66, 66, 0.5); color: rgba(248, 66, 66, 0.9); text-decoration: none; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.9rem; transition: all 0.3s ease; white-space: nowrap; line-height: 1;" onmouseover="this.style.background='rgba(248,66,66,0.1)'; this.style.borderColor='rgba(248,66,66,0.7)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0,0,0,0.3)'; this.style.borderColor='rgba(248,66,66,0.5)'; this.style.color='rgba(248,66,66,0.9)';">← BACK</a>
                        </div>
                        <p style="color: rgba(255, 255, 255, 0.6); font-size: 0.85rem; margin-bottom: 0.5rem;">// ${escapeHtml(post.websiteStory.dek)}</p>
                        <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.8rem; font-family: 'Courier New', monospace;">
                            <span class="matchup-info-full">&gt; MATCHUP: ${escapeHtml(post.league.toUpperCase())} | ${escapeHtml(getTeamAcronym(post.teamA || '', post.league))} vs ${escapeHtml(getTeamAcronym(post.teamB || '', post.league))} | DATE: <time datetime="${post.matchupScheduledDate || post.createdAt}">${escapeHtml(date)}</time></span>
                            <span class="matchup-info-mobile" style="display: none;">&gt; MATCHUP: ${escapeHtml(post.league.toUpperCase())} | ${escapeHtml(getTeamAcronym(post.teamA || '', post.league))} vs ${escapeHtml(getTeamAcronym(post.teamB || '', post.league))} | DATE: <time datetime="${post.matchupScheduledDate || post.createdAt}">${escapeHtml(date)}</time></span>
                        </div>
                    </header>
                    ${imagePath ? `
                    <div style="margin-bottom: 2rem; border: 1px solid rgba(0, 255, 65, 0.4); padding: 0.5rem; background: rgba(0, 255, 65, 0.05);">
                        <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.75rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold;">&gt; IMAGE_ASSET [LOADED]</div>
                        <img src="${imagePath}" alt="${escapeHtml(`${matchupMeta} ${post.league} ${narrativeKeyword} - ${post.websiteStory.headline} - HeatChecks Analysis`)}" class="heatcheck-header-image" style="width: 100%; max-height: 400px; object-fit: contain; display: block; border: 1px dashed rgba(0, 255, 65, 0.3);">
                    </div>
                    ` : ''}
                    <div style="color: rgba(255, 255, 255, 0.7); white-space: normal; overflow-wrap: anywhere; word-break: break-word;">
                        ${htmlContent
                            .replace(/style="color: #ffaa00; fontSize:/g, 'style="color: #ffaa00; font-size:')
                            .replace(/marginTop:/g, 'margin-top:')
                            .replace(/marginBottom:/g, 'margin-bottom:')
                            .replace(/fontWeight:/g, 'font-weight:')}
                    </div>
                    ${edgeHtml}
                </div>
            </section>
            
            <!-- Right Column: Narrative Rack & Evidence Board -->
            <aside class="article-sidebar-column" style="grid-column: 2; grid-row: 1 / -1; display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto; overflow-x: hidden;">
                ${temperatureCheckHtml}
                <!-- HeatChecks Edge - Mobile only (shown below Temperature Check) -->
                ${hasEdge ? `<div class="heatchecks-edge-mobile" style="display: none;">${edgeHtml}</div>` : ''}
                <!-- Narrative Rack -->
                <section aria-label="Narrative Analysis" style="flex: 1 1 50%; display: flex; flex-direction: column; background: rgba(0, 20, 10, 0.4); border: 1px solid rgba(0, 255, 65, 0.4); box-shadow: inset 0 0 20px rgba(0, 255, 65, 0.08), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden; min-height: 0;">
                    <div style="padding: 0.5rem 0.75rem; background: rgba(0, 255, 65, 0.08); border-bottom: 1px solid rgba(0, 255, 65, 0.4); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                        <div style="width: 6px; height: 6px; background: rgba(248, 66, 66, 0.8); border-radius: 50%; box-shadow: 0 0 6px rgba(248, 66, 66, 0.5);"></div>
                        <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; letter-spacing: 0.1em; font-weight: bold;">NARRATIVE_RACK [SLOT_ACTIVE]</div>
                    </div>
                    <div style="flex: 1; overflow-y: auto; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; scrollbar-width: none; -ms-overflow-style: none;">
                        <style>div[style*="overflow-y"]::-webkit-scrollbar { display: none; }</style>
                        ${narrativeCardsHtml || '<div style="color: #666; font-size: 0.75rem;">No narrative cards available</div>'}
                    </div>
                </section>
                
                <!-- Evidence Board -->
                <section aria-label="Evidence and Quotes" style="flex: 1 1 50%; display: flex; flex-direction: column; background: rgba(0, 20, 10, 0.4); border: 1px solid rgba(0, 255, 65, 0.4); box-shadow: inset 0 0 20px rgba(0, 255, 65, 0.08), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden; min-height: 0;">
                    <div style="padding: 0.5rem 0.75rem; background: rgba(0, 255, 65, 0.08); border-bottom: 1px solid rgba(0, 255, 65, 0.4); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                        <div style="width: 6px; height: 6px; background: rgba(248, 66, 66, 0.8); border-radius: 50%; box-shadow: 0 0 6px rgba(248, 66, 66, 0.5);"></div>
                        <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; letter-spacing: 0.1em; font-weight: bold;">EVIDENCE_RACK [DATA_STREAM]</div>
                    </div>
                    <div style="flex: 1; overflow-y: auto; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; scrollbar-width: none; -ms-overflow-style: none;">
                        <style>div[style*="overflow-y"]::-webkit-scrollbar { display: none; }</style>
                        ${displayQuotes.length > 0 ? `
                        <div>
                            <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.75rem; margin-bottom: 0.5rem; font-weight: bold; border-bottom: 1px dashed rgba(0, 255, 65, 0.4); padding-bottom: 0.25rem;">&gt; QUOTE_LOG [ENTRIES: ${displayQuotes.length}]</div>
                            ${quotesHtml}
                        </div>
                        ` : ''}
                        ${timelineEvents.length > 0 ? `
                        <div style="margin-top: ${displayQuotes.length > 0 ? '0.5rem' : '0'};">
                            <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.75rem; margin-bottom: 0.5rem; font-weight: bold; border-bottom: 1px dashed rgba(0, 255, 65, 0.4); padding-bottom: 0.25rem;">&gt; TIMELINE_LOG [ENTRIES: ${timelineEvents.length}]</div>
                            ${timelineHtml}
                        </div>
                        ` : ''}
                        ${displayQuotes.length === 0 && timelineEvents.length === 0 ? '<div style="color: #666; font-size: 0.75rem;">No evidence data available</div>' : ''}
                    </div>
                </section>
            </aside>
        </article>
        
        <!-- Internal Navigation & Related Articles -->
        <nav aria-label="Internal navigation" style="margin-top: 2rem; padding: 1rem; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.2);">
            <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.5rem;">&gt; INTERNAL_NAVIGATION</div>
            <a href="/${league}/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; margin-right: 1rem; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(0, 255, 65, 0.4); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(0, 255, 65, 0.15)'; this.style.borderColor='rgba(0, 255, 65, 0.7)'; this.style.color='#00ff41';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(0, 255, 65, 0.4)'; this.style.color='rgba(255, 255, 255, 0.85)';">${post.league.toUpperCase()} Hub</a>
            <a href="/${league}/${date}/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; margin-right: 1rem; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(0, 255, 65, 0.4); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(0, 255, 65, 0.15)'; this.style.borderColor='rgba(0, 255, 65, 0.7)'; this.style.color='#00ff41';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(0, 255, 65, 0.4)'; this.style.color='rgba(255, 255, 255, 0.85)';">${date}</a>
            <a href="/archive/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(0, 255, 65, 0.4); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(0, 255, 65, 0.15)'; this.style.borderColor='rgba(0, 255, 65, 0.7)'; this.style.color='#00ff41';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(0, 255, 65, 0.4)'; this.style.color='rgba(255, 255, 255, 0.85)';">Archive</a>
        </nav>
        ${relatedPosts.length > 0 ? `
        <aside aria-label="Related articles" style="margin-top: 2rem; padding: 1rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1);">
            <h2 style="color: rgba(255, 255, 255, 0.7); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.75rem; margin-top: 0;">&gt; RELATED_ARTICLES</h2>
            ${relatedArticlesHtml}
        </aside>
        ` : ''}
    `;
    
    // Helper function to get venue/location from team name
    function getVenueFromTeam(teamName: string, league: string): { "@type": string; name: string; address: { "@type": string; addressLocality: string; addressRegion: string; addressCountry: string } } | undefined {
        // Only process NBA teams
        if (league.toUpperCase() !== 'NBA') {
            return undefined;
        }
        
        // Normalize team name for matching (trim, case-insensitive)
        const normalizedTeamName = teamName.trim();
        
        // Complete NBA venue mapping
        const nbaVenues: { [key: string]: { name: string; city: string; state: string; country?: string } } = {
            'Atlanta Hawks': { name: 'State Farm Arena', city: 'Atlanta', state: 'Georgia' },
            'Boston Celtics': { name: 'TD Garden', city: 'Boston', state: 'Massachusetts' },
            'Brooklyn Nets': { name: 'Barclays Center', city: 'Brooklyn', state: 'New York' },
            'Charlotte Hornets': { name: 'Spectrum Center', city: 'Charlotte', state: 'North Carolina' },
            'Chicago Bulls': { name: 'United Center', city: 'Chicago', state: 'Illinois' },
            'Cleveland Cavaliers': { name: 'Rocket Mortgage FieldHouse', city: 'Cleveland', state: 'Ohio' },
            'Dallas Mavericks': { name: 'American Airlines Center', city: 'Dallas', state: 'Texas' },
            'Denver Nuggets': { name: 'Ball Arena', city: 'Denver', state: 'Colorado' },
            'Detroit Pistons': { name: 'Little Caesars Arena', city: 'Detroit', state: 'Michigan' },
            'Golden State Warriors': { name: 'Chase Center', city: 'San Francisco', state: 'California' },
            'Houston Rockets': { name: 'Toyota Center', city: 'Houston', state: 'Texas' },
            'Indiana Pacers': { name: 'Gainbridge Fieldhouse', city: 'Indianapolis', state: 'Indiana' },
            'Los Angeles Clippers': { name: 'Intuit Dome', city: 'Inglewood', state: 'California' },
            'Los Angeles Lakers': { name: 'Crypto.com Arena', city: 'Los Angeles', state: 'California' },
            'Memphis Grizzlies': { name: 'FedExForum', city: 'Memphis', state: 'Tennessee' },
            'Miami Heat': { name: 'Kaseya Arena', city: 'Miami', state: 'Florida' },
            'Milwaukee Bucks': { name: 'Fiserv Forum', city: 'Milwaukee', state: 'Wisconsin' },
            'Minnesota Timberwolves': { name: 'Target Center', city: 'Minneapolis', state: 'Minnesota' },
            'New Orleans Pelicans': { name: 'Smoothie King Center', city: 'New Orleans', state: 'Louisiana' },
            'New York Knicks': { name: 'Madison Square Garden', city: 'New York', state: 'New York' },
            'Oklahoma City Thunder': { name: 'Paycom Center', city: 'Oklahoma City', state: 'Oklahoma' },
            'Orlando Magic': { name: 'Kia Center', city: 'Orlando', state: 'Florida' },
            'Philadelphia 76ers': { name: 'Wells Fargo Center', city: 'Philadelphia', state: 'Pennsylvania' },
            'Phoenix Suns': { name: 'Footprint Center', city: 'Phoenix', state: 'Arizona' },
            'Portland Trail Blazers': { name: 'Moda Center', city: 'Portland', state: 'Oregon' },
            'Sacramento Kings': { name: 'Golden 1 Center', city: 'Sacramento', state: 'California' },
            'San Antonio Spurs': { name: 'Frost Bank Center', city: 'San Antonio', state: 'Texas' },
            'Toronto Raptors': { name: 'Scotiabank Arena', city: 'Toronto', state: 'Ontario', country: 'Canada' },
            'Utah Jazz': { name: 'Delta Center', city: 'Salt Lake City', state: 'Utah' },
            'Washington Wizards': { name: 'Capital One Arena', city: 'Washington', state: 'D.C.' }
        };
        
        // Try exact match first (case-insensitive)
        let venue = nbaVenues[normalizedTeamName];
        if (!venue) {
            // Try case-insensitive lookup
            const lowerTeamName = normalizedTeamName.toLowerCase();
            for (const [key, value] of Object.entries(nbaVenues)) {
                if (key.toLowerCase() === lowerTeamName) {
                    venue = value;
                    break;
                }
            }
        }
        
        if (!venue) {
            return undefined;
        }
        
        return {
            "@type": "Place",
            "name": venue.name,
            "address": {
                "@type": "PostalAddress",
                "addressLocality": venue.city,
                "addressRegion": venue.state,
                "addressCountry": venue.country || "US"
            }
        };
    }
    
    // Calculate end date (typically 2.5 hours for NBA games)
    function calculateEndDate(startDate: string): string {
        try {
            const start = new Date(startDate);
            const end = new Date(start.getTime() + (2.5 * 60 * 60 * 1000)); // 2.5 hours
            return end.toISOString();
        } catch {
            return startDate; // Fallback to start date if parsing fails
        }
    }
    
    // Format startDate to ISO 8601 if not already - always returns a string
    function formatStartDate(dateString: string | undefined): string {
        if (!dateString) {
            // Fallback to current date if no date provided
            return new Date().toISOString();
        }
        try {
            // If already ISO format, return as is
            if (dateString.includes('T') && (dateString.includes('Z') || dateString.includes('+'))) {
                return dateString;
            }
            // If just date, add time (default to 8 PM ET / 1 AM UTC next day)
            if (dateString.match(/^\d{4}-\d{2}-\d{2}$/)) {
                return new Date(`${dateString}T20:00:00-05:00`).toISOString();
            }
            return new Date(dateString).toISOString();
        } catch {
            // Fallback: try to parse as date or use current date
            try {
                return new Date(dateString).toISOString();
            } catch {
                return new Date().toISOString();
            }
        }
    }
    
    // Generate Schema.org JSON-LD
    const schemaOrg = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": post.websiteStory.headline,
        "description": post.websiteStory.dek,
        "image": imagePath || `${baseUrl}/images/default-og-image.jpg`,
        "datePublished": post.createdAt,
        "dateModified": post.updatedAt,
        "author": {
            "@type": "Organization",
            "name": "HeatChecks",
            "url": baseUrl
        },
        "publisher": {
            "@type": "Organization",
            "name": "HeatChecks",
            "url": baseUrl
        },
        "mainEntityOfPage": {
            "@type": "WebPage",
            "@id": articleUrl
        },
        "articleSection": post.league
    };
    
    const formattedStartDate = formatStartDate(post.matchupScheduledDate || post.createdAt);
    const venue = getVenueFromTeam(post.teamA, post.league);
    
    // Ensure location is always present (required field)
    // Use venue if available, otherwise create a fallback location
    const location = venue || {
        "@type": "Place",
        "name": `${post.teamA} Arena`,
        "address": {
            "@type": "PostalAddress",
            "addressLocality": post.teamA.split(' ').slice(-1)[0], // Use last word of team name as city fallback
            "addressCountry": "US"
        }
    };
    
    const sportsEventSchema: any = {
        "@context": "https://schema.org",
        "@type": "SportsEvent",
        "name": `${post.teamA} vs ${post.teamB}`,
        "sport": post.league,
        "homeTeam": {
            "@type": "SportsTeam",
            "name": post.teamA
        },
        "awayTeam": {
            "@type": "SportsTeam",
            "name": post.teamB
        },
        "startDate": formattedStartDate,
        "location": location,
        "eventStatus": {
            "@type": "EventStatusType",
            "eventStatusType": "https://schema.org/EventScheduled"
        }
    };
    
    // Add optional fields for better SEO
    if (formattedStartDate) {
        sportsEventSchema.endDate = calculateEndDate(formattedStartDate);
    }
    
    if (post.websiteStory.dek) {
        sportsEventSchema.description = post.websiteStory.dek;
    }
    
    if (imagePath) {
        sportsEventSchema.image = imagePath.startsWith('http') ? imagePath : `${baseUrl}${imagePath}`;
    } else {
        sportsEventSchema.image = `${baseUrl}/images/default-og-image.jpg`;
    }
    
    sportsEventSchema.organizer = {
        "@type": "Organization",
        "name": post.league,
        "url": `${baseUrl}/${normalizeLeague(post.league)}/`
    };
    
    // Generate Review schema for matchup analysis
    const reviewSchema = {
        "@context": "https://schema.org",
        "@type": "Review",
        "itemReviewed": {
            "@type": "SportsEvent",
            "name": `${post.teamA} vs ${post.teamB}`,
            "sport": post.league,
            "startDate": formattedStartDate,
            "location": location,
            "homeTeam": {
                "@type": "SportsTeam",
                "name": post.teamA
            },
            "awayTeam": {
                "@type": "SportsTeam",
                "name": post.teamB
            }
        },
        "author": {
            "@type": "Organization",
            "name": "HeatChecks"
        },
        "reviewBody": post.websiteStory.dek || post.websiteStory.headline,
        "datePublished": post.createdAt
    };
    
    // Enhanced meta description: Include matchup, narrative keyword, betting keywords, and dek
    // Note: narrativeKeyword is already defined above (after emotionTags extraction)
    let metaDescription = post.websiteStory.dek || '';
    const leagueUpper = post.league.toUpperCase();
    const bettingKeywords = `betting picks, sports betting analysis, matchup preview, game prediction`;
    
    if (metaDescription && metaDescription.length < 140) {
        // Add matchup, betting keywords, and narrative context if there's room
        metaDescription = `${matchupMeta} ${leagueUpper} betting analysis: ${metaDescription}`;
        if (metaDescription.length > 160) {
            metaDescription = post.websiteStory.dek || ''; // Fallback to original if too long
        }
    }
    
    // Ensure meta description is 150-160 characters (optimal length)
    if (metaDescription.length > 160) {
        metaDescription = metaDescription.substring(0, 157) + '...';
    } else if (metaDescription.length < 120) {
        metaDescription = `${metaDescription} ${matchupMeta} ${leagueUpper} matchup analysis with narrative insights, betting picks, and emotional forces.`;
        if (metaDescription.length > 160) {
            metaDescription = metaDescription.substring(0, 157) + '...';
        }
    }
    
    // Enhanced title tag: Include matchup and betting keywords for better keyword targeting
    // Format: {Headline} | {TeamA} vs {TeamB} {League} Betting | HeatChecks
    let title = post.websiteStory.headline;
    if (title.length > 50) {
        title = `${title.substring(0, 50)}... | ${matchupMeta} ${leagueUpper} Betting | HeatChecks`;
    } else {
        title = `${title} | ${matchupMeta} ${leagueUpper} Betting | HeatChecks`;
    }
    
    // Generate keywords for meta tag
    const narrativeKeywords = emotionTags.map(tag => tag.toLowerCase().replace(/\s+/g, '-')).join(', ');
    const keywords = [
        'sports betting picks',
        'betting predictions',
        'betting analysis',
        'betting tips',
        `${leagueUpper} betting`,
        `${leagueUpper} picks`,
        `${matchupMeta} betting`,
        'matchup preview',
        'game prediction',
        narrativeKeywords
    ].filter(k => k).join(', ');
    
    // Generate BreadcrumbList schema.org structured data
    // Only include items with URLs (Home, League, Date) - exclude matchup and article title
    const breadcrumbSchema = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": breadcrumbItems
            .filter(item => item.url !== null)
            .map((item, index) => ({
                "@type": "ListItem",
                "position": index + 1,
                "name": item.name,
                "item": item.url
            }))
    };
    
    const options: BaseTemplateOptions = {
        title: title,
        description: metaDescription,
        url: canonicalUrl, // Use canonical URL for meta tags
        baseUrl,
        ogImage: imagePath ? (imagePath.startsWith('http') ? imagePath : `${baseUrl}${imagePath}`) : `${baseUrl}/images/default-og-image.jpg`,
        ogType: 'article',
        keywords: keywords,
        articleMeta: {
            publishedTime: post.createdAt,
            modifiedTime: post.updatedAt,
            author: 'HeatChecks',
            section: post.league,
            tags: emotionTags.length > 0 ? emotionTags : [post.league, 'Betting Analysis', 'Matchup Preview']
        },
        schemaOrg: [schemaOrg, sportsEventSchema, breadcrumbSchema, reviewSchema],
        posts: [post, ...relatedPosts]
    };
    
    return generateBaseHtml(content, options);
}
