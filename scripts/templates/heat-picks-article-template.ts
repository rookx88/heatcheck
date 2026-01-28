import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { escapeHtml } from '../utils/html-escape';
import { formatDateISO, normalizeLeague, getShortTeamName } from '../utils/date-formatter';
import { generateMatchupSlug, generateNarrativeSlug } from '../utils/slug-generator';

export interface HeatPick {
    matchup: string;
    pickType: string;
    pick: string;
    heatScore: number;
    signalsHit: Array<{ signalKey: string; evidence: string }>;
    narrativesUsed: Array<{ type: string; strength: number; direction: string; whyItFitsData: string }>;
    marketLag: string;
    evidenceChart: { chartId: string; chartType: string; dataSource: string; questionAnswered: string } | null;
    whyHot: string[];
    riskNote: string;
    chartCaption?: string;
}

export interface HeatPicksData {
    date: string;
    sport: string;
    heatPicks: HeatPick[];
    warmLeans?: HeatPick[];
    noHeatZone?: Array<{ matchup: string; whyNot: string }>;
}

export interface HeatPicksHeatcheckPost {
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
        heatPicks?: HeatPicksData;
        chartCatalog?: Record<string, any[]>;
        matchPacks?: Array<{ teamA: string; teamB: string; matchPackV3: any }>;
    };
}

/**
 * Generate Heat Picks article page HTML
 */
export function generateHeatPicksArticlePage(
    post: HeatPicksHeatcheckPost,
    relatedPosts: HeatPicksHeatcheckPost[],
    baseUrl: string = 'https://heatchecks.io',
    allPosts: HeatPicksHeatcheckPost[] = []
): string {
    const league = normalizeLeague(post.league);
    const date = post.matchupScheduledDate 
        ? formatDateISO(post.matchupScheduledDate)
        : formatDateISO(post.createdAt);
    
    // Format date as MM-DD-YYYY for title
    const dateForTitle = (() => {
        const dateObj = new Date(date + 'T12:00:00');
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getDate()).padStart(2, '0');
        const year = dateObj.getFullYear();
        return `${month}-${day}-${year}`;
    })();
    
    // Generate title: "Heat Forecast: [League] Heat Picks MM-DD-YYYY"
    // Use SEO meta title if available, otherwise generate from template
    const seoTitle = post.websiteStory?.seo?.metaTitle || '';
    const title = seoTitle || `Heat Forecast: ${post.league.toUpperCase()} Heat Picks ${dateForTitle} | HeatChecks`;
    
    // Get meta description - use SEO meta description if available, otherwise use dek
    const seoDescription = post.websiteStory?.seo?.metaDescription || '';
    const metaDescription = seoDescription || post.websiteStory?.dek || `Daily ${post.league.toUpperCase()} Heat Picks for ${dateForTitle} - Data-driven betting picks backed by narrative analysis and market lag detection.`;
    
    // Ensure meta description is optimal length (150-160 characters)
    let finalMetaDescription = metaDescription;
    if (finalMetaDescription.length > 160) {
        finalMetaDescription = finalMetaDescription.substring(0, 157) + '...';
    } else if (finalMetaDescription.length < 120) {
        finalMetaDescription = `${finalMetaDescription} Get the hottest ${post.league.toUpperCase()} betting picks for ${dateForTitle} with data-driven analysis.`;
        if (finalMetaDescription.length > 160) {
            finalMetaDescription = finalMetaDescription.substring(0, 157) + '...';
        }
    }
    
    // Extract Heat Picks data
    const heatCheckData = post.heatCheckData || {};
    const heatPicksData: HeatPicksData = heatCheckData.heatPicks || {
        date: date,
        sport: post.league,
        heatPicks: [],
        warmLeans: [],
        noHeatZone: []
    };

    const heatPicks = heatPicksData.heatPicks || [];
    const warmLeans = heatPicksData.warmLeans || [];
    const noHeatZone = heatPicksData.noHeatZone || [];

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

    // Generate article URL - use stored slug if available
    const storedSlug = post.websiteStory?.seo?.slug || '';
    let articleUrl: string;
    if (storedSlug) {
        articleUrl = `${baseUrl}/${league}/${storedSlug}/`;
    } else {
        // Fallback: generate from date
        const dateParts = date.split('-');
        const slugDate = `${dateParts[1]}-${dateParts[2]}-${dateParts[0]}`;
        articleUrl = `${baseUrl}/${league}/heat-picks-today-${slugDate}/`;
    }

    // Generate breadcrumb navigation
    const breadcrumbItems = [
        { name: 'Home', url: `${baseUrl}/` },
        { name: post.league.toUpperCase(), url: `${baseUrl}/${league}/` },
        { name: date, url: `${baseUrl}/${league}/${date}/` },
        { name: 'Heat Picks Report', url: null }
    ];
    
    const breadcrumbHtml = `
        <nav aria-label="Breadcrumb" style="margin-bottom: 1.5rem; padding: 0.75rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.1); font-family: 'Courier New', monospace; font-size: 0.75rem;">
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

    // Generate Heat Pick block HTML (Weather Report Style)
    const generateHeatPickBlock = (pick: HeatPick, index: number, isWarmLean: boolean = false) => {
        const chartId = `heat-pick-chart-${index}`;
        const chartDataId = `heat-pick-chart-data-${index}`;
        const matchPack = heatCheckData.matchPacks?.find(mp => 
            pick.matchup.includes(mp.teamA) && pick.matchup.includes(mp.teamB)
        );
        const chartCatalog = matchPack ? heatCheckData.chartCatalog?.[`${matchPack.teamA}-${matchPack.teamB}`] : [];
        const selectedChart = chartCatalog?.find(c => c.chartId === pick.evidenceChart?.chartId);

        // Generate chart data if available
        // Use pre-generated charts from factDrop if available (same as regular articles)
        // Otherwise, generate from teamForm data
        let chartDataScript = '';
        let chartCanvas = '';
        if (pick.evidenceChart && matchPack?.matchPackV3) {
            const matchPackV3 = matchPack.matchPackV3;
            const factDrop = matchPackV3.factDrop || {};
            
            // First, try to use pre-generated charts (same format as regular articles)
            const preGeneratedCharts: any = factDrop.charts || null;
            let chartPayload: any = {};
            let hasData = false;
            
            // If pre-generated charts exist, use momentumLine from them
            if (preGeneratedCharts && preGeneratedCharts.momentumLine) {
                chartPayload = {
                    momentumLine: preGeneratedCharts.momentumLine
                };
                hasData = true;
            } else {
                // If no pre-generated charts, generate from teamForm data
                const teamForm = factDrop.raw?.teamForm || {};
            
            if (pick.evidenceChart.chartId === 'rolling_margin_last10') {
                // Rolling margin trend
                const aMargins = teamForm.A?.margins || teamForm.A?.xgDiff || [];
                const bMargins = teamForm.B?.margins || teamForm.B?.xgDiff || [];
                    if (aMargins.length > 0 || bMargins.length > 0) {
                chartPayload = {
                    momentumLine: {
                        series: {
                            A: { margins: aMargins, label: matchPack.teamA },
                            B: { margins: bMargins, label: matchPack.teamB }
                        }
                    }
                };
                        hasData = true;
                    }
                }
            }

            if (hasData && chartPayload && chartPayload.momentumLine) {
                const chartJson = JSON.stringify(chartPayload).replace(/</g, '\\u003c');
                chartDataScript = `<script type="application/json" id="${chartDataId}">${chartJson}</script>`;
                chartCanvas = `
                    <div style="margin-top: 0.5rem; height: 150px; position: relative;">
                        <canvas id="${chartId}" style="width: 100%; height: 100%;"></canvas>
                    </div>
                <script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js"></script>
                ${chartDataScript}
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
                    function go(){
                        try {
                            var dataEl = document.getElementById('${chartDataId}');
                                if (!dataEl) {
                                    if (tries++ < 60) return setTimeout(go, 50);
                                    console.warn('[Heat Pick Chart] Data element not found');
                                    return;
                                }
                            var payload = JSON.parse(dataEl.textContent || '{}');
                            if (!payload || !window.Chart) {
                                if (tries++ < 60) return setTimeout(go, 50);
                                    console.warn('[Heat Pick Chart] Chart.js not loaded or no payload');
                                return;
                            }
                            // Extract momentumLine from payload
                            var m = payload.momentumLine || null;
                            
                            if (m && m.series) {
                                var a = (m.series.A && (m.series.A.margins || m.series.A.xgDiff)) || [];
                                var b = (m.series.B && (m.series.B.margins || m.series.B.xgDiff)) || [];
                                var aLabel = (m.series.A && m.series.A.label) || 'A';
                                var bLabel = (m.series.B && m.series.B.label) || 'B';
                                var len = Math.max(a.length, b.length, 1);
                                var labels = buildLabels(len);
                                var ctx = document.getElementById('${chartId}');
                                if (ctx && (a.length > 0 || b.length > 0)) {
                                    new Chart(ctx, {
                                        type: 'line',
                                        data: {
                                            labels: labels,
                                            datasets: [
                                                { label: aLabel, data: padFront(a, len), borderColor: 'rgba(255,26,26,0.95)', backgroundColor: 'rgba(255,26,26,0.15)', tension: 0.25, pointRadius: 0, borderWidth: 2 },
                                                { label: bLabel, data: padFront(b, len), borderColor: 'rgba(255,230,109,0.95)', backgroundColor: 'rgba(255,230,109,0.12)', tension: 0.25, pointRadius: 0, borderWidth: 2 }
                                            ]
                                        },
                                        options: {
                                            responsive: true,
                                            maintainAspectRatio: false,
                                            animation: { duration: 0 },
                                            plugins: { 
                                                legend: { 
                                                    display: true,
                                                    position: 'top',
                                                    labels: {
                                                        color: 'rgba(255, 255, 255, 0.9)',
                                                        font: { family: 'Courier New', size: 11 },
                                                        padding: 10,
                                                        usePointStyle: true,
                                                        pointStyle: 'line'
                                                    }
                                                },
                                                tooltip: {
                                                    backgroundColor: 'rgba(0,0,0,0.92)',
                                                    borderColor: 'rgba(0,255,65,0.25)',
                                                    borderWidth: 1,
                                                    titleColor: 'rgba(255,255,255,0.92)',
                                                    bodyColor: 'rgba(255,255,255,0.85)'
                                                }
                                            },
                                            scales: {
                                                x: { ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                                y: { ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: function(ctx){ return ctx.tick && ctx.tick.value === 0 ? 'rgba(0,255,65,0.25)' : 'rgba(255,255,255,0.08)'; } } }
                                            }
                                        }
                                    });
                                    console.log('[Heat Pick Chart] Chart rendered successfully');
                                } else {
                                    console.warn('[Heat Pick Chart] Canvas not found or no data');
                                }
                            } else {
                                console.warn('[Heat Pick Chart] No momentumLine data in payload:', Object.keys(payload));
                            }
                        } catch(e) {
                                console.error('[Heat Pick Chart] Error:', e);
                            }
                    }
                    go();
                })();
                </script>
            `;
            } else {
                console.warn(`[Heat Pick Chart] No data available for chart ${pick.evidenceChart.chartId}`);
            }
        }

        // Weather report styling - brighter reds for visibility
        const tempColor = pick.heatScore >= 85 ? '#ff1a1a' : pick.heatScore >= 70 ? '#ffd700' : 'rgba(255, 255, 255, 0.7)';
        const tempLabel = pick.heatScore >= 85 ? 'SCORCHING' : pick.heatScore >= 70 ? 'WARM' : 'COOL';
        const borderColor = isWarmLean ? 'rgba(255, 230, 109, 0.6)' : '#ff3333';
        const bgGradient = isWarmLean 
            ? 'linear-gradient(135deg, rgba(255, 230, 109, 0.1) 0%, rgba(0, 0, 0, 0.4) 100%)'
            : 'linear-gradient(135deg, rgba(255, 26, 26, 0.1) 0%, rgba(0, 0, 0, 0.4) 100%)';

        // Determine chart metric label
        const getChartMetricLabel = (chartId: string, dataSource?: string): string => {
            if (chartId === 'rolling_margin_last10') {
                return dataSource?.includes('xg') || dataSource?.includes('xG') ? 'xG Difference' : 'Point Margin';
            }
            if (chartId?.includes('margin')) return 'Point Margin';
            if (chartId?.includes('xg') || chartId?.includes('xG')) return 'xG Difference';
            if (chartId?.includes('momentum')) return 'Momentum Trend';
            return 'Performance Metric';
        };
        const chartMetricLabel = pick.evidenceChart ? getChartMetricLabel(pick.evidenceChart.chartId, pick.evidenceChart.dataSource) : '';

        // Find matching matchup article from all posts (not just relatedPosts)
        const findMatchingArticle = (): HeatPicksHeatcheckPost | null => {
            if (!matchPack) return null;
            return allPosts.find(relatedPost => {
                if (relatedPost.storyType === 'heat_picks' || relatedPost.storyType === 'dfs_article') return false;
                const relatedTeamA = relatedPost.teamA || '';
                const relatedTeamB = relatedPost.teamB || '';
                return (relatedTeamA === matchPack.teamA && relatedTeamB === matchPack.teamB) ||
                       (relatedTeamA === matchPack.teamB && relatedTeamB === matchPack.teamA);
            }) || null;
        };
        const matchingArticle = findMatchingArticle();

        // Generate article URL for matching article
        const generateMatchupArticleUrl = (article: HeatPicksHeatcheckPost): string => {
            const articleLeague = normalizeLeague(article.league);
            const articleDate = article.matchupScheduledDate 
                ? formatDateISO(article.matchupScheduledDate)
                : formatDateISO(article.createdAt);
            
            const storedSlug = article.websiteStory?.seo?.slug || '';
            const isPredictionFormat = storedSlug.includes('-prediction-preview-') && storedSlug.match(/\d{4}-\d{2}-\d{2}$/);
            
            if (isPredictionFormat) {
                return `/${articleLeague}/${storedSlug}/`;
            }
            
            // Fallback: generate from matchup and narrative
            const matchupSlug = generateMatchupSlug(article.teamA || '', article.teamB || '', getShortTeamName);
            const heatCheckData = article.heatCheckData || {};
            const narratives = heatCheckData.narratives || {};
            const candidateCards = narratives.candidate_cards || [];
            const primaryNarrativeId = narratives.selected?.primary_narrative_id || '';
            const activeCard = candidateCards.find((card: any) => card.narrative_id === primaryNarrativeId);
            const emotionTags = activeCard?.emotion_tags || [];
            const narrativeSlug = generateNarrativeSlug(
                article.websiteStory?.headline || '',
                article.teamA || '',
                article.teamB || '',
                emotionTags
            );
            return `/${articleLeague}/${articleDate}/${matchupSlug}/${narrativeSlug}/`;
        };
        const matchupArticleUrl = matchingArticle ? generateMatchupArticleUrl(matchingArticle) : '';
        
        // Get matchup article image
        const getMatchupArticleImage = (): string => {
            if (!matchingArticle) return '';
            const imageName = matchingArticle.websiteStory?.image || matchingArticle.websiteStory?.imageUrl || '';
            if (!imageName) return '';
            if (imageName.startsWith('http')) return imageName;
            if (imageName.startsWith('/')) return imageName;
            if (imageName.includes('/assets/images/')) {
                const parts = imageName.split('/assets/images/');
                const filename = parts.length > 1 ? parts[parts.length - 1] : imageName.split('/').pop();
                return `/assets/images/${filename}`;
            }
            return `/assets/images/${imageName}`;
        };
        const matchupImagePath = getMatchupArticleImage();

        // Chart HTML for left column (integrated with content) - with metric labeling
        const chartHtml = pick.evidenceChart && chartCanvas ? `
            <div class="heat-pick-chart" style="margin-top: 1rem; padding: 0.75rem; background: rgba(0, 0, 0, 0.2); border: 1px solid ${borderColor};">
                <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.7rem; margin-bottom: 0.3rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px dashed rgba(0, 255, 65, 0.3); padding-bottom: 0.3rem;">
                    📈 CHART: ${escapeHtml(pick.evidenceChart.questionAnswered)}
                </div>
                <div style="color: rgba(255, 255, 255, 0.6); font-size: 0.65rem; margin-bottom: 0.4rem; font-family: 'Courier New', monospace; font-style: italic;">
                    Metric: ${chartMetricLabel}
                </div>
                <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.7rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; line-height: 1.3;">
                    ${escapeHtml(pick.chartCaption || 'Chart supports the pressure signal')}
                </div>
                ${chartCanvas}
            </div>
        ` : '';

        return `
            <div id="heat-pick-${index}" style="margin-bottom: 1.5rem; padding: 1rem; background: ${bgGradient}; border: 1px solid ${borderColor}; border-left: 3px solid ${borderColor}; box-shadow: 0 0 15px rgba(0, 0, 0, 0.2), inset 0 0 15px rgba(0, 0, 0, 0.15); position: relative;">
                <!-- Weather Station Header -->
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; padding: 0.75rem; background: rgba(0, 0, 0, 0.3); border: 1px solid ${borderColor}; border-radius: 4px;">
                    <div>
                        <div style="color: rgba(255, 255, 255, 0.95); font-size: 1rem; font-family: 'Courier New', monospace; font-weight: bold;">
                            ${escapeHtml(pick.matchup)}
                        </div>
                    </div>
                    <!-- Temperature Display (Weather Forecast Style) -->
                    <div style="text-align: right; padding-left: 1rem; border-left: 1px solid ${borderColor};">
                        <div style="color: ${tempColor}; font-size: 2.5rem; font-family: 'Courier New', monospace; font-weight: bold; line-height: 1; margin-bottom: 0.25rem;">
                            ${pick.heatScore}°
                        </div>
                        <div style="color: ${tempColor}; font-size: 0.75rem; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.1em; font-weight: bold;">
                            ${tempLabel}
                        </div>
                    </div>
                </div>
                
                <!-- Pick Display with Matchup Image -->
                <div style="margin-bottom: 1rem; display: grid; grid-template-columns: 1fr ${matchupImagePath ? 'auto' : ''}; gap: 1rem; align-items: start;">
                    <div style="padding: 0.75rem; background: rgba(0, 0, 0, 0.3); border-left: 3px solid ${borderColor};">
                        <div style="color: rgba(255, 255, 255, 0.6); font-size: 0.65rem; font-family: 'Courier New', monospace; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.3rem;">
                            RECOMMENDED PICK
                        </div>
                        <div style="color: #ff8c00; font-size: 1.2rem; font-family: 'Courier New', monospace; font-weight: bold;">
                            ${escapeHtml(pick.pick)}
                        </div>
                    </div>
                    ${matchupImagePath && matchupArticleUrl ? `
                        <div style="display: flex; flex-direction: column; align-items: center; gap: 0.5rem;">
                            <a href="${matchupArticleUrl}" style="text-decoration: none; display: block;">
                                <img src="${matchupImagePath}" alt="${escapeHtml(pick.matchup)}" style="width: 150px; height: 100px; object-fit: contain; border: 1px solid ${borderColor}; border-radius: 4px; display: block; background: rgba(0, 0, 0, 0.3);">
                            </a>
                            <a href="${matchupArticleUrl}" style="display: inline-block; padding: 0.4rem 0.75rem; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(0, 255, 65, 0.5); color: rgba(0, 255, 65, 0.9); text-decoration: none; font-family: 'Courier New', monospace; font-size: 0.7rem; font-weight: bold; text-transform: uppercase; letter-spacing: 0.05em; transition: all 0.3s ease; white-space: nowrap;" onmouseover="this.style.background='rgba(0,255,65,0.1)'; this.style.borderColor='rgba(0,255,65,0.7)';" onmouseout="this.style.background='rgba(0,0,0,0.4)'; this.style.borderColor='rgba(0,255,65,0.5)';">See Full Story</a>
                        </div>
                    ` : ''}
                </div>

                <!-- Content Grid: Info and Chart -->
                <div class="heat-pick-content-grid" style="display: grid; grid-template-columns: ${pick.evidenceChart ? '1fr 1fr' : '1fr'}; gap: 1rem;">
                    <!-- Left: Conditions and Signals -->
                    <div class="heat-pick-left-section">
                        <div style="margin-bottom: 1rem;">
                            <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.65rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                CONDITIONS
                            </div>
                            <ul style="list-style: none; padding: 0; margin: 0;">
                                ${pick.whyHot.map(bullet => `
                                    <li style="margin-bottom: 0.4rem; padding-left: 0.75rem; position: relative; color: rgba(255, 255, 255, 0.8); font-size: 0.75rem; font-family: 'Courier New', monospace; line-height: 1.4;">
                                        <span style="position: absolute; left: 0; color: ${borderColor}; font-size: 0.7rem;">▶</span>
                                        ${escapeHtml(bullet)}
                                    </li>
                                `).join('')}
                            </ul>
                        </div>

                        <div style="margin-bottom: 1rem;">
                            <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.65rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                SIGNALS DETECTED
                            </div>
                            <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                                ${pick.signalsHit.map(signal => `
                                    <div style="padding: 0.4rem; background: rgba(0, 0, 0, 0.3); border-left: 2px solid ${borderColor}; font-family: 'Courier New', monospace; font-size: 0.7rem;">
                                        <strong style="color: ${borderColor}; text-transform: uppercase; font-size: 0.65rem;">${escapeHtml(signal.signalKey)}:</strong>
                                        <span style="color: rgba(255, 255, 255, 0.85); margin-left: 0.4rem; font-size: 0.7rem;">${escapeHtml(signal.evidence)}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    </div>

                    <!-- Right: Chart or Narrative/Market/Risk -->
                    ${pick.evidenceChart ? `
                        <div class="heat-pick-chart-section">
                            ${chartHtml}
                        </div>
                    ` : `
                        <div class="heat-pick-right-section">
                            ${pick.narrativesUsed && pick.narrativesUsed.length > 0 ? `
                                <div style="margin-bottom: 1rem;">
                                    <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.65rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                        NARRATIVE ALIGNMENT
                                    </div>
                                    <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.75rem; font-family: 'Courier New', monospace; line-height: 1.4;">
                                        ${pick.narrativesUsed.map(n => `
                                            <div style="margin-bottom: 0.4rem; padding: 0.4rem; background: rgba(0, 0, 0, 0.2); border-left: 2px solid ${borderColor};">
                                                <strong style="color: ${borderColor}; font-size: 0.7rem;">${escapeHtml(n.type)}</strong> <span style="font-size: 0.7rem;">(${n.direction}):</span> <span style="font-size: 0.7rem;">${escapeHtml(n.whyItFitsData)}</span>
                                            </div>
                                        `).join('')}
                                    </div>
                                </div>
                            ` : ''}

                            <div style="margin-bottom: 1rem;">
                                <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.65rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                    MARKET CONDITIONS
                                </div>
                                <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.75rem; font-family: 'Courier New', monospace; line-height: 1.4; padding: 0.4rem; background: rgba(0, 0, 0, 0.2); border-left: 2px solid ${borderColor};">
                                    ${escapeHtml(pick.marketLag)}
                                </div>
                            </div>

                            <div>
                                <div style="color: #ff4444; font-size: 0.65rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                    RISK ADVISORY
                                </div>
                                <div style="color: rgba(255, 255, 255, 0.85); font-size: 0.75rem; font-family: 'Courier New', monospace; line-height: 1.4; padding: 0.4rem; background: rgba(255, 68, 68, 0.15); border-left: 2px solid #ff4444;">
                                    ${escapeHtml(pick.riskNote)}
                                </div>
                            </div>
                        </div>
                    `}
                </div>
                
                <!-- Narrative/Market/Risk below chart if chart exists -->
                ${pick.evidenceChart ? `
                    <div style="margin-top: 1rem; display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                        ${pick.narrativesUsed && pick.narrativesUsed.length > 0 ? `
                            <div>
                                <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.65rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                    NARRATIVE ALIGNMENT
                                </div>
                                <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.75rem; font-family: 'Courier New', monospace; line-height: 1.4;">
                                    ${pick.narrativesUsed.map(n => `
                                        <div style="margin-bottom: 0.4rem; padding: 0.4rem; background: rgba(0, 0, 0, 0.2); border-left: 2px solid ${borderColor};">
                                            <strong style="color: ${borderColor}; font-size: 0.7rem;">${escapeHtml(n.type)}</strong> <span style="font-size: 0.7rem;">(${n.direction}):</span> <span style="font-size: 0.7rem;">${escapeHtml(n.whyItFitsData)}</span>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>
                        ` : '<div></div>'}
                        <div>
                            <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.65rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                MARKET CONDITIONS
                            </div>
                            <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.75rem; font-family: 'Courier New', monospace; line-height: 1.4; padding: 0.4rem; background: rgba(0, 0, 0, 0.2); border-left: 2px solid ${borderColor};">
                                ${escapeHtml(pick.marketLag)}
                            </div>
                            <div style="margin-top: 0.75rem;">
                                <div style="color: #ff4444; font-size: 0.65rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                    RISK ADVISORY
                                </div>
                                <div style="color: rgba(255, 255, 255, 0.85); font-size: 0.75rem; font-family: 'Courier New', monospace; line-height: 1.4; padding: 0.4rem; background: rgba(255, 68, 68, 0.15); border-left: 2px solid #ff4444;">
                                    ${escapeHtml(pick.riskNote)}
                                </div>
                            </div>
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    };

    // Generate Heat Picks Summary Table (Weather Report Style for Sidebar)
    const summaryTable = `
        <div style="margin-bottom: 1.5rem; padding: 0.75rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(0, 255, 65, 0.3); font-family: 'Courier New', monospace;">
            <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.7rem; margin-bottom: 0.75rem; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px dashed rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">
                📊 FORECAST SUMMARY
            </div>
            <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                ${heatPicks.map((pick, idx) => {
                    const primarySignal = pick.signalsHit[0]?.signalKey || 'momentum';
                    const tempColor = pick.heatScore >= 85 ? '#ff1a1a' : pick.heatScore >= 70 ? '#ffd700' : 'rgba(255, 255, 255, 0.7)';
                    return `
                        <div style="padding: 0.5rem; background: rgba(0, 0, 0, 0.2); border-left: 2px solid ${tempColor};">
                            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.3rem;">
                                <a href="#heat-pick-${idx}" style="color: rgba(255, 255, 255, 0.9); text-decoration: none; font-size: 0.7rem; font-weight: bold; border-bottom: 1px dashed rgba(0, 255, 65, 0.5);">
                                    ${escapeHtml(pick.matchup)}
                                </a>
                                <div style="color: ${tempColor}; font-size: 0.85rem; font-weight: bold;">${pick.heatScore}°</div>
                            </div>
                            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.65rem;">
                                <span style="color: rgba(255, 255, 255, 0.8); font-weight: bold;">${escapeHtml(pick.pick)}</span>
                                <span style="color: rgba(255, 255, 255, 0.6); text-transform: capitalize;">${escapeHtml(primarySignal)}</span>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;

    // Main content - Weather Report Style
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
                    grid-row: 2 !important;
                }
                .article-sidebar-column {
                    grid-column: 1 !important;
                    grid-row: 1 !important;
                    overflow-y: visible !important;
                    overflow-x: hidden !important;
                    max-height: none !important;
                }
                /* Heat Pick Cards - prevent text bleeding */
                #heat-pick-0, #heat-pick-1, #heat-pick-2, #heat-pick-3, #heat-pick-4, #heat-pick-5, #heat-pick-6, #heat-pick-7, #heat-pick-8, #heat-pick-9 {
                    padding: 0.75rem !important;
                    margin-bottom: 1rem !important;
                    word-wrap: break-word !important;
                    overflow-wrap: break-word !important;
                    box-sizing: border-box !important;
                }
                /* Horizontal layout for heat pick content on mobile */
                .heat-pick-content-grid {
                    grid-template-columns: 1fr !important;
                    gap: 0.75rem !important;
                    width: 100% !important;
                    box-sizing: border-box !important;
                }
                .heat-pick-left-section, .heat-pick-right-section, .heat-pick-chart-section {
                    display: flex;
                    flex-direction: column;
                    width: 100% !important;
                    box-sizing: border-box !important;
                    overflow: hidden !important;
                }
                /* Make subtopics more compact and prevent overflow */
                .heat-pick-left-section > div,
                .heat-pick-right-section > div {
                    margin-bottom: 0.75rem !important;
                    width: 100% !important;
                    box-sizing: border-box !important;
                }
                .heat-pick-left-section ul {
                    width: 100% !important;
                    box-sizing: border-box !important;
                }
                .heat-pick-left-section ul li {
                    font-size: 0.7rem !important;
                    line-height: 1.3 !important;
                    margin-bottom: 0.3rem !important;
                    word-wrap: break-word !important;
                    overflow-wrap: break-word !important;
                    max-width: 100% !important;
                }
                .heat-pick-right-section > div > div {
                    font-size: 0.7rem !important;
                    line-height: 1.3 !important;
                    margin-bottom: 0.3rem !important;
                    word-wrap: break-word !important;
                    overflow-wrap: break-word !important;
                }
                /* Charts - prevent overflow on mobile */
                .heat-pick-chart {
                    margin-top: 0.75rem !important;
                    margin-bottom: 0.75rem !important;
                    width: 100% !important;
                    box-sizing: border-box !important;
                    overflow: hidden !important;
                }
                .heat-pick-chart > div {
                    width: 100% !important;
                    box-sizing: border-box !important;
                    overflow: hidden !important;
                }
                .heat-pick-chart canvas {
                    height: 120px !important;
                    max-width: 100% !important;
                    width: 100% !important;
                    box-sizing: border-box !important;
                }
                /* Temperature display on mobile */
                #heat-pick-0 > div:first-child, #heat-pick-1 > div:first-child, #heat-pick-2 > div:first-child, #heat-pick-3 > div:first-child, #heat-pick-4 > div:first-child, #heat-pick-5 > div:first-child, #heat-pick-6 > div:first-child, #heat-pick-7 > div:first-child, #heat-pick-8 > div:first-child, #heat-pick-9 > div:first-child {
                    flex-wrap: wrap !important;
                }
                #heat-pick-0 > div:first-child > div:last-child, #heat-pick-1 > div:first-child > div:last-child, #heat-pick-2 > div:first-child > div:last-child, #heat-pick-3 > div:first-child > div:last-child, #heat-pick-4 > div:first-child > div:last-child, #heat-pick-5 > div:first-child > div:last-child, #heat-pick-6 > div:first-child > div:last-child, #heat-pick-7 > div:first-child > div:last-child, #heat-pick-8 > div:first-child > div:last-child, #heat-pick-9 > div:first-child > div:last-child {
                    font-size: 2rem !important;
                }
                /* Recommended Pick on mobile */
                #heat-pick-0 > div:nth-child(2), #heat-pick-1 > div:nth-child(2), #heat-pick-2 > div:nth-child(2), #heat-pick-3 > div:nth-child(2), #heat-pick-4 > div:nth-child(2), #heat-pick-5 > div:nth-child(2), #heat-pick-6 > div:nth-child(2), #heat-pick-7 > div:nth-child(2), #heat-pick-8 > div:nth-child(2), #heat-pick-9 > div:nth-child(2) {
                    grid-template-columns: 1fr !important;
                    gap: 0.75rem !important;
                }
                #heat-pick-0 > div:nth-child(2) > div:first-child > div:last-child, #heat-pick-1 > div:nth-child(2) > div:first-child > div:last-child, #heat-pick-2 > div:nth-child(2) > div:first-child > div:last-child, #heat-pick-3 > div:nth-child(2) > div:first-child > div:last-child, #heat-pick-4 > div:nth-child(2) > div:first-child > div:last-child, #heat-pick-5 > div:nth-child(2) > div:first-child > div:last-child, #heat-pick-6 > div:nth-child(2) > div:first-child > div:last-child, #heat-pick-7 > div:nth-child(2) > div:first-child > div:last-child, #heat-pick-8 > div:nth-child(2) > div:first-child > div:last-child, #heat-pick-9 > div:nth-child(2) > div:first-child > div:last-child {
                    font-size: 1rem !important;
                    word-wrap: break-word !important;
                    overflow-wrap: break-word !important;
                }
                /* Matchup image on mobile */
                #heat-pick-0 > div:nth-child(2) > div:last-child, #heat-pick-1 > div:nth-child(2) > div:last-child, #heat-pick-2 > div:nth-child(2) > div:last-child, #heat-pick-3 > div:nth-child(2) > div:last-child, #heat-pick-4 > div:nth-child(2) > div:last-child, #heat-pick-5 > div:nth-child(2) > div:last-child, #heat-pick-6 > div:nth-child(2) > div:last-child, #heat-pick-7 > div:nth-child(2) > div:last-child, #heat-pick-8 > div:nth-child(2) > div:last-child, #heat-pick-9 > div:nth-child(2) > div:last-child {
                    width: 100% !important;
                    max-width: 100% !important;
                }
                #heat-pick-0 > div:nth-child(2) > div:last-child img, #heat-pick-1 > div:nth-child(2) > div:last-child img, #heat-pick-2 > div:nth-child(2) > div:last-child img, #heat-pick-3 > div:nth-child(2) > div:last-child img, #heat-pick-4 > div:nth-child(2) > div:last-child img, #heat-pick-5 > div:nth-child(2) > div:last-child img, #heat-pick-6 > div:nth-child(2) > div:last-child img, #heat-pick-7 > div:nth-child(2) > div:last-child img, #heat-pick-8 > div:nth-child(2) > div:last-child img, #heat-pick-9 > div:nth-child(2) > div:last-child img {
                    width: 100% !important;
                    max-width: 100% !important;
                    height: auto !important;
                }
            }
        </style>
        ${breadcrumbHtml}
        <article class="article-content-grid" style="display: grid; grid-template-columns: 2fr 1fr; grid-template-rows: auto 1fr; gap: 0.5rem; padding: 0.5rem;">
            <!-- Left Column: Main Report -->
            <section class="article-main-column" style="grid-column: 1; grid-row: 1 / -1; display: flex; flex-direction: column; background: rgba(0, 20, 10, 0.4); border: 1px solid rgba(0, 255, 65, 0.4); box-shadow: inset 0 0 20px rgba(0, 255, 65, 0.08), 0 0 30px rgba(0, 0, 0, 0.3); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); overflow: hidden;">
                <div class="main-document-header terminal-style" style="padding: 0.5rem 0.75rem; background: rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.15); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0;">
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.5); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.3);"></div>
                    <div style="width: 8px; height: 8px; background: rgba(255, 255, 255, 0.6); border-radius: 50%; box-shadow: 0 0 8px rgba(255, 255, 255, 0.4);"></div>
                    <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.75rem; font-family: 'Courier New', monospace; margin-left: 0.5rem; letter-spacing: 0.1em;">HEAT_PICKS_REPORT.log</div>
                </div>
                <div style="flex: 1; overflow-y: auto; padding: 1.5rem; font-family: 'Courier New', monospace; color: rgba(255, 255, 255, 0.85); font-size: 0.95rem; line-height: 1.8; scrollbar-width: none; -ms-overflow-style: none;">
                    <style>.main-article-content::-webkit-scrollbar { display: none; }</style>
                    <header style="margin-bottom: 2rem; border-bottom: 1px dashed rgba(0, 255, 65, 0.4); padding-bottom: 1rem;">
                        <h1 style="color: rgba(255, 255, 255, 0.95); font-size: 1.3rem; margin-bottom: 0.5rem; font-weight: bold; line-height: 1.3;">
                            ${escapeHtml(title)}
                        </h1>
                        <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap;">
                            <a href="/" class="article-back-btn" style="display: inline-block; padding: 0.4rem 0.8rem; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(248, 66, 66, 0.5); color: rgba(248, 66, 66, 0.9); text-decoration: none; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.9rem; transition: all 0.3s ease; white-space: nowrap; line-height: 1;" onmouseover="this.style.background='rgba(248,66,66,0.1)'; this.style.borderColor='rgba(248,66,66,0.7)'; this.style.color='#f84242';" onmouseout="this.style.background='rgba(0,0,0,0.3)'; this.style.borderColor='rgba(248,66,66,0.5)'; this.style.color='rgba(248,66,66,0.9)';">← BACK</a>
                        </div>
                        <p style="color: rgba(255, 255, 255, 0.6); font-size: 0.85rem; margin-bottom: 0.5rem;">// ${escapeHtml(post.websiteStory.dek)}</p>
                        <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.8rem; font-family: 'Courier New', monospace;">
                            &gt; REPORT DATE: <time datetime="${date}">${escapeHtml(date)}</time> | LEAGUE: ${escapeHtml(post.league.toUpperCase())} | STATION: HEATCHECKS.IO
                </div>
            </header>


                    <!-- Heat Picks Forecasts -->
            ${heatPicks.length > 0 ? `
                        <section style="margin-bottom: 2rem;">
                            <div style="color: #ff3333; font-size: 0.9rem; margin-bottom: 1.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.15em;">
                                🔥 SCORCHING CONDITIONS
                            </div>
                            ${heatPicks.map((pick, idx) => generateHeatPickBlock(pick, idx)).join('')}
                </section>
            ` : ''}

                    <!-- Warm Leans Forecasts -->
            ${warmLeans.length > 0 ? `
                        <section style="margin-bottom: 2rem;">
                            <div style="color: rgba(255, 230, 109, 0.9); font-size: 0.9rem; margin-bottom: 1.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.15em;">
                                🌡️ WARM CONDITIONS
                            </div>
                    ${warmLeans.map((pick, idx) => generateHeatPickBlock(pick, idx + heatPicks.length, true)).join('')}
                </section>
            ` : ''}

            <!-- No-Heat Zone -->
            ${noHeatZone.length > 0 ? `
                        <section style="margin-bottom: 2rem;">
                            <div style="color: rgba(255, 255, 255, 0.5); font-size: 0.9rem; margin-bottom: 1.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.15em;">
                                ❄️ COOL CONDITIONS
                            </div>
                            <div style="display: flex; flex-direction: column; gap: 1rem;">
                                ${noHeatZone.map(item => `
                                    <div style="padding: 1rem; background: rgba(0, 0, 0, 0.3); border-left: 3px solid rgba(255, 255, 255, 0.2); font-family: 'Courier New', monospace;">
                                        <div style="color: rgba(255, 255, 255, 0.9); font-weight: bold; margin-bottom: 0.5rem; font-size: 0.9rem;">${escapeHtml(item.matchup)}</div>
                                        <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.85rem; line-height: 1.5;">${escapeHtml(item.whyNot)}</div>
                            </div>
                        `).join('')}
                    </div>
                </section>
            ` : ''}

            <!-- Footer CTA -->
                    <footer style="margin-top: 2rem; padding: 1.5rem; background: rgba(0, 255, 65, 0.05); border: 1px solid rgba(0, 255, 65, 0.2); text-align: center; font-family: 'Courier New', monospace;">
                        <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.9rem; margin-bottom: 0.5rem;">
                            Daily Heat Reports Available
                        </div>
                        <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.8rem;">
                            Updated daily — data-driven forecasts only.
                        </div>
            </footer>
                </div>
            </section>
            
            <!-- Right Column: Summary Sidebar -->
            <aside class="article-sidebar-column" style="grid-column: 2; grid-row: 1 / -1; display: flex; flex-direction: column; gap: 0.5rem; overflow-y: auto; overflow-x: hidden;">
                <div style="padding: 1rem; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(0, 255, 65, 0.3); font-family: 'Courier New', monospace;">
                    <div style="color: rgba(0, 255, 65, 0.9); font-size: 0.75rem; margin-bottom: 0.75rem; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em; border-bottom: 1px dashed rgba(0, 255, 65, 0.3); padding-bottom: 0.5rem;">
                        📡 REPORT STATS
                    </div>
                    <div style="color: rgba(255, 255, 255, 0.8); font-size: 0.75rem; line-height: 1.8;">
                        <div style="margin-bottom: 0.4rem;">
                            <span style="color: rgba(255, 26, 26, 0.9);">Heat Picks:</span> <strong>${heatPicks.length}</strong>
                        </div>
                        <div style="margin-bottom: 0.4rem;">
                            <span style="color: rgba(255, 230, 109, 0.9);">Warm Leans:</span> <strong>${warmLeans.length}</strong>
                        </div>
                        <div style="margin-bottom: 0.4rem;">
                            <span style="color: rgba(255, 255, 255, 0.6);">Cool Zone:</span> <strong>${noHeatZone.length}</strong>
                        </div>
                        <div style="margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid rgba(255, 255, 255, 0.1);">
                            <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.7rem; margin-bottom: 0.3rem;">
                                Report Date:
                            </div>
                            <div style="color: rgba(255, 255, 255, 0.9); font-size: 0.8rem; font-weight: bold;">
                                ${escapeHtml(date)}
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Forecast Summary Table (Weather Report Style) -->
                ${heatPicks.length > 0 ? summaryTable : ''}
            </aside>
        </article>
    `;

    // Generate keywords for meta tag
    const keywords = [
        'heat picks',
        'sports betting picks',
        'betting predictions',
        'betting analysis',
        `${post.league.toUpperCase()} betting`,
        `${post.league.toUpperCase()} picks`,
        `${post.league.toUpperCase()} heat picks`,
        'daily betting picks',
        'data-driven picks',
        'market lag betting',
        dateForTitle
    ].filter(k => k).join(', ');
    
    // Generate Schema.org JSON-LD - Article
    const schemaOrg = {
        "@context": "https://schema.org",
        "@type": "Article",
        "headline": title,
        "description": finalMetaDescription,
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
            "@id": articleUrl
        },
        "articleSection": "Heat Picks"
    };
    
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

    const ogImageUrl = imagePath ? (imagePath.startsWith('http') ? imagePath : `${baseUrl}${imagePath}`) : `${baseUrl}/images/default-og-image.jpg`;
    
    const options: BaseTemplateOptions = {
        title: title,
        description: finalMetaDescription,
        url: articleUrl,
        baseUrl,
        ogImage: ogImageUrl,
        ogImageAlt: title, // Add og:image:alt
        ogType: 'article',
        keywords: keywords,
        twitterSite: '@heatchecksio', // Add Twitter site
        twitterCreator: '@heatchecksio', // Add Twitter creator
        articleMeta: {
            publishedTime: post.createdAt,
            modifiedTime: post.updatedAt,
            author: 'HeatChecks',
            section: 'Heat Picks',
            tags: ['Heat Picks', post.league, `${post.league} Betting`, 'Daily Picks', 'Betting Analysis']
        },
        schemaOrg: [schemaOrg, breadcrumbSchema],
        posts: [post, ...relatedPosts]
    };

    return generateBaseHtml(content, options);
}

