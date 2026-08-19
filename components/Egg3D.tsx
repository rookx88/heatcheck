// The shared 3D interactable egg — one component, three contexts (shop listing,
// owned-eggs inventory, incubator), fully described by its props. Ported from the
// interactive-amphibian-egg prototype (NeopianEgg): CSS-3D "jelly" shell of six
// elliptical faces on a preserve-3d parent, drag-to-rotate matching the Tank cube's
// interaction grammar, idle auto-rotation, and a crack-open hatch animation.
//
// Deliberate differences from the prototype:
//   - `hatched` is CONTROLLED by the parent. A tap never cracks the egg by itself —
//     it fires onHatchRequest (and only when hatchEnabled), and the parent flips
//     `hatched` after the server confirms the real hatch. Shop/inventory render with
//     hatchEnabled=false, where tapping does nothing dramatic.
//   - No color picker: `colorway` is a single fixed value derived from the catalog
//     row's real data (colorwayFromCatalog). The prototype's multi-swatch picker was
//     a dev-time preview tool and must not ship.
//   - No backdrop-filter on the faces: it silently breaks inside preserve-3d trees in
//     Firefox (see the note in Fishtank.tsx) — the layered gradients + inset white
//     glow carry the jelly look on their own.
//   - The idle-rotation rAF loop only does work while `active` (callers also mount
//     just one Egg3D at a time, so at most one loop ever runs).

import React, { useRef } from 'react';
import { motion, useMotionValue, useSpring, useAnimationFrame } from 'motion/react';

export interface EggColorway {
    hex: string;         // opaque - tadpole body/tail
    translucent: string; // see-through - shell spots + glow
}

// One colorway per catalog SKU, derived from its real render inputs ('filter' eggs
// carry a hue; the founder egg is a custom asset shown as ivory). Same input, same
// output: two same-color eggs are visually identical by construction.
export function colorwayFromCatalog(egg: { renderMode: string | null; hue: number | null }): EggColorway {
    if (egg.renderMode === 'custom_asset') {
        return { hex: 'hsl(48, 45%, 88%)', translucent: 'hsla(48, 45%, 82%, 0.8)' };
    }
    const h = egg.hue ?? 180;
    return { hex: `hsl(${h}, 85%, 72%)`, translucent: `hsla(${h}, 85%, 72%, 0.8)` };
}

const faceDefs = [
    { id: 'front', rotateY: 0, rotateX: 0 },
    { id: 'back', rotateY: 180, rotateX: 0 },
    { id: 'left', rotateY: -90, rotateX: 0 },
    { id: 'right', rotateY: 90, rotateX: 0 },
    { id: 'top', rotateY: 0, rotateX: 90 },
    { id: 'bottom', rotateY: 0, rotateX: -90 },
];

// The face math below is written against this fixed geometry; `size` scales the
// rendered result from outside the perspective context rather than re-deriving
// per-face offsets.
const BASE = 200;

interface Egg3DProps {
    colorway: EggColorway;
    // false in the shop and inventory (egg is inspectable/rotatable, taps inert);
    // true ONLY in the incubator — the one context where tapping means "hatch".
    hatchEnabled: boolean;
    // Controlled by the parent; flipping it true plays the crack-open animation.
    hatched: boolean;
    // Hatch request in flight: taps are ignored and the egg wobbles as feedback.
    pending?: boolean;
    onHatchRequest?: () => void;
    // Gates the idle-rotation rAF loop; only the focused/on-screen egg may be active.
    active?: boolean;
    size?: number;
}

export default function Egg3D({
    colorway,
    hatchEnabled,
    hatched,
    pending = false,
    onHatchRequest,
    active = true,
    size = BASE,
}: Egg3DProps) {
    const dragX = useMotionValue(0);
    const dragY = useMotionValue(0);
    const rotateX = useSpring(dragY, { stiffness: 80, damping: 25 });
    const rotateY = useSpring(dragX, { stiffness: 80, damping: 25 });
    const isDragging = useRef(false);
    // Read once - a live listener isn't worth it for a preference that effectively
    // never changes mid-session.
    const reducedMotion = useRef(
        typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ).current;

    useAnimationFrame((_t, delta) => {
        if (!active || reducedMotion) return;
        if (!isDragging.current && !hatched) {
            dragX.set(dragX.get() + delta * 0.02);
            dragY.set(dragY.get() + delta * 0.01);
        } else if (hatched) {
            dragX.set(dragX.get() + delta * 0.005);
            dragY.set(dragY.get() + delta * 0.002);
        }
    });

    const scale = size / BASE;
    // The shell faces overhang the 200x200 stage (vertical faces are 260 tall, offset
    // -30, magnified further by the perspective projection while spinning), so the
    // wrapper reserves generous headroom - the reserved box must contain the painted
    // extent or the egg grazes the caption/price text below it.
    const wrapperW = Math.ceil(size * 1.5);
    const wrapperH = Math.ceil(size * 1.8);

    return (
        <div style={{ position: 'relative', width: wrapperW, height: wrapperH, margin: '0 auto' }}>
            <motion.div
                style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    // Motion-native `scale`, NOT a raw `transform` string: this element
                    // animates `rotate` (the pending wobble), and motion rebuilds
                    // `transform` from its own values - a static transform string here
                    // gets discarded, silently rendering the egg unscaled.
                    scale,
                }}
                // Tap-feedback wobble while the server confirms the hatch — visibly "doing
                // something" without playing the irreversible crack early.
                animate={pending && !reducedMotion ? { rotate: [-2, 2, -2] } : { rotate: 0 }}
                transition={pending ? { duration: 0.3, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
            >
                <div style={{ perspective: '1200px', width: BASE, height: BASE, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <motion.div
                        style={{
                            position: 'relative',
                            width: BASE,
                            height: BASE,
                            rotateX,
                            rotateY,
                            transformStyle: 'preserve-3d',
                            cursor: hatched ? 'default' : 'grab',
                            touchAction: 'none',
                            userSelect: 'none',
                        }}
                        onPanStart={() => { isDragging.current = true; }}
                        onPan={(_e, info) => {
                            dragX.set(dragX.get() + info.delta.x * 0.5);
                            dragY.set(dragY.get() - info.delta.y * 0.5);
                        }}
                        onPanEnd={() => { isDragging.current = false; }}
                        onTap={() => {
                            if (hatchEnabled && !hatched && !pending) onHatchRequest?.();
                        }}
                        whileTap={{ cursor: 'grabbing' }}
                        whileHover={{ scale: hatched ? 1 : 1.05 }}
                    >
                        {/* Tadpole inside the shell; grows on hatch. */}
                        <motion.div
                            style={{
                                position: 'absolute',
                                left: '50%',
                                top: '50%',
                                marginLeft: -35,
                                marginTop: -35,
                                width: 70,
                                height: 70,
                                transformStyle: 'preserve-3d',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                            }}
                            animate={{
                                scale: hatched ? 2.5 : 1,
                                y: reducedMotion ? 0 : hatched ? [0, -30, 0] : [0, -10, 0],
                            }}
                            // Separate transitions: the grow is one-shot (sharing the looping
                            // transition made the prototype's tadpole re-pulse 1 -> 2.5 forever),
                            // only the bob repeats.
                            transition={{
                                scale: { duration: 1.2, ease: 'easeOut' },
                                y: reducedMotion
                                    ? { duration: 0 }
                                    : { duration: hatched ? 1.5 : 2, repeat: Infinity, ease: 'easeInOut' },
                            }}
                        >
                            <motion.div
                                style={{
                                    width: 70,
                                    height: 70,
                                    borderRadius: '50% 50% 45% 45%',
                                    backgroundColor: colorway.hex,
                                    boxShadow: `inset -8px -8px 20px rgba(0,0,0,0.15), 0 10px 20px ${colorway.translucent}`,
                                    display: 'flex',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    zIndex: 2,
                                }}
                            >
                                <div style={{ display: 'flex', gap: '14px', marginTop: '-12px' }}>
                                    <div style={{ width: 12, height: 12, backgroundColor: '#fff', borderRadius: '50%', display: 'flex' }}>
                                        <div style={{ width: 6, height: 6, backgroundColor: '#1a1a1a', borderRadius: '50%', margin: '2px 0 0 2px' }} />
                                    </div>
                                    <div style={{ width: 12, height: 12, backgroundColor: '#fff', borderRadius: '50%', display: 'flex' }}>
                                        <div style={{ width: 6, height: 6, backgroundColor: '#1a1a1a', borderRadius: '50%', margin: '2px 0 0 2px' }} />
                                    </div>
                                </div>
                                <div style={{ position: 'absolute', top: '50%', left: '15%', width: 12, height: 6, backgroundColor: '#ff99aa', borderRadius: '50%', opacity: 0.8 }} />
                                <div style={{ position: 'absolute', top: '50%', right: '15%', width: 12, height: 6, backgroundColor: '#ff99aa', borderRadius: '50%', opacity: 0.8 }} />
                            </motion.div>
                            <motion.div
                                style={{
                                    width: 16,
                                    height: 55,
                                    backgroundColor: colorway.hex,
                                    borderRadius: '0 0 50% 50%',
                                    marginTop: -15,
                                    transformOrigin: 'top center',
                                    zIndex: 1,
                                }}
                                animate={reducedMotion ? { rotateZ: 0 } : { rotateZ: [-35, 35, -35] }}
                                transition={reducedMotion ? { duration: 0 } : { duration: 0.4, repeat: Infinity, ease: 'easeInOut' }}
                            />
                        </motion.div>

                        {/* Jelly shell: six faces pushed outward along their own normals. On
                            hatch they fling to translateZ(800) scale(0); reduced-motion gets a
                            plain fade instead of the 3D burst. */}
                        {faceDefs.map((face) => {
                            const isVertical = ['front', 'back', 'left', 'right'].includes(face.id);
                            const faceHeight = isVertical ? 260 : 200;
                            const topOffset = isVertical ? -30 : 0;
                            const zOffset = isVertical ? 100 : 130;
                            const borderRadius = isVertical ? '50% 50% 50% 50% / 60% 60% 40% 40%' : '50%';
                            const restTransform = `rotateY(${face.rotateY}deg) rotateX(${face.rotateX}deg) translateZ(${zOffset}px) scale(1)`;
                            const burstTransform = `rotateY(${face.rotateY}deg) rotateX(${face.rotateX}deg) translateZ(800px) scale(0)`;

                            return (
                                <motion.div
                                    key={face.id}
                                    style={{
                                        position: 'absolute',
                                        top: topOffset,
                                        left: 0,
                                        width: 200,
                                        height: faceHeight,
                                        borderRadius,
                                        background: `
                                          radial-gradient(circle at 20% 30%, ${colorway.translucent} 15%, transparent 18%),
                                          radial-gradient(circle at 80% 60%, ${colorway.translucent} 20%, transparent 24%),
                                          radial-gradient(circle at 40% 80%, ${colorway.translucent} 12%, transparent 15%),
                                          rgba(128, 229, 255, 0.65)
                                        `,
                                        border: '4px solid rgba(255, 255, 255, 0.8)',
                                        boxShadow: 'inset 0 0 30px rgba(255, 255, 255, 1), 0 8px 24px rgba(0,0,0,0.1)',
                                        backfaceVisibility: 'visible',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                    }}
                                    initial={{ transform: restTransform }}
                                    animate={{
                                        transform: hatched && !reducedMotion ? burstTransform : restTransform,
                                        opacity: hatched ? 0 : 1,
                                    }}
                                    transition={{
                                        duration: hatched ? 1.2 : 0,
                                        ease: hatched ? 'backIn' : 'linear',
                                    }}
                                >
                                    <div
                                        style={{
                                            position: 'absolute',
                                            top: '10%',
                                            left: '20%',
                                            width: '30%',
                                            height: '15%',
                                            backgroundColor: 'rgba(255, 255, 255, 0.6)',
                                            borderRadius: '50%',
                                            transform: 'rotate(-20deg)',
                                            filter: 'blur(2px)',
                                        }}
                                    />
                                </motion.div>
                            );
                        })}
                    </motion.div>
                </div>
            </motion.div>

            {/* Hatch flash, scoped to this stage (the prototype flashed the whole page). */}
            <motion.div
                style={{
                    position: 'absolute',
                    inset: 0,
                    backgroundColor: '#ffffff',
                    borderRadius: '50%',
                    filter: 'blur(12px)',
                    pointerEvents: 'none',
                    zIndex: 20,
                }}
                initial={{ opacity: 0 }}
                animate={{ opacity: hatched && !reducedMotion ? [0, 1, 0] : 0 }}
                transition={{ duration: 2.5, times: [0, 0.05, 1], ease: 'easeOut' }}
            />
        </div>
    );
}
