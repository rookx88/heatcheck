// The one place Discord-embed branding lives. Embeds can't use custom fonts or
// backgrounds, so "the card aesthetic" (leaderboard-image.ts / me-card.ts: navy,
// black plates, Orbitron green, system colors) translates here to: the color system
// on the accent strip, plate-style ALL-CAPS author labels echoing the cards' black
// plates, and a consistent trust footer on public posts. Every embed surface except
// the real Tank card (deliberately site-branded - gold + OG art) builds through
// brandEmbed so the system can't drift.

export const BRAND = {
    green: 0x31e874, // system / info / your-stats
    gold: 0xffc72c, // tank-adjacent + giveaways
    purple: 0xa986ff, // community picks
    teal: 0x2fe6d9, // settlements
    navy: 0x0e0a38,
} as const;

export type BrandKind = 'system' | 'giveaway' | 'community' | 'settlement';

const KIND_COLOR: Record<BrandKind, number> = {
    system: BRAND.green,
    giveaway: BRAND.gold,
    community: BRAND.purple,
    settlement: BRAND.teal,
};

export const TRUST_LINE = 'Entertainment only — no real-money wagering. Heatchecks never distributes prizes.';

export interface BrandEmbedOptions {
    kind: BrandKind;
    // Plate-style caps label, e.g. "COMMUNITY PICK — SETTLED". Omit on surfaces
    // that attach a pre-rendered banner above the embed - the banner IS the plate
    // there, and repeating it reads as a stutter.
    plate?: string;
    title?: string;
    url?: string;
    body?: string;
    fields?: { name: string; value: string; inline?: boolean }[];
    // 'trust' on public channel posts; omit on ephemeral surfaces.
    footer?: 'trust';
}

export function brandEmbed(opts: BrandEmbedOptions): Record<string, unknown> {
    const embed: Record<string, unknown> = {
        color: KIND_COLOR[opts.kind],
    };
    if (opts.plate) embed.author = { name: opts.plate.toUpperCase() };
    if (opts.title) embed.title = opts.title;
    if (opts.url) embed.url = opts.url;
    if (opts.body) embed.description = opts.body;
    if (opts.fields?.length) embed.fields = opts.fields;
    if (opts.footer === 'trust') embed.footer = { text: TRUST_LINE };
    return embed;
}
