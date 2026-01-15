import { escapeHtml } from './html-escape';

/**
 * Convert markdown to HTML with datacenter styling
 * Preserves existing HTML tags in the content
 */
export function markdownToHtml(markdown: string): string {
    if (!markdown) return '';
    
    // First, extract and preserve existing HTML tags
    const htmlTagPlaceholders: { [key: string]: string } = {};
    let placeholderIndex = 0;
    
    // Replace HTML tags with placeholders before processing
    let processedMarkdown = markdown.replace(/<[^>]+>/g, (match) => {
        const placeholder = `__HTML_TAG_${placeholderIndex}__`;
        htmlTagPlaceholders[placeholder] = match;
        placeholderIndex++;
        return placeholder;
    });
    
    let html = processedMarkdown;
    
    // Headers
    html = html.replace(/^### (.+)$/gm, (match, text) => {
        return `<div style="color: #ffaa00; font-size: 1rem; margin-top: 1rem; margin-bottom: 0.5rem; font-weight: bold;">${escapeHtml(text)}</div>`;
    });
    
    html = html.replace(/^## (.+)$/gm, (match, text) => {
        return `<div style="color: #ff8000; font-size: 1.2rem; margin-top: 1.5rem; margin-bottom: 0.75rem; font-weight: bold;">${escapeHtml(text)}</div>`;
    });
    
    html = html.replace(/^# (.+)$/gm, (match, text) => {
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
    
    // Restore HTML tags before paragraph processing
    Object.keys(htmlTagPlaceholders).forEach(placeholder => {
        html = html.replace(placeholder, htmlTagPlaceholders[placeholder]);
    });
    
    // Paragraphs (split by double newlines)
    const paragraphs = html.split(/\n\n+/);
    html = paragraphs
        .map(p => {
            const trimmed = p.trim();
            if (!trimmed) return '';
            // Wrap in div if not already wrapped by headers
            if (!trimmed.startsWith('<div')) {
                return `<div style="margin-top: 1rem;">${trimmed}</div>`;
            }
            return trimmed;
        })
        .join('');
    
    // Single line breaks to <br/>
    html = html.replace(/\n/g, '<br/>');
    
    return html;
}









