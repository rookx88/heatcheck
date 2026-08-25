// How a pet is drawn everywhere (hatch reveal, pet widget, feed modal portrait):
// one shared base body image, tinted per pet. The base axolotl art is GREEN with
// hue ~93deg, while catalog/render_config hues are ABSOLUTE color targets (red 0,
// blue 220, green 120, purple 275) - and CSS hue-rotate is RELATIVE - so the filter
// rotates by the difference. Desaturated pixels (white shorts, eyes) are untouched
// by hue-rotate, which is exactly the wanted behavior - except the shorts' racing
// stripe, which is currently saturated and will shift color on non-green pets
// (known follow-up, not yet fixed). custom_asset pets (founder ivory) render the
// base art unfiltered until their dedicated skin ships.

export const PET_IMAGE_SRC = '/assets/images/pets/mud_puppy_base_axol.png';

const BASE_ART_HUE = 93;

export function petImageFilter(renderMode: string | null | undefined, renderConfig: Record<string, unknown> | null | undefined): string | undefined {
    if (renderMode !== 'filter') return undefined;
    const hue = Number(renderConfig?.hue);
    if (!Number.isFinite(hue)) return undefined;
    return `hue-rotate(${Math.round(hue - BASE_ART_HUE)}deg)`;
}

// "Green Mud Puppy" - the display name for an unnamed pet.
export function petDisplayName(name: string | null | undefined, color: string | null | undefined): string {
    if (name) return name;
    const c = (color ?? '').replace(/_/g, ' ');
    return c ? `${c.charAt(0).toUpperCase()}${c.slice(1)} Mud Puppy` : 'Mud Puppy';
}
