import { escapeHtml } from './html-escape';

/**
 * Convert markdown to HTML with datacenter styling
 * Preserves existing HTML tags in the content
 */
export function markdownToHtml(markdown: string): string {
    if (!markdown) return '';
    
    // Debug: Log first 1000 chars of markdown to see what we're working with
    if (markdown.length > 0) {
        const sample = markdown.substring(0, Math.min(1000, markdown.length));
        const hasHtmlComment = sample.includes('<!--') || markdown.includes('<!--');
        if (hasHtmlComment) {
            console.log('[markdownToHtml] Markdown contains HTML comments, sample:', sample);
        }
    }
    
    // First, extract and preserve complete HTML blocks marked with special comments
    // These are complex HTML structures (like "OUR TAKE" blocks) that should not be processed as markdown
    const htmlBlockPlaceholders: { [key: string]: string } = {};
    let blockIndex = 0;
    
    // Match HTML blocks between special comment markers
    // Use a single pattern that handles all whitespace variations (0 or more spaces)
    const htmlBlockPattern = /<!--\s*HTML_BLOCK_START\s*-->([\s\S]*?)<!--\s*HTML_BLOCK_END\s*-->/g;
    
    // Collect all matches first, then replace them (to avoid index issues)
    const matches: Array<{ fullMatch: string; content: string; placeholder: string }> = [];
    let match;
    htmlBlockPattern.lastIndex = 0; // Reset regex
    
    // Extract all HTML blocks from the original markdown
    while ((match = htmlBlockPattern.exec(markdown)) !== null) {
        const placeholder = `__HTML_BLOCK_${blockIndex}__`;
        const content = match[1].trim();
        htmlBlockPlaceholders[placeholder] = content;
        matches.push({ fullMatch: match[0], content, placeholder });
        console.log(`[markdownToHtml] Extracted HTML block ${blockIndex}:`, {
            placeholder,
            contentLength: content.length,
            contentPreview: content.substring(0, 100) + '...',
            fullMatchPreview: match[0].substring(0, 150) + '...'
        });
        blockIndex++;
    }
    
    // Now replace all matches in the markdown (from end to start to preserve indices)
    let processedMarkdown = markdown;
    for (let i = matches.length - 1; i >= 0; i--) {
        processedMarkdown = processedMarkdown.replace(matches[i].fullMatch, matches[i].placeholder);
    }
    
    console.log(`[markdownToHtml] Total HTML blocks extracted: ${matches.length}`);
    if (matches.length === 0) {
        // Check if markdown contains HTML_BLOCK at all
        if (markdown.includes('HTML_BLOCK')) {
            const idx = markdown.indexOf('HTML_BLOCK');
            const sample = markdown.substring(Math.max(0, idx - 100), Math.min(markdown.length, idx + 200));
            console.warn('[markdownToHtml] WARNING: Markdown contains "HTML_BLOCK" but no blocks were extracted!');
            console.log('[markdownToHtml] Sample around HTML_BLOCK:', sample);
            console.log('[markdownToHtml] Full markdown length:', markdown.length);
            
            // Try to find what's around it
            const patternsToCheck = [
                /<!--.*HTML_BLOCK.*-->/g,
                /HTML_BLOCK_START/g,
                /HTML_BLOCK_END/g
            ];
            patternsToCheck.forEach((pattern, i) => {
                const matches = markdown.match(pattern);
                if (matches) {
                    console.log(`[markdownToHtml] Pattern ${i} found ${matches.length} matches:`, matches.slice(0, 3));
                }
            });
        } else {
            console.log('[markdownToHtml] Markdown does not contain "HTML_BLOCK" - no blocks to extract');
        }
    }
    
    // Now replace all matches in the markdown (from end to start to preserve indices)
    for (let i = matches.length - 1; i >= 0; i--) {
        processedMarkdown = processedMarkdown.replace(matches[i].fullMatch, matches[i].placeholder);
    }
    
    // Now handle individual HTML tags (for simpler cases that aren't in blocks)
    const htmlTagPlaceholders: { [key: string]: string } = {};
    let placeholderIndex = 0;
    
    // Replace HTML tags with placeholders before processing
    // CRITICAL: Skip any HTML that's part of a placeholder (which should have been extracted already)
    // Also skip HTML comment markers
    processedMarkdown = processedMarkdown.replace(/<[^>]+>/g, (match) => {
        // Skip HTML comments (including our block markers which should already be removed)
        if (match.startsWith('<!--')) return match;
        // Skip if this is part of an already-preserved block placeholder (shouldn't happen but be safe)
        if (match.includes('__HTML_BLOCK_')) return match;
        const placeholder = `__HTML_TAG_${placeholderIndex}__`;
        htmlTagPlaceholders[placeholder] = match;
        placeholderIndex++;
        return placeholder;
    });
    
    let html = processedMarkdown;
    
    // Headers - process them multiple times to catch any that might be inside other elements
    // This ensures headings are always converted, even if they appear after QUOTE blocks
    for (let i = 0; i < 3; i++) {
        html = html.replace(/^### (.+)$/gm, (match, text) => {
            // Skip if already converted to HTML
            if (match.includes('<div style=')) return match;
            return `<div style="color: #ffaa00; font-size: 1rem; margin-top: 1rem; margin-bottom: 0.5rem; font-weight: bold;">${escapeHtml(text)}</div>`;
        });
        
        html = html.replace(/^## (.+)$/gm, (match, text) => {
            // Skip if already converted to HTML
            if (match.includes('<div style=')) return match;
            return `<div style="color: #ff8000; font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.75rem; font-weight: bold;">${escapeHtml(text)}</div>`;
        });
        
        html = html.replace(/^# (.+)$/gm, (match, text) => {
            // Skip if already converted to HTML
            if (match.includes('<div style=')) return match;
            return `<div style="color: #ff8000; font-size: 1.5rem; margin-top: 2rem; margin-bottom: 1rem; font-weight: bold;">${escapeHtml(text)}</div>`;
        });
    }
    
    // Also catch any heading markdown that appears mid-string (not just at line start)
    // This handles cases where headings might be inside other HTML elements
    html = html.replace(/([^#]|^)##\s+([^\n<]+)/g, (match, before, text) => {
        // Only convert if it's not already HTML and not part of a URL or other construct
        if (match.includes('<div') || match.includes('&lt;')) return match;
        return before + `<div style="color: #ff8000; font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.75rem; font-weight: bold;">${escapeHtml(text.trim())}</div>`;
    });

    // Official callouts (HeatArticleV3 anchors):
    // - [STAT] ...  (single-line label + text)
    // - [QUOTE] ... (single-line label + text)
    const renderCallout = (label: 'STAT' | 'QUOTE', text: string) => {
        const t = escapeHtml(String(text || '').trim());
        const labelColor = label === 'STAT' ? '#00ff41' : '#ffe66d';
        const leftColor = label === 'STAT' ? 'rgba(0, 255, 65, 0.75)' : 'rgba(255, 230, 109, 0.85)';
        const textStyle = label === 'QUOTE'
            ? `color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.45; font-style:italic;`
            : `color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.45;`;

        // Important: keep this minified (no literal newlines) so markdownToHtml doesn't inject <br/> gaps.
        return (
            `<div style="margin:0.45rem 0; padding:0.5rem 0.65rem; background:rgba(0, 20, 10, 0.92); border:1px solid rgba(255,255,255,0.14); border-left:3px solid ${leftColor}; border-radius:10px; box-shadow:0 0 12px rgba(0,0,0,0.35), inset 0 0 14px rgba(255,255,255,0.04);">` +
            `<div style="display:flex; align-items:flex-start; gap:0.5rem;">` +
            `<div style="font-family:'Courier New', monospace; font-size:0.70rem; letter-spacing:0.16em; font-weight:900; color:${labelColor}; flex-shrink:0; white-space:nowrap;">${label}:</div>` +
            `<div style="${textStyle} flex:1; word-wrap:break-word; overflow-wrap:break-word;">${t}</div>` +
            `</div>` +
            `</div>`
        );
    };

    html = html.replace(/^- \[STAT\]\s*(.+)$/gm, (match, text) => renderCallout('STAT', text));
    // Handle QUOTE with optional speaker (format: "quote text — Speaker Name")
    // Use a more specific pattern: look for " — " (space-dash-space) at the end as speaker separator
    // IMPORTANT: Match only the line itself, don't capture following content
    html = html.replace(/^- \[QUOTE\]\s*(.+?)(?:\s+—\s+([^—]+))?$/gm, (match, text, speaker) => {
        const quoteText = String(text || '').trim();
        const speakerName = speaker ? String(speaker).trim() : null;
        // Render quote with speaker on same line if available
        // CRITICAL: Ensure quote text is fully escaped and doesn't contain markdown
        const t = escapeHtml(quoteText);
        const labelColor = '#ffe66d';
        const leftColor = 'rgba(255, 230, 109, 0.85)';
        const textStyle = `color:rgba(255,255,255,0.82); font-family:'Courier New', monospace; font-size:0.74rem; line-height:1.45; font-style:italic;`;
        
        // If speaker exists, add it after the quote text on the same line
        const speakerHtml = speakerName ? `<span style="color:rgba(255,255,255,0.65); font-size:0.70rem; margin-left:0.4rem; white-space:nowrap;">— ${escapeHtml(speakerName)}</span>` : '';
        
        // Return self-contained div that won't capture following content
        // Add explicit closing to ensure no content leaks in
        return (
            `<div style="margin:0.45rem 0; padding:0.5rem 0.65rem; background:rgba(0, 20, 10, 0.92); border:1px solid rgba(255,255,255,0.14); border-left:3px solid ${leftColor}; border-radius:10px; box-shadow:0 0 12px rgba(0,0,0,0.35), inset 0 0 14px rgba(255,255,255,0.04);">` +
            `<div style="display:flex; align-items:flex-start; gap:0.5rem;">` +
            `<div style="font-family:'Courier New', monospace; font-size:0.70rem; letter-spacing:0.16em; font-weight:900; color:${labelColor}; flex-shrink:0; white-space:nowrap;">QUOTE:</div>` +
            `<div style="${textStyle} flex:1; word-wrap:break-word; overflow-wrap:break-word;">${t}${speakerHtml}</div>` +
            `</div>` +
            `</div>`
        );
    });
    
    // CRITICAL: Ensure QUOTE and STAT blocks are followed by double newlines to separate them from following content
    // This prevents following content from being wrapped inside QUOTE blocks
    html = html.replace(/(<\/div>\s*<\/div>)\s*\n\s*([^\n<])/g, '$1\n\n$2');
    
    // CRITICAL: Process headings AGAIN after QUOTE blocks to catch any that might have been missed
    // This ensures headings that appear after QUOTE blocks are converted to HTML
    html = html.replace(/^### (.+)$/gm, (match, text) => {
        // Skip if already converted to HTML
        if (match.includes('<div style=')) return match;
        return `<div style="color: #ffaa00; font-size: 1rem; margin-top: 1rem; margin-bottom: 0.5rem; font-weight: bold;">${escapeHtml(text)}</div>`;
    });
    
    html = html.replace(/^## (.+)$/gm, (match, text) => {
        // Skip if already converted to HTML
        if (match.includes('<div style=')) return match;
        return `<div style="color: #ff8000; font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.75rem; font-weight: bold;">${escapeHtml(text)}</div>`;
    });
    
    html = html.replace(/^# (.+)$/gm, (match, text) => {
        // Skip if already converted to HTML
        if (match.includes('<div style=')) return match;
        return `<div style="color: #ff8000; font-size: 1.5rem; margin-top: 2rem; margin-bottom: 1rem; font-weight: bold;">${escapeHtml(text)}</div>`;
    });
    
    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, (match, text) => {
        return `<span style="color: #ff8000; font-weight: bold;">${escapeHtml(text)}</span>`;
    });
    
    html = html.replace(/\*(.+?)\*/g, (match, text) => {
        return `<span style="color: #ffaa00; font-style: italic;">${escapeHtml(text)}</span>`;
    });
    
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (match, text, url) => {
        return `<a href="${escapeHtml(url)}" target="_blank" style="color: #4a90e2; text-decoration: underline;">${escapeHtml(text)}</a>`;
    });
    
    // DON'T restore HTML blocks yet - keep them as placeholders through all processing
    // Restore individual HTML tags before paragraph processing
    Object.keys(htmlTagPlaceholders).forEach(placeholder => {
        html = html.replace(placeholder, htmlTagPlaceholders[placeholder]);
    });
    
    // CRITICAL FIX: Before paragraph processing, ensure headings and QUOTE blocks are on separate paragraphs
    // Split on closing </div> tags that are followed by a heading div or QUOTE/STAT div
    html = html.replace(/(<\/div>)\s*\n\s*(<div style="color: #ff8000[^"]*">|<div style="margin:0\.45rem 0; padding:0\.5rem 0\.65rem)/g, '$1\n\n$2');
    
    // Also ensure QUOTE/STAT blocks are separated from any content that follows them
    // This prevents content from being wrapped inside QUOTE blocks
    html = html.replace(/(<\/div>\s*<\/div>)\s*\n\s*([^<])/g, '$1\n\n$2');
    
    // Paragraphs (split by double newlines)
    // SIMPLER APPROACH: Split paragraphs, but if a paragraph contains an HTML block placeholder,
    // split it on the placeholder and process each part separately
    const paragraphs = html.split(/\n\n+/);
    html = paragraphs
        .map(p => {
            const trimmed = p.trim();
            if (!trimmed) return '';
            
            // If paragraph contains HTML block placeholder, split on it first
            if (trimmed.includes('__HTML_BLOCK_')) {
                const parts = trimmed.split(/(__HTML_BLOCK_\d+__)/);
                return parts.map(part => {
                    part = part.trim();
                    if (!part) return '';
                    
                    // If it's a placeholder, return as-is
                    if (part.match(/^__HTML_BLOCK_\d+__$/)) {
                        return part;
                    }
                    
                    // If it's already HTML (like a QUOTE div or heading div), return as-is
                    if (part.startsWith('<div') || part.startsWith('<span') || part.startsWith('<p')) {
                        return part;
                    }
                    
                    // Otherwise wrap in paragraph div
                    if (!part.startsWith('__HTML_TAG_')) {
                        return `<div style="margin-top: 0.5rem;">${part}</div>`;
                    }
                    return part;
                }).filter(Boolean).join('');
            }
            
            // CRITICAL: Check if paragraph contains QUOTE or STAT blocks that need to be isolated
            // This prevents content from being wrapped inside QUOTE/STAT blocks
            const quoteStatPattern = /(<div style="margin:0\.45rem 0; padding:0\.5rem 0\.65rem[^>]*>[\s\S]*?<\/div>\s*<\/div>)/g;
            const quoteStatMatches: Array<{ match: string; index: number }> = [];
            let match;
            quoteStatPattern.lastIndex = 0;
            while ((match = quoteStatPattern.exec(trimmed)) !== null) {
                quoteStatMatches.push({ match: match[1], index: match.index });
            }
            
            // If we found QUOTE/STAT blocks, split the paragraph around them
            if (quoteStatMatches.length > 0) {
                const parts: string[] = [];
                let lastIndex = 0;
                
                quoteStatMatches.forEach((m, idx) => {
                    // Add content before this block
                    if (m.index > lastIndex) {
                        const before = trimmed.substring(lastIndex, m.index).trim();
                        if (before) {
                            // Check if it's HTML or plain text
                            if (before.startsWith('<div') || before.startsWith('<span') || before.startsWith('<p')) {
                                parts.push(before);
                            } else {
                                parts.push(before);
                            }
                        }
                    }
                    // Add the QUOTE/STAT block itself (return as-is, it's already complete HTML)
                    parts.push(m.match);
                    lastIndex = m.index + m.match.length;
                });
                
                // Add any remaining content after the last block
                if (lastIndex < trimmed.length) {
                    const after = trimmed.substring(lastIndex).trim();
                    if (after) {
                        parts.push(after);
                    }
                }
                
                // Process each part separately
                return parts.map(part => {
                    part = part.trim();
                    if (!part) return '';
                    
                    // If it's already HTML (QUOTE/STAT block or heading), return as-is
                    if (part.startsWith('<div') || part.startsWith('<span') || part.startsWith('<p')) {
                        return part;
                    }
                    
                    // Otherwise wrap in paragraph div
                    return `<div style="margin-top: 0.5rem;">${part}</div>`;
                }).filter(Boolean).join('');
            }
            
            // If paragraph contains multiple HTML divs (like QUOTE block + heading), split them
            // This prevents them from being wrapped together
            // Use a more robust approach: find all opening and closing div tags and track depth
            const divOpenPattern = /<div[^>]*>/g;
            const divClosePattern = /<\/div>/g;
            const openMatches: number[] = [];
            const closeMatches: number[] = [];
            
            divOpenPattern.lastIndex = 0;
            while ((match = divOpenPattern.exec(trimmed)) !== null) {
                openMatches.push(match.index);
            }
            
            divClosePattern.lastIndex = 0;
            while ((match = divClosePattern.exec(trimmed)) !== null) {
                closeMatches.push(match.index);
            }
            
            // If we have multiple complete div structures (opening and closing pairs), split them
            if (openMatches.length > 1 && closeMatches.length >= openMatches.length) {
                const parts: string[] = [];
                let lastIndex = 0;
                let depth = 0;
                let currentDivStart = -1;
                
                // Match opening and closing divs to find complete structures
                let openIdx = 0;
                let closeIdx = 0;
                
                while (openIdx < openMatches.length || closeIdx < closeMatches.length) {
                    const nextOpen = openIdx < openMatches.length ? openMatches[openIdx] : Infinity;
                    const nextClose = closeIdx < closeMatches.length ? closeMatches[closeIdx] : Infinity;
                    
                    if (nextOpen < nextClose) {
                        if (depth === 0) {
                            // Add any text before this div
                            if (nextOpen > lastIndex) {
                                const before = trimmed.substring(lastIndex, nextOpen).trim();
                                if (before) parts.push(before);
                            }
                            currentDivStart = nextOpen;
                        }
                        depth++;
                        openIdx++;
                    } else {
                        depth--;
                        if (depth === 0 && currentDivStart >= 0) {
                            // Found a complete div structure
                            const divEnd = nextClose + 6; // '</div>' is 6 chars
                            parts.push(trimmed.substring(currentDivStart, divEnd));
                            lastIndex = divEnd;
                            currentDivStart = -1;
                        }
                        closeIdx++;
                    }
                }
                
                // Add any remaining text
                if (lastIndex < trimmed.length) {
                    const after = trimmed.substring(lastIndex).trim();
                    if (after) parts.push(after);
                }
                
                if (parts.length > 1) {
                    return parts.map(part => {
                        part = part.trim();
                        if (!part) return '';
                        // If it's already HTML, return as-is
                        if (part.startsWith('<div') || part.startsWith('<span') || part.startsWith('<p')) {
                            return part;
                        }
                        // Otherwise wrap
                        return `<div style="margin-top: 0.5rem;">${part}</div>`;
                    }).filter(Boolean).join('');
                }
            }
            
            // No placeholder - normal paragraph processing
            if (!trimmed.startsWith('<div') && !trimmed.startsWith('<span') && !trimmed.startsWith('<p') && 
                !trimmed.startsWith('__HTML_TAG_')) {
                return `<div style="margin-top: 0.5rem;">${trimmed}</div>`;
            }
            return trimmed;
        })
        .join('');
    
    // Remove newlines used only for formatting between HTML tags.
    html = html.replace(/>\s*\n\s*</g, '><');
    // Clean up preserved-tag placeholders
    html = html.replace(/__HTML_TAG_\d+__\s*\n\s*__HTML_TAG_\d+__/g, (m) => m.replace(/\s*\n\s*/g, ''));
    // Clean up HTML block placeholders - remove newlines around them but don't merge them
    html = html.replace(/(\S)\s*\n\s*(__HTML_BLOCK_\d+__)/g, '$1\n$2');
    html = html.replace(/(__HTML_BLOCK_\d+__)\s*\n\s*(\S)/g, '$1\n$2');

    // Single line breaks to <br/> - but protect placeholders
    // We need to be careful not to convert newlines that are part of protected placeholder context
    // First, temporarily replace placeholders with a safe marker
    const markerToPlaceholder: { [key: string]: string } = {};
    let markerIndex = 0;
    Object.keys(htmlBlockPlaceholders).forEach(placeholder => {
        const marker = `__MARKER_${markerIndex}_${Math.random().toString(36).substring(7)}__`;
        markerToPlaceholder[marker] = placeholder;
        html = html.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), marker);
        markerIndex++;
    });
    
    // Now convert newlines to <br/>
    html = html.replace(/\n/g, '<br/>');
    
    // Restore placeholders
    Object.keys(markerToPlaceholder).forEach(marker => {
        html = html.replace(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), markerToPlaceholder[marker]);
    });

    // Remove <br/> between HTML tags
    html = html.replace(/>\s*<br\s*\/>\s*</g, '><');
    
    // Clean up any <br/> tags immediately before or after placeholders
    // This prevents <br/> from ending up inside restored HTML blocks
    Object.keys(htmlBlockPlaceholders).forEach(placeholder => {
        const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Remove <br/> before placeholder
        html = html.replace(new RegExp(`<br\\s*/>\\s*${escaped}`, 'g'), placeholder);
        // Remove <br/> after placeholder
        html = html.replace(new RegExp(`${escaped}\\s*<br\\s*/>`, 'g'), placeholder);
        // Remove multiple <br/> tags around placeholder
        html = html.replace(new RegExp(`(<br\\s*/>\\s*)+${escaped}(\\s*<br\\s*/>)+`, 'g'), placeholder);
    });
    
    // NOW restore HTML blocks - after ALL processing is complete
    // Replace placeholders with actual HTML as complete, unbroken blocks
    // Use String.replace() with the actual placeholder string to avoid regex issues
    Object.keys(htmlBlockPlaceholders).forEach(placeholder => {
        const htmlBlock = htmlBlockPlaceholders[placeholder];
        const beforeCount = (html.match(new RegExp(placeholder, 'g')) || []).length;
        // Replace all occurrences of the placeholder with the actual HTML
        // Do a simple string replace to ensure the HTML is inserted exactly as-is
        while (html.includes(placeholder)) {
            html = html.replace(placeholder, htmlBlock);
        }
        const afterCount = (html.match(new RegExp(placeholder, 'g')) || []).length;
        console.log(`[markdownToHtml] Restored HTML block ${placeholder}:`, {
            found: beforeCount,
            restored: beforeCount - afterCount,
            htmlBlockLength: htmlBlock.length,
            htmlBlockPreview: htmlBlock.substring(0, 200) + '...'
        });
    });
    
    console.log(`[markdownToHtml] Final HTML length: ${html.length}`);
    
    return html;
}









