/**
 * Generate URL-friendly slug from headline
 */
export function generateSlug(headline: string): string {
    return headline
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .replace(/-+/g, '-') // Replace multiple hyphens with single hyphen
        .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
}

/**
 * Ensure slug is unique by appending a number if needed
 */
export function ensureUniqueSlug(slug: string, existingSlugs: Set<string>): string {
    if (!existingSlugs.has(slug)) {
        return slug;
    }
    
    let counter = 1;
    let uniqueSlug = `${slug}-${counter}`;
    while (existingSlugs.has(uniqueSlug)) {
        counter++;
        uniqueSlug = `${slug}-${counter}`;
    }
    
    return uniqueSlug;
}








