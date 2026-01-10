import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { markdownToHtml } from '../utils/markdown-converter';
import { escapeHtml } from '../utils/html-escape';
import { formatDateISO, normalizeLeague } from '../utils/date-formatter';
import { generateSlug } from '../utils/slug-generator';

export interface HeatcheckPost {
    id: string;
    league: string;
    teamA: string;
    teamB: string;
    matchupScheduledDate?: string;
    createdAt: string;
    updatedAt: string;
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
        article?: {
            long_form_markdown?: string;
        };
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
    const slug = post.websiteStory.seo?.slug || generateSlug(post.websiteStory.headline);
    const articleUrl = `${baseUrl}/${league}/${date}/${slug}.html`;
    
    const heatCheckData = post.heatCheckData || {};
    const narratives = heatCheckData.narratives || {};
    const candidateCards = narratives.candidate_cards || [];
    const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
    const evidenceBundle = heatCheckData.evidenceBundle || heatCheckData.evidence_bundle || {};
    const quotes = evidenceBundle.quotes || [];
    const timelineEvents = evidenceBundle.timeline_events || [];
    
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
    const quotesHtml = quotes.map(quote => `
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
    
    // Generate related articles HTML
    const relatedArticlesHtml = relatedPosts.slice(0, 3).map(relatedPost => {
        const relatedLeague = normalizeLeague(relatedPost.league);
        const relatedDate = relatedPost.matchupScheduledDate 
            ? formatDateISO(relatedPost.matchupScheduledDate)
            : formatDateISO(relatedPost.createdAt);
        const relatedSlug = relatedPost.websiteStory.seo?.slug || generateSlug(relatedPost.websiteStory.headline);
        const relatedUrl = `/${relatedLeague}/${relatedDate}/${relatedSlug}.html`;
        
        return `
            <div style="margin-bottom: 0.75rem; padding: 0.5rem; background: rgba(255, 255, 255, 0.03); border-left: 2px solid rgba(255, 255, 255, 0.2);">
                <a href="${relatedUrl}" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; font-family: 'Courier New', monospace; font-size: 0.8rem; line-height: 1.4; display: block; transition: all 0.2s ease;" onmouseover="this.style.color='#f84242'; this.parentElement.style.borderLeftColor='rgba(248, 66, 66, 0.6)'; this.parentElement.style.background='rgba(248, 66, 66, 0.05)';" onmouseout="this.style.color='rgba(255, 255, 255, 0.85)'; this.parentElement.style.borderLeftColor='rgba(255, 255, 255, 0.2)'; this.parentElement.style.background='rgba(255, 255, 255, 0.03)';">
                    &gt; ${escapeHtml(relatedPost.websiteStory.headline)}
                </a>
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
    
    // Main content area (two-column layout)
    const content = `
        <div style="display: grid; grid-template-columns: 2fr 1fr; grid-template-rows: auto 1fr; gap: 0.5rem; padding: 0.5rem;">
            <!-- Left Column: Main Article -->
            <div style="grid-column: 1; grid-row: 1 / -1; display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.05), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden;">
                <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.15); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);"></div>
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; margin-left: 0.5rem; letter-spacing: 0.1em;">MAIN_DOCUMENT.log</div>
                </div>
                <div style="flex: 1; overflow-y: auto; padding: 1.5rem; font-family: 'Courier New', monospace; color: rgba(255, 255, 255, 0.85); font-size: 0.95rem; line-height: 1.8; scrollbar-width: none; -ms-overflow-style: none;">
                    <style>.main-article-content::-webkit-scrollbar { display: none; }</style>
                    <a href="/" class="article-back-btn" style="display: inline-block; margin-bottom: 1rem; padding: 0.4rem 0.8rem; background: #000; border: 1px solid #f84242; color: #f84242; text-decoration: none; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.9rem; transition: all 0.3s ease;">← BACK</a>
                    <div style="margin-bottom: 2rem; border-bottom: 1px dashed rgba(255, 255, 255, 0.3); padding-bottom: 1rem;">
                        <h1 style="color: rgba(255, 255, 255, 0.95); font-size: 1.3rem; margin-bottom: 0.5rem; font-weight: bold; line-height: 1.3;">${escapeHtml(post.websiteStory.headline)}</h1>
                        <div style="color: rgba(255, 255, 255, 0.6); font-size: 0.85rem; margin-bottom: 0.5rem;">// ${escapeHtml(post.websiteStory.dek)}</div>
                        <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.8rem; font-family: 'Courier New', monospace;">&gt; MATCHUP: ${escapeHtml(post.league.toUpperCase())} | ${escapeHtml(post.teamA)} vs ${escapeHtml(post.teamB)}</div>
                    </div>
                    ${imagePath ? `
                    <div style="margin-bottom: 2rem; border: 1px solid rgba(255, 255, 255, 0.2); padding: 0.5rem; background: rgba(255, 255, 255, 0.03);">
                        <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.75rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold;">&gt; IMAGE_ASSET [LOADED]</div>
                        <img src="${imagePath}" alt="${escapeHtml(post.websiteStory.headline)}" class="heatcheck-header-image" style="width: 100%; max-height: 400px; object-fit: contain; display: block; border: 1px dashed rgba(255, 255, 255, 0.2);">
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
            </div>
            
            <!-- Right Column: Narrative Rack & Evidence Board -->
            <div style="grid-column: 2; grid-row: 1 / -1; display: flex; flex-direction: column; gap: 0.5rem; overflow: hidden;">
                <!-- Narrative Rack -->
                <div style="flex: 1 1 50%; display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.05), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden; min-height: 0;">
                    <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(248, 66, 66, 0.3); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                        <div style="width: 6px; height: 6px; background: rgba(248, 66, 66, 0.8); border-radius: 50%; box-shadow: 0 0 6px rgba(248, 66, 66, 0.5);"></div>
                        <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; letter-spacing: 0.1em; font-weight: bold;">NARRATIVE_RACK [SLOT_ACTIVE]</div>
                    </div>
                    <div style="flex: 1; overflow-y: auto; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; scrollbar-width: none; -ms-overflow-style: none;">
                        <style>div[style*="overflow-y"]::-webkit-scrollbar { display: none; }</style>
                        ${narrativeCardsHtml || '<div style="color: #666; font-size: 0.75rem;">No narrative cards available</div>'}
                    </div>
                </div>
                
                <!-- Evidence Board -->
                <div style="flex: 1 1 50%; display: flex; flex-direction: column; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.05), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden; min-height: 0;">
                    <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(248, 66, 66, 0.3); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                        <div style="width: 6px; height: 6px; background: rgba(248, 66, 66, 0.8); border-radius: 50%; box-shadow: 0 0 6px rgba(248, 66, 66, 0.5);"></div>
                        <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; letter-spacing: 0.1em; font-weight: bold;">EVIDENCE_RACK [DATA_STREAM]</div>
                    </div>
                    <div style="flex: 1; overflow-y: auto; padding: 0.75rem; display: flex; flex-direction: column; gap: 0.5rem; scrollbar-width: none; -ms-overflow-style: none;">
                        <style>div[style*="overflow-y"]::-webkit-scrollbar { display: none; }</style>
                        ${quotes.length > 0 ? `
                        <div>
                            <div style="color: rgba(248, 66, 66, 0.9); font-size: 0.75rem; margin-bottom: 0.5rem; font-weight: bold; border-bottom: 1px dashed rgba(248, 66, 66, 0.3); padding-bottom: 0.25rem;">&gt; QUOTE_LOG [ENTRIES: ${quotes.length}]</div>
                            ${quotesHtml}
                        </div>
                        ` : ''}
                        ${timelineEvents.length > 0 ? `
                        <div style="margin-top: ${quotes.length > 0 ? '0.5rem' : '0'};">
                            <div style="color: rgba(248, 66, 66, 0.9); font-size: 0.75rem; margin-bottom: 0.5rem; font-weight: bold; border-bottom: 1px dashed rgba(248, 66, 66, 0.3); padding-bottom: 0.25rem;">&gt; TIMELINE_LOG [ENTRIES: ${timelineEvents.length}]</div>
                            ${timelineHtml}
                        </div>
                        ` : ''}
                        ${quotes.length === 0 && timelineEvents.length === 0 ? '<div style="color: #666; font-size: 0.75rem;">No evidence data available</div>' : ''}
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Internal Navigation & Related Articles -->
        <div style="margin-top: 2rem; padding: 1rem; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.2);">
            <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.5rem;">&gt; INTERNAL_NAVIGATION</div>
            <a href="/${league}/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; margin-right: 1rem; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.5)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='rgba(255, 255, 255, 0.85)';">${post.league.toUpperCase()} Hub</a>
            <a href="/${league}/${date}/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; margin-right: 1rem; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.5)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='rgba(255, 255, 255, 0.85)';">${date}</a>
            <a href="/archive/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.5)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='rgba(255, 255, 255, 0.85)';">Archive</a>
        </div>
        ${relatedPosts.length > 0 ? `
        <div style="margin-top: 2rem; padding: 1rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1);">
            <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.75rem;">&gt; RELATED_ARTICLES</div>
            ${relatedArticlesHtml}
        </div>
        ` : ''}
    `;
    
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
    
    const sportsEventSchema = {
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
        "startDate": post.matchupScheduledDate || post.createdAt
    };
    
    const options: BaseTemplateOptions = {
        title: `${post.websiteStory.headline} | ${post.league} ${date} | HeatChecks`,
        description: post.websiteStory.dek,
        url: articleUrl,
        baseUrl,
        ogImage: imagePath || `${baseUrl}/images/default-og-image.jpg`,
        ogType: 'article',
        articleMeta: {
            publishedTime: post.createdAt,
            modifiedTime: post.updatedAt,
            author: 'HeatChecks',
            section: post.league
        },
        schemaOrg: [schemaOrg, sportsEventSchema],
        posts: [post, ...relatedPosts]
    };
    
    return generateBaseHtml(content, options);
}
