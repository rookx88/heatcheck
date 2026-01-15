import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { markdownToHtml } from '../utils/markdown-converter';
import { escapeHtml } from '../utils/html-escape';
import { formatDateISO, normalizeLeague, getShortTeamName } from '../utils/date-formatter';
import { generateSlug, generateNarrativeSlug, generateMatchupSlug, extractNarrativeKeywords } from '../utils/slug-generator';

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
    
    // Generate matchup slug: teamA-vs-teamB
    const matchupSlug = generateMatchupSlug(post.teamA || '', post.teamB || '', getShortTeamName);
    
    // Generate narrative-based slug
    const narrativeSlug = generateNarrativeSlug(
        post.websiteStory.headline,
        post.teamA || '',
        post.teamB || '',
        emotionTags
    );
    
    // New URL structure: /{league}/{date}/{matchup}/{narrative-slug}/
    // Note: Trailing slash for clean URLs, will be served as index.html in directory
    const articleUrl = `${baseUrl}/${league}/${date}/${matchupSlug}/${narrativeSlug}/`;
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
    const htmlContent = markdownToHtml(articleContent);
    
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
            <div style="padding: 0.75rem; background: ${isActive ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.3)'}; border: 1px solid ${isActive ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.1)'}; border-left: 3px solid ${isActive ? 'rgba(248, 66, 66, 0.6)' : 'rgba(255, 255, 255, 0.15)'}; font-family: 'Courier New', monospace; font-size: 0.8rem;">
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
        
        // Generate new URL structure for related articles
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
        const relatedUrl = `/${relatedLeague}/${relatedDate}/${relatedMatchupSlug}/${relatedNarrativeSlug}/`;
        
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
    
    // Generate HeatChecks Edge HTML
    const edgeCall = post.heatchecksEdge?.finalCall || '';
    const edgeHtml = edgeCall ? `
        <div style="margin-top: 3rem; margin-bottom: 2rem; padding: 2rem; background: rgba(255, 255, 255, 0.08); border: 2px solid rgba(255, 255, 255, 0.3); border-left: 4px solid rgba(255, 255, 255, 0.5); border-right: 4px solid rgba(255, 255, 255, 0.5); border-radius: 4px; box-shadow: 0 0 40px rgba(0, 0, 0, 0.4), inset 0 0 30px rgba(255, 255, 255, 0.05), 0 4px 20px rgba(0, 0, 0, 0.5); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); position: relative; isolation: isolate;">
            <div style="position: absolute; top: 0.75rem; right: 0.75rem; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2); animation: pulse 2s infinite;"></div>
            <div style="position: absolute; bottom: 0.75rem; right: 0.75rem; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2); animation: pulse 2s infinite 1s;"></div>
            <div style="position: absolute; top: 0.75rem; left: 0.75rem; width: 12px; height: 12px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 15px rgba(255, 255, 255, 0.4), 0 0 25px rgba(255, 255, 255, 0.2); animation: pulse 2s infinite 0.5s;"></div>
            <style>@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.7; transform: scale(1.1); } }</style>
            <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 2px solid rgba(255, 255, 255, 0.3);">
                <div style="width: 4px; height: 30px; background: rgba(255, 255, 255, 0.5); box-shadow: 0 0 10px rgba(255, 255, 255, 0.3);"></div>
                <div style="color: rgba(255, 255, 255, 0.95); font-size: 1rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.2em; text-shadow: 0 0 10px rgba(255, 255, 255, 0.3), 0 0 20px rgba(255, 255, 255, 0.1);">
                    &gt; HEATCHECKS EDGE
                </div>
                <div style="flex: 1; height: 1px; background: linear-gradient(90deg, rgba(255, 255, 255, 0.3) 0%, transparent 100%);"></div>
            </div>
            <div style="color: rgba(255, 255, 255, 0.95); font-size: 1.2rem; line-height: 2; font-family: 'Courier New', monospace; font-weight: bold; text-shadow: 0 0 15px rgba(255, 255, 255, 0.3), 0 2px 10px rgba(0, 0, 0, 0.5); padding: 1rem; background: rgba(0, 0, 0, 0.3); border-radius: 2px; border: 1px solid rgba(248, 66, 66, 0.4);">
                ${escapeHtml(edgeCall)}
            </div>
        </div>
    ` : '';
    
    // Get short team names for meta tags and breadcrumbs (define once, reuse)
    const teamAShort = getShortTeamName(post.teamA || '');
    const teamBShort = getShortTeamName(post.teamB || '');
    const matchupMeta = `${teamAShort} vs ${teamBShort}`;
    
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
        ${breadcrumbHtml}
        <article class="article-content-grid" style="display: grid; grid-template-columns: 2fr 1fr; grid-template-rows: auto 1fr; gap: 0.5rem; padding: 0.5rem;">
            <!-- Left Column: Main Article -->
            <section class="article-main-column" style="grid-column: 1; grid-row: 1 / -1; display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.05), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden;">
                <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.15); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);"></div>
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; margin-left: 0.5rem; letter-spacing: 0.1em;">MAIN_DOCUMENT.log</div>
                </div>
                <div style="flex: 1; overflow-y: auto; padding: 1.5rem; font-family: 'Courier New', monospace; color: rgba(255, 255, 255, 0.85); font-size: 0.95rem; line-height: 1.8; scrollbar-width: none; -ms-overflow-style: none;">
                    <style>.main-article-content::-webkit-scrollbar { display: none; }</style>
                    <nav aria-label="Breadcrumb navigation">
                        <a href="/" class="article-back-btn" style="display: inline-block; margin-bottom: 1rem; padding: 0.4rem 0.8rem; background: #000; border: 1px solid #f84242; color: #f84242; text-decoration: none; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.9rem; transition: all 0.3s ease;">← BACK</a>
                    </nav>
                    <header style="margin-bottom: 2rem; border-bottom: 1px dashed rgba(255, 255, 255, 0.3); padding-bottom: 1rem;">
                        <h1 style="color: rgba(255, 255, 255, 0.95); font-size: 1.3rem; margin-bottom: 0.5rem; font-weight: bold; line-height: 1.3;">${escapeHtml(post.websiteStory.headline)}</h1>
                        <p style="color: rgba(255, 255, 255, 0.6); font-size: 0.85rem; margin-bottom: 0.5rem;">// ${escapeHtml(post.websiteStory.dek)}</p>
                        <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.8rem; font-family: 'Courier New', monospace;">&gt; MATCHUP: ${escapeHtml(post.league.toUpperCase())} | ${escapeHtml(post.teamA)} vs ${escapeHtml(post.teamB)} | DATE: <time datetime="${post.matchupScheduledDate || post.createdAt}">${escapeHtml(date)}</time></div>
                    </header>
                    ${imagePath ? `
                    <div style="margin-bottom: 2rem; border: 1px solid rgba(255, 255, 255, 0.2); padding: 0.5rem; background: rgba(255, 255, 255, 0.03);">
                        <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.75rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold;">&gt; IMAGE_ASSET [LOADED]</div>
                        <img src="${imagePath}" alt="${escapeHtml(`${matchupMeta} ${post.league} ${narrativeKeyword} - ${post.websiteStory.headline} - HeatChecks Analysis`)}" class="heatcheck-header-image" style="width: 100%; max-height: 400px; object-fit: contain; display: block; border: 1px dashed rgba(255, 255, 255, 0.2);">
                    </div>
                    ` : ''}
                    <div style="color: rgba(255, 255, 255, 0.7); white-space: pre-wrap; word-wrap: break-word;">
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
            <aside class="article-sidebar-column" style="grid-column: 2; grid-row: 1 / -1; display: flex; flex-direction: column; gap: 0.5rem; overflow: hidden;">
                <!-- Narrative Rack -->
                <section aria-label="Narrative Analysis" style="flex: 1 1 50%; display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.05), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden; min-height: 0;">
                    <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(248, 66, 66, 0.3); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                        <div style="width: 6px; height: 6px; background: rgba(248, 66, 66, 0.8); border-radius: 50%; box-shadow: 0 0 6px rgba(248, 66, 66, 0.5);"></div>
                        <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; letter-spacing: 0.1em; font-weight: bold;">NARRATIVE_RACK [SLOT_ACTIVE]</div>
                    </div>
                    <div style="flex: 1; overflow-y: auto; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; scrollbar-width: none; -ms-overflow-style: none;">
                        <style>div[style*="overflow-y"]::-webkit-scrollbar { display: none; }</style>
                        ${narrativeCardsHtml || '<div style="color: #666; font-size: 0.75rem;">No narrative cards available</div>'}
                    </div>
                </section>
                
                <!-- Evidence Board -->
                <section aria-label="Evidence and Quotes" style="flex: 1 1 50%; display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.05), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden; min-height: 0;">
                    <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(248, 66, 66, 0.3); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                        <div style="width: 6px; height: 6px; background: rgba(248, 66, 66, 0.8); border-radius: 50%; box-shadow: 0 0 6px rgba(248, 66, 66, 0.5);"></div>
                        <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; letter-spacing: 0.1em; font-weight: bold;">EVIDENCE_RACK [DATA_STREAM]</div>
                    </div>
                    <div style="flex: 1; overflow-y: auto; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; scrollbar-width: none; -ms-overflow-style: none;">
                        <style>div[style*="overflow-y"]::-webkit-scrollbar { display: none; }</style>
                        ${displayQuotes.length > 0 ? `
                        <div>
                            <div style="color: rgba(248, 66, 66, 0.9); font-size: 0.75rem; margin-bottom: 0.5rem; font-weight: bold; border-bottom: 1px dashed rgba(248, 66, 66, 0.3); padding-bottom: 0.25rem;">&gt; QUOTE_LOG [ENTRIES: ${displayQuotes.length}]</div>
                            ${quotesHtml}
                        </div>
                        ` : ''}
                        ${timelineEvents.length > 0 ? `
                        <div style="margin-top: ${displayQuotes.length > 0 ? '0.5rem' : '0'};">
                            <div style="color: rgba(248, 66, 66, 0.9); font-size: 0.75rem; margin-bottom: 0.5rem; font-weight: bold; border-bottom: 1px dashed rgba(248, 66, 66, 0.3); padding-bottom: 0.25rem;">&gt; TIMELINE_LOG [ENTRIES: ${timelineEvents.length}]</div>
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
            <a href="/${league}/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; margin-right: 1rem; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.5)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='rgba(255, 255, 255, 0.85)';">${post.league.toUpperCase()} Hub</a>
            <a href="/${league}/${date}/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; margin-right: 1rem; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.5)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='rgba(255, 255, 255, 0.85)';">${date}</a>
            <a href="/archive/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.5)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='rgba(255, 255, 255, 0.85)';">Archive</a>
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
        
        const venue = nbaVenues[teamName];
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
    
    // Format startDate to ISO 8601 if not already
    function formatStartDate(dateString: string | undefined): string | undefined {
        if (!dateString) return undefined;
        try {
            // If already ISO format, return as is
            if (dateString.includes('T') && dateString.includes('Z')) {
                return dateString;
            }
            // If just date, add time (default to 8 PM ET / 1 AM UTC next day)
            if (dateString.match(/^\d{4}-\d{2}-\d{2}$/)) {
                return new Date(`${dateString}T20:00:00-05:00`).toISOString();
            }
            return new Date(dateString).toISOString();
        } catch {
            return dateString;
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
        "eventStatus": {
            "@type": "EventStatusType",
            "eventStatusType": "https://schema.org/EventScheduled"
        }
    };
    
    // Add required location field if available
    if (venue) {
        sportsEventSchema.location = venue;
    }
    
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
            "sport": post.league
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
        url: articleUrl,
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
