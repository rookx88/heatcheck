import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { escapeHtml } from '../utils/html-escape';
import { formatDateISO, normalizeLeague } from '../utils/date-formatter';

export interface DFSPlayerAnalysis {
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
}

export interface DFSHeatcheckPost {
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
        dfsPlayers?: DFSPlayerAnalysis[];
        article?: {
            long_form_markdown?: string;
        };
    };
    heatchecksEdge?: {
        finalCall?: string;
    };
}

/**
 * Generate DFS article page HTML
 */
export function generateDFSArticlePage(
    post: DFSHeatcheckPost,
    relatedPosts: DFSHeatcheckPost[],
    baseUrl: string = 'https://heatchecks.io'
): string {
    const league = normalizeLeague(post.league);
    const date = post.matchupScheduledDate 
        ? formatDateISO(post.matchupScheduledDate)
        : formatDateISO(post.createdAt);
    
    // Extract DFS players
    const heatCheckData = post.heatCheckData || {};
    const dfsPlayers = heatCheckData.dfsPlayers || [];
    
    // For DFS articles, we don't display the markdown content - only player cards
    
    // Get image path
    const imageName = post.websiteStory.image || post.websiteStory.imageUrl || '';
    const imagePath = imageName 
        ? (imageName.startsWith('http') 
            ? imageName 
            : imageName.startsWith('/')
            ? imageName
            : imageName.includes('/assets/images/')
            ? (() => {
                const parts = imageName.split('/assets/images/');
                const filename = parts.length > 1 ? parts[parts.length - 1] : imageName.split('/').pop();
                return `/assets/images/${filename}`;
            })()
            : `/assets/images/${imageName}`)
        : '';
    
    // Generate player cards HTML
    const playerCardsHtml = dfsPlayers.map(player => {
        const getTypeColor = (type: string) => {
            if (type.includes('Revenge') || type.includes('Homecoming')) return '#f84242';
            if (type.includes('Pace') || type.includes('Scheme')) return '#00ff41';
            if (type.includes('Game Script') || type.includes('Vegas')) return '#00a8ff';
            if (type.includes('Shadow')) return '#fbbf24';
            return '#cccccc';
        };
        
        const color = getTypeColor(player.narrativeType);
        
        return `
            <div style="padding: 1rem; margin-bottom: 1rem; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); border-left: 3px solid ${color}; font-family: 'Courier New', monospace;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem;">
                    <div>
                        <div style="color: ${color}; font-size: 0.8rem; font-weight: bold; margin-bottom: 0.25rem;">
                            #${player.rank} // ${escapeHtml(player.position)}
                        </div>
                        <h3 style="font-size: 1.2rem; margin: 0.2rem 0; text-transform: uppercase; line-height: 1.1; color: rgba(255, 255, 255, 0.95);">
                            ${escapeHtml(player.playerName)}
                        </h3>
                        <div style="font-size: 0.8rem; color: rgba(255, 255, 255, 0.6); margin-top: 0.25rem;">
                            ${escapeHtml(player.team)} vs ${escapeHtml(player.opponent)}
                        </div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-size: 1.1rem; color: #fff; font-weight: bold; margin-bottom: 0.25rem;">
                            $${escapeHtml(String(player.salary))}
                        </div>
                        <div style="font-size: 0.7rem; color: ${color};">
                            CONFIDENCE: ${player.confidenceScore}%
                        </div>
                    </div>
                </div>
                
                <div style="display: flex; alignItems: center; gap: 0.5rem; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px dashed rgba(255, 255, 255, 0.2);">
                    <div style="padding: 0.25rem 0.5rem; background: rgba(0, 0, 0, 0.3); border: 1px solid ${color}; color: ${color}; font-size: 0.7rem; border-radius: 3px;">
                        ${escapeHtml(player.narrativeType)}
                    </div>
                    ${player.keyStat ? (
                        `<div style="margin-left: auto; font-size: 0.7rem; color: #fff;">
                            ${escapeHtml(player.keyStat)}
                        </div>`
                    ) : ''}
                </div>
                
                <div style="font-size: 0.85rem; line-height: 1.5; color: rgba(255, 255, 255, 0.8);">
                    <span style="color: ${color}; margin-right: 0.5rem;">&gt;</span>
                    ${escapeHtml(player.analysis)}
                </div>
            </div>
        `;
    }).join('');
    
    // Generate breadcrumb navigation
    const breadcrumbItems = [
        { name: 'Home', url: `${baseUrl}/` },
        { name: 'DFS', url: `${baseUrl}/dfs/` },
        { name: post.league.toUpperCase(), url: `${baseUrl}/dfs/${league}/` },
        { name: date, url: `${baseUrl}/dfs/${league}/${date}/` },
        { name: post.websiteStory.headline.substring(0, 40) + (post.websiteStory.headline.length > 40 ? '...' : ''), url: null }
    ];
    
    const breadcrumbHtml = `
        <nav aria-label="Breadcrumb" style="margin-bottom: 1.5rem; padding: 0.75rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1); font-family: 'Courier New', monospace; font-size: 0.75rem; width: 100%; box-sizing: border-box;">
            <ol style="list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem;">
                ${breadcrumbItems.map((item, index) => `
                    <li style="display: inline-flex; align-items: center;">
                        ${index > 0 ? '<span style="color: rgba(255, 255, 255, 0.4); margin: 0 0.5rem;">▶</span>' : ''}
                        ${!item.url || index === breadcrumbItems.length - 1
                            ? `<span style="color: ${index === breadcrumbItems.length - 1 ? '#ff0040' : 'rgba(255, 255, 255, 0.7)'}; font-weight: ${index === breadcrumbItems.length - 1 ? '600' : 'normal'};">${escapeHtml(item.name)}</span>`
                            : `<a href="${item.url}" style="color: rgba(255, 255, 255, 0.7); text-decoration: none; transition: color 0.2s ease;" onmouseover="this.style.color='#ff0040';" onmouseout="this.style.color='rgba(255, 255, 255, 0.7)';">${escapeHtml(item.name)}</a>`
                        }
                    </li>
                `).join('')}
            </ol>
        </nav>
    `;
    
    // Redesign player cards for square grid layout
    const playerCardsGridHtml = dfsPlayers.map(player => {
        const getTypeColor = (type: string) => {
            if (type.includes('Revenge') || type.includes('Homecoming')) return '#f84242';
            if (type.includes('Pace') || type.includes('Scheme')) return '#00ff41';
            if (type.includes('Game Script') || type.includes('Vegas')) return '#00a8ff';
            if (type.includes('Shadow')) return '#fbbf24';
            return '#cccccc';
        };
        
        const color = getTypeColor(player.narrativeType);
        
        return `
            <div style="aspect-ratio: 3/4; padding: 0.75rem; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); border-left: 4px solid ${color}; font-family: 'Courier New', monospace; display: flex; flex-direction: column;">
                <div style="flex: 0 0 auto;">
                    <div style="color: ${color}; font-size: 0.75rem; font-weight: bold; margin-bottom: 0.25rem;">
                        #${player.rank} // ${escapeHtml(player.position)}
                    </div>
                    <h3 style="font-size: 1rem; margin: 0 0 0.25rem 0; text-transform: uppercase; line-height: 1.2; color: rgba(255, 255, 255, 0.95); font-weight: bold;">
                        ${escapeHtml(player.playerName)}
                    </h3>
                    <div style="font-size: 0.75rem; color: rgba(255, 255, 255, 0.6); margin-bottom: 0.4rem;">
                        ${escapeHtml(player.team)} vs ${escapeHtml(player.opponent)}
                    </div>
                    <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; padding-bottom: 0.4rem; border-bottom: 1px dashed rgba(255, 255, 255, 0.2);">
                        <span style="color: ${color}; border: 1px solid ${color}; padding: 0.2rem 0.4rem; font-size: 0.65rem; border-radius: 3px;">
                            ${escapeHtml(player.narrativeType)}
                        </span>
                        ${player.keyStat ? `<span style="font-size: 0.65rem; color: #fff;">${escapeHtml(player.keyStat)}</span>` : ''}
                    </div>
                </div>
                <div style="flex: 1 1 auto; display: flex; flex-direction: column; justify-content: flex-start; min-height: 0;">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem; flex-shrink: 0;">
                        <div style="font-size: 0.9rem; color: #fff; font-weight: bold;">$${escapeHtml(String(player.salary))}</div>
                        <div style="font-size: 0.7rem; color: ${color}; font-weight: bold;">${player.confidenceScore}%</div>
                    </div>
                    <div style="font-size: 0.75rem; line-height: 1.4; color: rgba(255, 255, 255, 0.8); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; flex: 1 1 auto; min-height: 0;">
                        <span style="color: ${color}; margin-right: 0.3rem;">&gt;</span>
                        ${escapeHtml(player.analysis)}
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    // Main content - Single column grid layout with semantic HTML
    const content = `
        ${breadcrumbHtml}
        <article>
            <section style="background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); box-shadow: inset 0 0 20px rgba(255, 255, 255, 0.05), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); padding: 1.5rem; margin-bottom: 1.5rem; width: 100%; box-sizing: border-box;">
                <div style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.15); display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1.5rem;">
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);"></div>
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; margin-left: 0.5rem; letter-spacing: 0.1em;">DFS_ANALYSIS.log</div>
                </div>
                <nav aria-label="Breadcrumb navigation">
                    <a href="/dfs/" style="display: inline-block; margin-bottom: 1.5rem; padding: 0.4rem 0.8rem; background: #000; border: 1px solid #f84242; color: #f84242; text-decoration: none; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.9rem; transition: all 0.3s ease;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.8)';" onmouseout="this.style.background='#000'; this.style.borderColor='#f84242';">← BACK TO DFS HUB</a>
                </nav>
                <header style="margin-bottom: 2rem; border-bottom: 1px dashed rgba(255, 255, 255, 0.3); padding-bottom: 1rem;">
                    <h1 style="color: rgba(255, 255, 255, 0.95); font-size: 1.5rem; margin-bottom: 0.5rem; font-weight: bold; line-height: 1.3; font-family: 'Courier New', monospace;">${escapeHtml(post.websiteStory.headline)}</h1>
                    <p style="color: rgba(255, 255, 255, 0.6); font-size: 0.9rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace;">// ${escapeHtml(post.websiteStory.dek)}</p>
                    <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.8rem; font-family: 'Courier New', monospace;">&gt; LEAGUE: ${escapeHtml(post.league.toUpperCase())} | DATE: <time datetime="${post.matchupScheduledDate || post.createdAt}">${escapeHtml(date)}</time></div>
                </header>
                ${imagePath ? `
                <div style="margin-bottom: 2rem; border: 1px solid rgba(255, 255, 255, 0.2); padding: 0.5rem; background: rgba(255, 255, 255, 0.03);">
                    <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.75rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold;">&gt; IMAGE_ASSET [LOADED]</div>
                    <img src="${imagePath}" alt="${escapeHtml(`${post.league.toUpperCase()} DFS Value Plays - ${post.websiteStory.headline} | Daily Fantasy Sports Analysis | HeatChecks`)}" class="heatcheck-header-image" style="width: 100%; max-height: 400px; object-fit: contain; display: block; border: 1px dashed rgba(255, 255, 255, 0.2);">
                </div>
                ` : ''}
            </section>
            
            <!-- Player Cards Grid -->
            <section aria-label="Top Value Plays" style="margin-bottom: 2rem; width: 100%; box-sizing: border-box; padding-left: 1.5rem; padding-right: 1.5rem;">
                <h2 style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(248, 66, 66, 0.3); display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; color: rgba(255, 255, 255, 0.9); font-size: 0.85rem; font-family: 'Courier New', monospace; letter-spacing: 0.1em; font-weight: bold; margin-top: 0; margin-left: 0; margin-right: 0;">
                    <div style="width: 6px; height: 6px; background: rgba(248, 66, 66, 0.8); border-radius: 50%; box-shadow: 0 0 6px rgba(248, 66, 66, 0.5);"></div>
                    TOP_VALUE_PLAYS [${dfsPlayers.length}]
                </h2>
                <ol style="display: grid; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap: 1rem; list-style: none; padding: 0; margin: 0; width: 100%; box-sizing: border-box;">
                    ${dfsPlayers.map((player, index) => {
                        const getTypeColor = (type: string) => {
                            if (type.includes('Revenge') || type.includes('Homecoming')) return '#f84242';
                            if (type.includes('Pace') || type.includes('Scheme')) return '#00ff41';
                            if (type.includes('Game Script') || type.includes('Vegas')) return '#00a8ff';
                            if (type.includes('Shadow')) return '#fbbf24';
                            return '#cccccc';
                        };
                        const color = getTypeColor(player.narrativeType);
                        return `
                        <li style="aspect-ratio: 3/4; padding: 0.75rem; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(255, 255, 255, 0.2); border-left: 4px solid ${color}; font-family: 'Courier New', monospace; display: flex; flex-direction: column;">
                            <div style="flex: 0 0 auto;">
                                <div style="color: ${color}; font-size: 0.75rem; font-weight: bold; margin-bottom: 0.25rem;">
                                    #${player.rank} // ${escapeHtml(player.position)}
                                </div>
                                <h3 style="font-size: 1rem; margin: 0 0 0.25rem 0; text-transform: uppercase; line-height: 1.2; color: rgba(255, 255, 255, 0.95); font-weight: bold;">
                                    ${escapeHtml(player.playerName)}
                                </h3>
                                <div style="font-size: 0.75rem; color: rgba(255, 255, 255, 0.6); margin-bottom: 0.4rem;">
                                    ${escapeHtml(player.team)} vs ${escapeHtml(player.opponent)}
                                </div>
                                <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; padding-bottom: 0.4rem; border-bottom: 1px dashed rgba(255, 255, 255, 0.2);">
                                    <span style="color: ${color}; border: 1px solid ${color}; padding: 0.2rem 0.4rem; font-size: 0.65rem; border-radius: 3px;">
                                        ${escapeHtml(player.narrativeType)}
                                    </span>
                                    ${player.keyStat ? `<span style="font-size: 0.65rem; color: #fff;">${escapeHtml(player.keyStat)}</span>` : ''}
                                </div>
                            </div>
                            <div style="flex: 1 1 auto; display: flex; flex-direction: column; justify-content: flex-start; min-height: 0;">
                                <dl style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem; flex-shrink: 0; margin: 0;">
                                    <dt style="font-size: 0.9rem; color: #fff; font-weight: bold; margin: 0;">Salary:</dt>
                                    <dd style="font-size: 0.9rem; color: #fff; font-weight: bold; margin: 0;">$${escapeHtml(String(player.salary))}</dd>
                                    <dt style="font-size: 0.7rem; color: ${color}; font-weight: bold; margin: 0;">Confidence:</dt>
                                    <dd style="font-size: 0.7rem; color: ${color}; font-weight: bold; margin: 0;">${player.confidenceScore}%</dd>
                                </dl>
                                <p style="font-size: 0.75rem; line-height: 1.4; color: rgba(255, 255, 255, 0.8); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; flex: 1 1 auto; min-height: 0; margin: 0;">
                                    <span style="color: ${color}; margin-right: 0.3rem;">&gt;</span>
                                    ${escapeHtml(player.analysis)}
                                </p>
                            </div>
                        </li>
                    `;
                    }).join('')}
                </ol>
            </section>
        </article>
        
        <!-- Internal Navigation -->
        <nav aria-label="Internal navigation" style="margin-top: 2rem; padding: 1rem; background: rgba(255, 255, 255, 0.03); border: 1px solid rgba(255, 255, 255, 0.2); width: 100%; box-sizing: border-box;">
            <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.85rem; font-family: 'Courier New', monospace; margin-bottom: 0.5rem;">&gt; INTERNAL_NAVIGATION</div>
            <a href="/dfs/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; margin-right: 1rem; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.5)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='rgba(255, 255, 255, 0.85)';">DFS Hub</a>
            <a href="/dfs/${league}/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; margin-right: 1rem; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.5)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='rgba(255, 255, 255, 0.85)';">${post.league.toUpperCase()} DFS</a>
            <a href="/archive/" style="color: rgba(255, 255, 255, 0.85); text-decoration: none; padding: 0.3rem 0.6rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace; font-size: 0.8rem; transition: all 0.2s ease; display: inline-block; margin-bottom: 0.5rem;" onmouseover="this.style.background='rgba(248, 66, 66, 0.2)'; this.style.borderColor='rgba(248, 66, 66, 0.5)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0, 0, 0, 0.3)'; this.style.borderColor='rgba(255, 255, 255, 0.2)'; this.style.color='rgba(255, 255, 255, 0.85)';">Archive</a>
        </nav>
    `;
    
    // Generate Schema.org JSON-LD
    const schemaOrg = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": post.websiteStory.headline,
        "description": post.websiteStory.dek,
        "image": imagePath ? (imagePath.startsWith('http') ? imagePath : `${baseUrl}${imagePath}`) : `${baseUrl}/images/default-og-image.jpg`,
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
            "url": baseUrl,
            "logo": {
                "@type": "ImageObject",
                "url": `${baseUrl}/images/HeatChecksMainLogo.svg`
            }
        },
        "mainEntityOfPage": {
            "@type": "WebPage",
            "@id": `${baseUrl}/dfs/${league}/${date}/dfs-value-narratives-${date}/`
        },
        "articleSection": "DFS"
    };
    
    // Generate ItemList schema for player rankings
    const itemListSchema = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        "name": `Top ${dfsPlayers.length} ${post.league.toUpperCase()} DFS Value Plays`,
        "description": `Ranked list of top DFS value plays with narrative angles for ${post.league.toUpperCase()} slate`,
        "numberOfItems": dfsPlayers.length,
        "itemListElement": dfsPlayers.map((player, index) => ({
            "@type": "ListItem",
            "position": index + 1,
            "item": {
                "@type": "Person",
                "name": player.playerName,
                "jobTitle": player.position,
                "memberOf": {
                    "@type": "SportsTeam",
                    "name": player.team
                },
                "description": `${player.playerName} - ${player.position} for ${player.team} vs ${player.opponent}. ${player.narrativeType} narrative. Salary: $${player.salary}, Confidence: ${player.confidenceScore}%`
            }
        }))
    };
    
    // Generate FAQPage schema for common DFS questions
    const faqSchema = {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        "mainEntity": [
            {
                "@type": "Question",
                "name": `What are the best ${post.league.toUpperCase()} DFS value plays today?`,
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": `Our analysis identifies ${dfsPlayers.length} top value plays for today's ${post.league.toUpperCase()} DFS slate, focusing on narrative angles including ${[...new Set(dfsPlayers.map(p => p.narrativeType))].slice(0, 3).join(', ')}.`
                }
            },
            {
                "@type": "Question",
                "name": `Who are the top ${post.league.toUpperCase()} DFS sleepers for today's slate?`,
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": `Based on our narrative-driven analysis, key sleepers include players with ${dfsPlayers.filter(p => p.confidenceScore < 70).length > 0 ? 'lower ownership but strong narrative angles' : 'value pricing and favorable matchups'}.`
                }
            },
            {
                "@type": "Question",
                "name": `What DFS strategy should I use for ${post.league.toUpperCase()}?`,
                "acceptedAnswer": {
                    "@type": "Answer",
                    "text": `Our narrative-based DFS strategy focuses on identifying value plays through revenge games, pace advantages, game script analysis, and matchup-specific narratives. This approach helps find players with both statistical upside and emotional motivation.`
                }
            }
        ]
    };
    
    // Generate HowTo schema for DFS strategy
    const howToSchema = {
        "@context": "https://schema.org",
        "@type": "HowTo",
        "name": `How to Build a Winning ${post.league.toUpperCase()} DFS Lineup Using Narrative Angles`,
        "description": `Step-by-step guide to building DFS lineups using narrative-driven player selection`,
        "step": [
            {
                "@type": "HowToStep",
                "position": 1,
                "name": "Identify Narrative Angles",
                "text": "Look for revenge games, homecoming spots, pace advantages, and game script factors that create value opportunities."
            },
            {
                "@type": "HowToStep",
                "position": 2,
                "name": "Target Value Plays",
                "text": `Focus on players with favorable pricing (like our top ${dfsPlayers.length} value plays) that align with narrative angles.`
            },
            {
                "@type": "HowToStep",
                "position": 3,
                "name": "Consider Confidence Scores",
                "text": "Use confidence scores to balance risk. Higher confidence plays provide stability, while lower confidence plays offer tournament upside."
            },
            {
                "@type": "HowToStep",
                "position": 4,
                "name": "Build Balanced Lineups",
                "text": "Combine narrative-driven value plays with core plays and leverage spots to create optimal tournament and cash game lineups."
            }
        ]
    };
    
    // Enhanced meta description with DFS keywords
    let metaDescription = post.websiteStory.dek || '';
    const leagueUpper = post.league.toUpperCase();
    const dfsKeywords = `DFS picks, daily fantasy sports, DFS value plays, DFS lineup, DFS strategy`;
    const leagueSpecificKeywords = `${leagueUpper} DFS, ${leagueUpper} DFS picks, ${leagueUpper} DFS value plays`;
    
    if (metaDescription.length > 160) {
        metaDescription = metaDescription.substring(0, 157) + '...';
    } else if (metaDescription.length < 120) {
        metaDescription = `${metaDescription} Top ${dfsPlayers.length} ${leagueUpper} DFS value plays with narrative angles and strategic insights for today's slate.`;
        if (metaDescription.length > 160) {
            metaDescription = metaDescription.substring(0, 157) + '...';
        }
    } else {
        // Add DFS keywords if there's room
        const enhancedDesc = `${metaDescription} ${leagueSpecificKeywords}.`;
        if (enhancedDesc.length <= 160) {
            metaDescription = enhancedDesc;
        }
    }
    
    // Enhanced title tag with league and DFS keywords
    const dayOfWeek = (() => {
        try {
            const dateForDay = new Date(post.matchupScheduledDate || post.createdAt);
            return dateForDay.toLocaleDateString('en-US', { weekday: 'long' });
        } catch {
            return '';
        }
    })();
    
    let title = post.websiteStory.headline;
    if (title.length > 50) {
        title = `${title.substring(0, 50)}... | ${leagueUpper} DFS | HeatChecks`;
    } else {
        title = `${title} | ${leagueUpper} DFS | HeatChecks`;
    }
    
    // Generate keywords for meta tag
    const narrativeTypes = [...new Set(dfsPlayers.map(p => p.narrativeType))];
    const keywords = [
        'DFS picks',
        'daily fantasy sports',
        'DFS value plays',
        'DFS lineup',
        'DFS strategy',
        `${leagueUpper} DFS`,
        `${leagueUpper} DFS picks`,
        'DFS sleepers',
        'DFS cash game',
        'DFS tournament',
        ...narrativeTypes.map(t => `${t} DFS strategy`)
    ].join(', ');
    
    // Generate BreadcrumbList schema.org structured data
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
        url: `${baseUrl}/dfs/${league}/${date}/dfs-value-narratives-${date}/`,
        baseUrl,
        ogImage: imagePath ? (imagePath.startsWith('http') ? imagePath : `${baseUrl}${imagePath}`) : `${baseUrl}/images/default-og-image.jpg`,
        ogType: 'article',
        keywords: keywords,
        articleMeta: {
            publishedTime: post.createdAt,
            modifiedTime: post.updatedAt,
            author: 'HeatChecks',
            section: 'DFS',
            tags: ['DFS', leagueUpper, 'Value Plays', 'Narratives', ...narrativeTypes]
        },
        schemaOrg: [schemaOrg, breadcrumbSchema, itemListSchema, faqSchema, howToSchema],
        posts: [post, ...relatedPosts]
    };
    
    return generateBaseHtml(content, options);
}

