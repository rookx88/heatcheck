import { escapeHtml } from './html-escape';

/**
 * Convert markdown to HTML with datacenter styling
 */
export function markdownToHtml(markdown: string): string {
    if (!markdown) return '';
    
    let html = markdown;
    
    // Headers
    html = html.replace(/^### (.+)$/gm, (match, text) => {
        return `<div style="color: #ffaa00; fontSize: 1rem; marginTop: 1rem; marginBottom: 0.5rem; fontWeight: bold;">${escapeHtml(text)}</div>`;
    });
    
    html = html.replace(/^## (.+)$/gm, (match, text) => {
        return `<div style="color: #ff8000; fontSize: 1.2rem; marginTop: 1.5rem; marginBottom: 0.75rem; fontWeight: bold;">${escapeHtml(text)}</div>`;
    });
    
    html = html.replace(/^# (.+)$/gm, (match, text) => {
        return `<div style="color: #ff8000; fontSize: 1.5rem; marginTop: 2rem; marginBottom: 1rem; fontWeight: bold;">${escapeHtml(text)}</div>`;
    });
    
    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, (match, text) => {
        return `<span style="color: #ff8000; fontWeight: bold;">${escapeHtml(text)}</span>`;
    });
    
    html = html.replace(/\*(.+?)\*/g, (match, text) => {
        return `<span style="color: #ffaa00; fontStyle: italic;">${escapeHtml(text)}</span>`;
    });
    
    // Links
    html = html.replace(/\[([^\]]+)\]\(([^\)]+)\)/g, (match, text, url) => {
        return `<a href="${escapeHtml(url)}" target="_blank" style="color: #4a90e2; textDecoration: underline;">${escapeHtml(text)}</a>`;
    });
    
    // Paragraphs (split by double newlines)
    const paragraphs = html.split(/\n\n+/);
    html = paragraphs
        .map(p => {
            const trimmed = p.trim();
            if (!trimmed) return '';
            // Wrap in div if not already wrapped by headers
            if (!trimmed.startsWith('<div')) {
                return `<div style="marginTop: 1rem;">${trimmed}</div>`;
            }
            return trimmed;
        })
        .join('');
    
    // Single line breaks to <br/>
    html = html.replace(/\n/g, '<br/>');
    
    return html;
}








