// How an egg is drawn as a flat sprite: ONE piece of shell art, tinted per catalog
// SKU. The direct counterpart of petRender.ts, and deliberately the same mechanism -
// two same-colour eggs are visually identical by construction, and adding a colourway
// is a catalog row, never a new file.
//
// This is the sprite path (the inventory list). It does NOT replace components/Egg3D
// and colorwayFromCatalog, which build the rotatable jelly egg out of CSS gradients
// for the shop and the incubator - those need a colour VALUE, this needs a filter, and
// both derive from the same two catalog fields (render_mode + hue) so they cannot
// disagree about what an egg looks like.
//
// The base art is peach (measured dominant hue ~28deg over its saturated pixels),
// while catalog hues are ABSOLUTE colour targets (red 0, blue 220, green 120,
// purple 275) and CSS hue-rotate is RELATIVE - so, exactly as in petRender.ts, the
// filter rotates by the difference. Desaturated pixels (the highlight, the shadow
// under the shell) are untouched by hue-rotate, which is what keeps every colourway
// reading as the same egg in a different colour rather than a flat recolour.

// A full literal path, not a template string: generate-static-site.ts's
// verifyReferencedImages() scans shipped bundles for /assets/images/... literals and
// throws when one isn't in NEW_SITE_IMAGES. Keeping it literal is what buys that check.
export const EGG_IMAGE_SRC = '/assets/images/eggs/axo_pet_egg.png';

const BASE_ART_HUE = 28;

/**
 * The CSS `filter` value for an egg's shell, or undefined to leave the art as drawn.
 *
 * Undefined for custom_asset eggs (founder ivory): colorwayFromCatalog shows those as
 * ivory rather than a hue, and the unfiltered peach shell is the closest the shared
 * art gets - the same "render the base until a dedicated skin ships" concession
 * petRender.ts makes for founder pets.
 */
export function eggImageFilter(egg: { renderMode: string | null; hue: number | null }): string | undefined {
    if (egg.renderMode !== 'filter') return undefined;
    const hue = Number(egg.hue);
    if (!Number.isFinite(hue)) return undefined;
    return `hue-rotate(${Math.round(hue - BASE_ART_HUE)}deg)`;
}
