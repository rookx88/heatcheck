/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(text: string): string {
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Escape attribute values
 */
export function escapeAttr(text: string): string {
    return escapeHtml(text).replace(/\n/g, ' ');
}












