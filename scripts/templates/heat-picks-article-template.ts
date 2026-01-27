import { generateBaseHtml, BaseTemplateOptions } from './base-template';
import { escapeHtml } from '../utils/html-escape';
import { formatDateISO, normalizeLeague } from '../utils/date-formatter';

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
    baseUrl: string = 'https://heatchecks.io'
): string {
    const league = normalizeLeague(post.league);
    const date = post.matchupScheduledDate 
        ? formatDateISO(post.matchupScheduledDate)
        : formatDateISO(post.createdAt);
    
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

    // Generate Heat Pick block HTML
    const generateHeatPickBlock = (pick: HeatPick, index: number, isWarmLean: boolean = false) => {
        const chartId = `heat-pick-chart-${index}`;
        const chartDataId = `heat-pick-chart-data-${index}`;
        const matchPack = heatCheckData.matchPacks?.find(mp => 
            pick.matchup.includes(mp.teamA) && pick.matchup.includes(mp.teamB)
        );
        const chartCatalog = matchPack ? heatCheckData.chartCatalog?.[`${matchPack.teamA}-${matchPack.teamB}`] : [];
        const selectedChart = chartCatalog?.find(c => c.chartId === pick.evidenceChart?.chartId);

        // Generate chart data if available
        let chartDataScript = '';
        let chartCanvas = '';
        if (pick.evidenceChart && matchPack?.matchPackV3) {
            const matchPackV3 = matchPack.matchPackV3;
            const factDrop = matchPackV3.factDrop || {};
            const teamForm = factDrop.raw?.teamForm || {};
            
            // Generate chart data based on chart type
            let chartPayload: any = {};
            
            if (pick.evidenceChart.chartId === 'rolling_margin_last10') {
                // Rolling margin trend
                const aMargins = teamForm.A?.margins || teamForm.A?.xgDiff || [];
                const bMargins = teamForm.B?.margins || teamForm.B?.xgDiff || [];
                chartPayload = {
                    momentumLine: {
                        series: {
                            A: { margins: aMargins, label: matchPack.teamA },
                            B: { margins: bMargins, label: matchPack.teamB }
                        }
                    }
                };
            }

            const chartJson = JSON.stringify(chartPayload).replace(/</g, '\\u003c');
            chartDataScript = `<script type="application/json" id="${chartDataId}">${chartJson}</script>`;
            chartCanvas = `
                <div style="margin-top: 0.5rem; height: 200px;">
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
                            if (!dataEl) return;
                            var payload = JSON.parse(dataEl.textContent || '{}');
                            if (!payload || !window.Chart) {
                                if (tries++ < 60) return setTimeout(go, 50);
                                return;
                            }
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
                                            plugins: { legend: { display: false } },
                                            scales: {
                                                x: { ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: 'rgba(255,255,255,0.08)' } },
                                                y: { ticks: { color: 'rgba(255,255,255,0.65)', font: { family: 'Courier New', size: 10 } }, grid: { color: function(ctx){ return ctx.tick && ctx.tick.value === 0 ? 'rgba(0,255,65,0.25)' : 'rgba(255,255,255,0.08)'; } } }
                                            }
                                        }
                                    });
                                }
                            }
                        } catch(e) {
                            console.error('Chart error:', e);
                        }
                    }
                    go();
                })();
                </script>
            `;
        }

        const prefix = isWarmLean ? '🌡️' : '🔥';
        const title = isWarmLean ? 'Warm Lean' : 'Heat Pick';

        return `
            <div style="margin-bottom: 3rem; padding: 1.5rem; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(0, 255, 65, 0.3); border-left: 4px solid ${isWarmLean ? 'rgba(255, 230, 109, 0.8)' : 'rgba(255, 26, 26, 0.8)'};">
                <h2 style="color: rgba(255, 255, 255, 0.95); font-size: 1.5rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold;">
                    ${prefix} ${title}: ${escapeHtml(pick.pick)} (Heat Score: ${pick.heatScore})
                </h2>

                ${pick.evidenceChart ? `
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; margin-bottom: 1.5rem;">
                        <div>
                            <h3 style="color: rgba(0, 255, 65, 0.9); font-size: 1rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold;">
                                ${escapeHtml(pick.evidenceChart.questionAnswered)}
                            </h3>
                            <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.85rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace;">
                                ${escapeHtml(pick.chartCaption || 'Chart supports the pressure signal')}
                            </div>
                            ${chartCanvas}
                        </div>
                        <div>
                ` : '<div>'}

                            <div style="margin-bottom: 1.5rem;">
                                <h3 style="color: rgba(0, 255, 65, 0.9); font-size: 0.9rem; margin-bottom: 0.75rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                    Why this game lit up
                                </h3>
                                <ul style="list-style: none; padding: 0; margin: 0;">
                                    ${pick.whyHot.map(bullet => `
                                        <li style="margin-bottom: 0.5rem; padding-left: 1rem; position: relative; color: rgba(255, 255, 255, 0.85); font-size: 0.9rem; font-family: 'Courier New', monospace; line-height: 1.5;">
                                            <span style="position: absolute; left: 0; color: rgba(0, 255, 65, 0.8);">▶</span>
                                            ${escapeHtml(bullet)}
                                        </li>
                                    `).join('')}
                                </ul>
                            </div>

                            <div style="margin-bottom: 1.5rem;">
                                <h3 style="color: rgba(0, 255, 65, 0.9); font-size: 0.9rem; margin-bottom: 0.75rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                    Signals hit
                                </h3>
                                <div style="display: flex; flex-direction: column; gap: 0.5rem;">
                                    ${pick.signalsHit.map(signal => `
                                        <div style="padding: 0.5rem; background: rgba(0, 0, 0, 0.3); border-left: 2px solid rgba(0, 255, 65, 0.5); font-family: 'Courier New', monospace; font-size: 0.85rem;">
                                            <strong style="color: rgba(0, 255, 65, 0.9); text-transform: uppercase;">${escapeHtml(signal.signalKey)}:</strong>
                                            <span style="color: rgba(255, 255, 255, 0.8); margin-left: 0.5rem;">${escapeHtml(signal.evidence)}</span>
                                        </div>
                                    `).join('')}
                                </div>
                            </div>

                            ${pick.narrativesUsed && pick.narrativesUsed.length > 0 ? `
                                <div style="margin-bottom: 1.5rem;">
                                    <h3 style="color: rgba(0, 255, 65, 0.9); font-size: 0.9rem; margin-bottom: 0.75rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                        Why the story matches the data
                                    </h3>
                                    <div style="color: rgba(255, 255, 255, 0.85); font-size: 0.9rem; font-family: 'Courier New', monospace; line-height: 1.5;">
                                        ${pick.narrativesUsed.map(n => `
                                            <div style="margin-bottom: 0.5rem;">
                                                <strong style="color: rgba(0, 255, 65, 0.9);">${escapeHtml(n.type)}</strong> (${n.direction}): ${escapeHtml(n.whyItFitsData)}
                                            </div>
                                        `).join('')}
                                    </div>
                                </div>
                            ` : ''}

                            <div style="margin-bottom: 1.5rem;">
                                <h3 style="color: rgba(0, 255, 65, 0.9); font-size: 0.9rem; margin-bottom: 0.75rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                    Market check
                                </h3>
                                <div style="color: rgba(255, 255, 255, 0.85); font-size: 0.9rem; font-family: 'Courier New', monospace; line-height: 1.5;">
                                    <strong style="color: rgba(0, 255, 65, 0.9);">Market lag:</strong> ${escapeHtml(pick.marketLag)}
                                </div>
                            </div>

                            <div>
                                <h3 style="color: rgba(0, 255, 65, 0.9); font-size: 0.9rem; margin-bottom: 0.75rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                                    Risk
                                </h3>
                                <div style="color: rgba(255, 255, 255, 0.85); font-size: 0.9rem; font-family: 'Courier New', monospace; line-height: 1.5;">
                                    ${escapeHtml(pick.riskNote)}
                                </div>
                            </div>
                        </div>
                    ${pick.evidenceChart ? '</div>' : '</div>'}
            </div>
        `;
    };

    // Generate Heat Picks Summary Table
    const summaryTable = `
        <div style="margin-bottom: 2rem; overflow-x: auto;">
            <table style="width: 100%; border-collapse: collapse; font-family: 'Courier New', monospace; font-size: 0.85rem;">
                <thead>
                    <tr style="background: rgba(0, 255, 65, 0.1); border-bottom: 2px solid rgba(0, 255, 65, 0.3);">
                        <th style="padding: 0.75rem; text-align: left; color: rgba(0, 255, 65, 0.9); font-weight: bold; text-transform: uppercase;">Matchup</th>
                        <th style="padding: 0.75rem; text-align: left; color: rgba(0, 255, 65, 0.9); font-weight: bold; text-transform: uppercase;">Pick</th>
                        <th style="padding: 0.75rem; text-align: center; color: rgba(0, 255, 65, 0.9); font-weight: bold; text-transform: uppercase;">Heat Score</th>
                        <th style="padding: 0.75rem; text-align: left; color: rgba(0, 255, 65, 0.9); font-weight: bold; text-transform: uppercase;">Signal</th>
                    </tr>
                </thead>
                <tbody>
                    ${heatPicks.map((pick, idx) => {
                        const primarySignal = pick.signalsHit[0]?.signalKey || 'momentum';
                        return `
                            <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.1);">
                                <td style="padding: 0.75rem; color: rgba(255, 255, 255, 0.9);">
                                    <a href="#heat-pick-${idx}" style="color: rgba(255, 255, 255, 0.9); text-decoration: none; border-bottom: 1px dashed rgba(0, 255, 65, 0.5);">
                                        ${escapeHtml(pick.matchup)}
                                    </a>
                                </td>
                                <td style="padding: 0.75rem; color: rgba(255, 255, 255, 0.9); font-weight: bold;">${escapeHtml(pick.pick)}</td>
                                <td style="padding: 0.75rem; text-align: center; color: rgba(255, 26, 26, 0.9); font-weight: bold;">${pick.heatScore}</td>
                                <td style="padding: 0.75rem; color: rgba(255, 255, 255, 0.7); text-transform: capitalize;">${escapeHtml(primarySignal)}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;

    // Main content
    const content = `
        <article>
            <header style="margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 2px solid rgba(0, 255, 65, 0.3);">
                <h1 style="color: rgba(255, 255, 255, 0.95); font-size: 2rem; margin-bottom: 0.5rem; font-family: 'Courier New', monospace; font-weight: bold; line-height: 1.2;">
                    ${escapeHtml(post.websiteStory.headline)}
                </h1>
                <p style="color: rgba(255, 255, 255, 0.7); font-size: 1rem; margin-bottom: 1rem; font-family: 'Courier New', monospace; line-height: 1.5;">
                    ${escapeHtml(post.websiteStory.dek)}
                </p>
                
                <!-- Quick Trust Strip -->
                <div style="display: flex; flex-wrap: wrap; gap: 1rem; padding: 1rem; background: rgba(0, 255, 65, 0.05); border: 1px solid rgba(0, 255, 65, 0.2); font-family: 'Courier New', monospace; font-size: 0.85rem;">
                    <div style="color: rgba(0, 255, 65, 0.9);">✔ Triggered by data (not opinion)</div>
                    <div style="color: rgba(0, 255, 65, 0.9);">✔ Narrative must match the numbers</div>
                    <div style="color: rgba(0, 255, 65, 0.9);">✔ Market lag required</div>
                    <div style="color: rgba(0, 255, 65, 0.9);">✔ Visual proof included</div>
                </div>
            </header>

            <!-- Heat Picks Summary -->
            ${heatPicks.length > 0 ? `
                <section style="margin-bottom: 3rem;">
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.2rem; margin-bottom: 1rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                        Heat Picks Summary
                    </h2>
                    ${summaryTable}
                </section>
            ` : ''}

            <!-- Individual Heat Pick Blocks -->
            ${heatPicks.length > 0 ? `
                <section style="margin-bottom: 3rem;">
                    <h2 style="color: rgba(0, 255, 65, 0.9); font-size: 1.2rem; margin-bottom: 1.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                        Heat Picks
                    </h2>
                    ${heatPicks.map((pick, idx) => `<div id="heat-pick-${idx}">${generateHeatPickBlock(pick, idx)}</div>`).join('')}
                </section>
            ` : ''}

            <!-- Warm Leans -->
            ${warmLeans.length > 0 ? `
                <section style="margin-bottom: 3rem;">
                    <h2 style="color: rgba(255, 230, 109, 0.9); font-size: 1.2rem; margin-bottom: 1.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                        🌡️ Warm Leans (Close, but not full Heat Picks)
                    </h2>
                    ${warmLeans.map((pick, idx) => generateHeatPickBlock(pick, idx + heatPicks.length, true)).join('')}
                </section>
            ` : ''}

            <!-- No-Heat Zone -->
            ${noHeatZone.length > 0 ? `
                <section style="margin-bottom: 3rem;">
                    <h2 style="color: rgba(255, 255, 255, 0.6); font-size: 1.2rem; margin-bottom: 1.5rem; font-family: 'Courier New', monospace; font-weight: bold; text-transform: uppercase; letter-spacing: 0.1em;">
                        ❄️ No-Heat Zone
                    </h2>
                    <div style="display: flex; flex-direction: column; gap: 1rem;">
                        ${noHeatZone.map(item => `
                            <div style="padding: 1rem; background: rgba(0, 0, 0, 0.3); border-left: 3px solid rgba(255, 255, 255, 0.3); font-family: 'Courier New', monospace;">
                                <div style="color: rgba(255, 255, 255, 0.9); font-weight: bold; margin-bottom: 0.5rem;">${escapeHtml(item.matchup)}</div>
                                <div style="color: rgba(255, 255, 255, 0.7); font-size: 0.9rem;">${escapeHtml(item.whyNot)}</div>
                            </div>
                        `).join('')}
                    </div>
                </section>
            ` : ''}

            <!-- Footer CTA -->
            <footer style="margin-top: 3rem; padding: 2rem; background: rgba(0, 255, 65, 0.05); border: 1px solid rgba(0, 255, 65, 0.2); text-align: center; font-family: 'Courier New', monospace;">
                <p style="color: rgba(255, 255, 255, 0.9); font-size: 1rem; margin-bottom: 0.5rem;">
                    Want the pressure signals every day?
                </p>
                <p style="color: rgba(255, 255, 255, 0.7); font-size: 0.9rem;">
                    Heat Picks update daily — no noise, just triggers.
                </p>
            </footer>
        </article>
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
            "@id": `${baseUrl}/${league}/heat-picks-today-${date}/`
        },
        "articleSection": "Heat Picks"
    };

    const options: BaseTemplateOptions = {
        title: post.websiteStory.seo.metaTitle,
        description: post.websiteStory.seo.metaDescription,
        url: `${baseUrl}/${league}/heat-picks-today-${date}/`,
        baseUrl,
        ogImage: imagePath ? (imagePath.startsWith('http') ? imagePath : `${baseUrl}${imagePath}`) : `${baseUrl}/images/default-og-image.jpg`,
        ogType: 'article',
        keywords: `Heat Picks, ${post.league}, picks, predictions, ${date}`,
        articleMeta: {
            publishedTime: post.createdAt,
            modifiedTime: post.updatedAt,
            author: 'HeatChecks',
            section: 'Heat Picks',
            tags: ['Heat Picks', post.league]
        },
        schemaOrg: [schemaOrg],
        posts: [post, ...relatedPosts]
    };

    return generateBaseHtml(content, options);
}

