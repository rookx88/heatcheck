/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(text: string | undefined | null): string {
    if (text == null) {
        return '';
    }
    const map: Record<string, string> = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
    };
    return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Escape attribute values
 */
export function escapeAttr(text: string | undefined | null): string {
    return escapeHtml(text).replace(/\n/g, ' ');
}
















