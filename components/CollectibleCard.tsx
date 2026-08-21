// The Genesis Collection trading card - the tri-fold holographic card, one component
// for every edition, fully described by its props. Ported from the heatchecks-cards/
// prototypes (gold-edition/neon-edition src/App.tsx), which are byte-identical except
// three theme lines - here that's the `edition` prop driving a .cc--<edition> modifier
// class (cover border + hover sheen + serial stamp accent via CSS custom properties).
//
// Deliberate differences from the prototype (Egg3D porting doctrine):
//   - No sport/action selector UI: the Genesis run is the soccer KICK scene, period.
//     The other sports' SVG scenes and their keyframes did not come along.
//   - Display data (cover art, the holo-sphere match texts, serial/mint) comes from
//     props - the catalog config row - not hardcoded strings.
//   - Tailwind hand-converted to CollectibleCard.css (this project doesn't use it);
//     keyframes are cc-prefixed since they land in shared page CSS scope. That
//     includes glossSweep, which lived in the prototype's index.css, not its App.tsx.
//   - The serial stamp on the back panel is new: "No. 042 / 250" under the Genesis
//     Collection inscription's aesthetic, in the edition accent.
//   - fold/unfold (isOpen) stays internal: it's transient viewer UI, nothing
//     server-side depends on it (unlike Egg3D's `hatched`).
// Kept verbatim: the three-panel fold assembly, the window-mousemove spring tilt
// (the component only mounts inside the full-screen viewer, so the listener's scope
// is right), and the registerBgVideo singleton that keeps the three per-panel copies
// of the backdrop video on the same frame so no seam shows at panel boundaries.

import React, { useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useTransform, useSpring } from 'motion/react';
import './CollectibleCard.css';

export interface CollectibleCardProps {
    edition: 'gold' | 'neon';
    coverSrc: string; // /assets/images/collectibles/<file>.jpg
    coverAlt: string;
    videoSrc?: string; // /assets/videos/soccerbackdrop.mp4; omit = no video layer
    serial: number;
    mintSize: number;
    matchTitle: string; // holo-sphere face A
    matchCaption: string; // holo-sphere face B
}

const FlameTail = ({ mode = 'flameDirection' }: { mode?: 'flameDirection' | 'left' | 'right' }) => (
    <g
        style={mode === 'flameDirection' ? { animation: 'ccFlameDirection 4s infinite' } : undefined}
        transform={mode === 'left' ? 'scale(-1, 1)' : mode === 'right' ? 'scale(1, 1)' : undefined}
    >
        <g style={{ animation: 'ccFlameFlicker 0.1s infinite alternate', transformOrigin: '0px 0px' }}>
            <path d="M 20 -20 Q 80 -40 120 -10 Q 70 0 100 20 Q 50 30 20 20 Q -10 0 20 -20 Z" fill="rgba(255,30,30,0.7)" />
            <path d="M 20 -10 Q 60 -20 90 -5 Q 50 0 80 15 Q 40 20 20 10 Q 0 0 20 -10 Z" fill="rgba(6,182,212,0.8)" />
            <circle cx="90" cy="-25" r="15" fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth="1" strokeDasharray="2 2" />
            <circle cx="120" cy="10" r="20" fill="rgba(255,30,30,0.1)" stroke="#ff1e1e" strokeWidth="1" strokeDasharray="2 2" />
            <circle cx="150" cy="-5" r="10" fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth="1" />
        </g>
    </g>
);

// The soccer KICK scene - goal frame, boot swing, spinning ball, impact shockwaves.
const SoccerKickScene = () => (
    <g>
        <g transform="translate(650, 180)" filter="url(#ccGlow)">
            <path d="M 0 -70 L 0 70 M -30 70 L 30 70 M 0 -70 L 40 -40 L 40 70 L 0 70" fill="none" stroke="#06b6d4" strokeWidth="3" />
            <path d="M 0 -70 L 40 70 M 0 -40 L 40 70 M 0 -10 L 40 70 M 0 20 L 40 70" fill="none" stroke="#ec4899" strokeWidth="1" opacity="0.5" strokeDasharray="2 2" />
        </g>
        <circle cx="150" cy="250" fill="none" stroke="#06b6d4" style={{ animation: 'ccLeftShockwave 4s infinite' }} />
        <circle cx="650" cy="180" fill="none" stroke="#06b6d4" style={{ animation: 'ccRightShockwave 4s infinite' }} />
        <circle cx="650" cy="180" fill="#ec4899" style={{ animation: 'ccRightCore 4s infinite' }} />
        <g style={{ animation: 'ccBootSwing 4s infinite', transformOrigin: '0px 0px' }} filter="url(#ccGlow)">
            <path d="M -40 -30 L -20 20 L 10 30 L 30 20 L 20 -10 Z" fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth="2" strokeDasharray="2 2" />
            <path d="M 10 30 L 10 40 M 0 25 L 0 35 M -10 20 L -10 30" stroke="#ec4899" strokeWidth="2" />
        </g>
        <g style={{ animation: 'ccSoccerTrajectory 4s infinite', transformOrigin: '0px 0px' }} filter="url(#ccGlow)">
            <FlameTail mode="left" />
            <g style={{ animation: 'ccSoccerSpin 4s infinite' }}>
                <circle cx="0" cy="0" r="30" fill="rgba(6,182,212,0.3)" stroke="url(#ccHoloGradient)" strokeWidth="3" strokeDasharray="8 4" />
                <polygon points="0,-15 10,-5 6,12 -6,12 -10,-5" fill="rgba(0,0,0,0.8)" stroke="#ec4899" strokeWidth="2" />
                <line x1="0" y1="-15" x2="0" y2="-30" stroke="#06b6d4" strokeWidth="2" />
                <line x1="10" y1="-5" x2="25" y2="-10" stroke="#06b6d4" strokeWidth="2" />
                <line x1="6" y1="12" x2="15" y2="25" stroke="#06b6d4" strokeWidth="2" />
                <line x1="-6" y1="12" x2="-15" y2="25" stroke="#06b6d4" strokeWidth="2" />
                <line x1="-10" y1="-5" x2="-25" y2="-10" stroke="#06b6d4" strokeWidth="2" />
            </g>
        </g>
    </g>
);

// The open card renders three clipped copies of the same backdrop video (one per
// panel); this keeps them on the same frame so no seam shows at panel boundaries.
const bgVideos = new Set<HTMLVideoElement>();
let bgSyncTimer: ReturnType<typeof setInterval> | null = null;
const registerBgVideo = (v: HTMLVideoElement) => {
    bgVideos.add(v);
    if (bgSyncTimer === null) {
        bgSyncTimer = setInterval(() => {
            const [master, ...rest] = [...bgVideos];
            if (!master || master.paused) return;
            for (const slave of rest) {
                if (Math.abs(slave.currentTime - master.currentTime) > 0.25) {
                    slave.currentTime = master.currentTime;
                }
            }
        }, 400);
    }
    return () => {
        bgVideos.delete(v);
        if (bgVideos.size === 0 && bgSyncTimer !== null) {
            clearInterval(bgSyncTimer);
            bgSyncTimer = null;
        }
    };
};

const InsideCanvas = ({
    isOpen,
    videoSrc,
    matchTitle,
    matchCaption,
}: {
    isOpen: boolean;
    videoSrc?: string;
    matchTitle: string;
    matchCaption: string;
}) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        return registerBgVideo(video);
    }, [videoSrc]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (isOpen) {
            // Restart from frame 0 on every open so all three panel copies stay in sync
            video.currentTime = 0;
            video.play().catch(() => {});
        } else {
            video.pause();
        }
    }, [isOpen, videoSrc]);

    return (
        <div className={`cc-canvas${!isOpen ? ' cc-pause' : ''}`}>
            {/* Deep space / projection void */}
            <div className="cc-void"></div>

            {/* Video backdrop - sits under the sun, grid, and hologram layers */}
            {videoSrc && (
                <video ref={videoRef} src={videoSrc} muted loop playsInline preload="auto" className="cc-video" />
            )}

            {/* Projection source glow */}
            <div className="cc-source-glow"></div>

            {/* Synthwave sun (wireframe/hologram style) */}
            <div className="cc-sun">
                <div className="cc-sun-line"></div>
                <div className="cc-sun-line"></div>
                <div className="cc-sun-line"></div>
                <div className="cc-sun-line"></div>
                <div className="cc-sun-line"></div>
                <div className="cc-sun-line"></div>
            </div>

            {/* Rotating holo-sphere carrying the match texts, one on each side */}
            <div className="cc-sphere">
                <div className="cc-sphere-core">
                    {/* Wireframe longitude rings that sweep as the sphere turns */}
                    <div className="cc-sphere-ring cc-sphere-ring--pink"></div>
                    <div className="cc-sphere-ring cc-sphere-ring--cyan" style={{ transform: 'rotateY(60deg)' }}></div>
                    <div className="cc-sphere-ring cc-sphere-ring--cyan" style={{ transform: 'rotateY(120deg)' }}></div>

                    {/* Face A: match title */}
                    <div className="cc-sphere-face" style={{ transform: 'translateZ(70px)', backfaceVisibility: 'hidden' }}>
                        <p className="cc-sphere-title">{matchTitle}</p>
                    </div>

                    {/* Face B: highlight caption */}
                    <div
                        className="cc-sphere-face"
                        style={{ transform: 'rotateY(180deg) translateZ(70px)', backfaceVisibility: 'hidden' }}
                    >
                        <p className="cc-sphere-caption">{matchCaption}</p>
                    </div>
                </div>
            </div>

            {/* Laser grid floor */}
            <div className="cc-floor">
                <div className="cc-grid"></div>
            </div>

            {/* Hologram canvas (full width) */}
            <div className="cc-holo-layer">
                <svg width="720" height="340" viewBox="0 0 720 340" className="cc-holo-svg">
                    <defs>
                        <linearGradient id="ccHoloGradient" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#06b6d4" />
                            <stop offset="50%" stopColor="#ec4899" />
                            <stop offset="100%" stopColor="#06b6d4" />
                        </linearGradient>
                        <filter id="ccGlow">
                            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                            <feMerge>
                                <feMergeNode in="coloredBlur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>
                    <SoccerKickScene />
                </svg>
            </div>

            {/* Hologram scanlines overlay */}
            <div className="cc-scanlines"></div>

            {/* Holographic scanning beam */}
            <div className="cc-beam-wrap">
                <div className="cc-beam"></div>
            </div>
        </div>
    );
};

// The card's own bounding box never changes size - only its CSS `scale()` does - so
// the reference footprint is the WIDE case (both flaps open, coplanar with the
// center panel): three 240px panels side by side, 340px tall. Fitting to that means
// opening the card on a small phone never pushes flaps past the screen edge, whether
// it's folded or open. A fixed breakpoint scale (e.g. one flat 0.75 below 768px)
// can't do this: 720 * 0.75 = 540px is still wider than most phones.
const CARD_W = 720;
const CARD_H = 340;

function computeCardScale(): number {
    if (typeof window === 'undefined') return 1;
    const availW = window.innerWidth - 32; // ~16px breathing room each side
    const availH = window.innerHeight - 120; // hint text + top/bottom breathing room
    // Never scale UP past 1 (desktop keeps its natural size); never scale below a
    // floor where the art/text stop being legible - a defensive clamp, not something
    // any real phone screen should hit.
    return Math.max(0.35, Math.min(1, availW / CARD_W, availH / CARD_H));
}

export const CollectibleCard: React.FC<CollectibleCardProps> = ({
    edition,
    coverSrc,
    coverAlt,
    videoSrc,
    serial,
    mintSize,
    matchTitle,
    matchCaption,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    // Lazy-initialized so the first paint is already correctly scaled (no flash of an
    // oversized card before the resize listener has a chance to run).
    const [scale, setScale] = useState(computeCardScale);

    useEffect(() => {
        const onResize = () => setScale(computeCardScale());
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
            window.removeEventListener('orientationchange', onResize);
        };
    }, []);

    const x = useMotionValue(0.5);
    const y = useMotionValue(0.5);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            x.set(e.clientX / window.innerWidth);
            y.set(e.clientY / window.innerHeight);
        };
        window.addEventListener('mousemove', handleMouseMove);
        return () => window.removeEventListener('mousemove', handleMouseMove);
    }, [x, y]);

    // Full 360 degree rotation on Y axis based on mouse position, with spring physics
    // for a premium, heavy 3D feel.
    const rotateXRaw = useTransform(y, [0, 1], [40, -40]);
    const rotateYRaw = useTransform(x, [0, 1], [-180, 180]);
    const rotateX = useSpring(rotateXRaw, { stiffness: 100, damping: 30 });
    const rotateY = useSpring(rotateYRaw, { stiffness: 100, damping: 30 });

    const serialLabel = `No. ${String(serial).padStart(3, '0')} / ${mintSize}`;
    const canvas = (
        <InsideCanvas isOpen={isOpen} videoSrc={videoSrc} matchTitle={matchTitle} matchCaption={matchCaption} />
    );

    return (
        <div className={`cc-root cc--${edition}`}>
            {/* Instructional hint */}
            <motion.div animate={{ opacity: isOpen ? 0.3 : 0.8 }} className="cc-hint">
                {isOpen ? 'MOVE MOUSE TO INSPECT' : 'CLICK CARD TO UNFOLD'}
            </motion.div>

            {/* Main 3D perspective scene */}
            <div className="cc-scene" style={{ perspective: '1200px', transform: `scale(${scale})` }}>
                {/* Tilt wrapper */}
                <motion.div style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }} className="cc-tilt">
                    {/* Main assembly (P2 - center panel) */}
                    <motion.div
                        className="cc-assembly"
                        style={{ transformStyle: 'preserve-3d' }}
                        animate={{ z: isOpen ? 80 : 0 }}
                        transition={{ duration: 1.2, ease: 'easeInOut' }}
                        onClick={() => setIsOpen(!isOpen)}
                    >
                        {/* ===== P2: center panel ===== */}
                        <div className="cc-panel" style={{ transformStyle: 'preserve-3d' }}>
                            {/* P2 inside: center canvas (faces front) */}
                            <div
                                className="cc-face cc-face--center"
                                style={{ backfaceVisibility: 'hidden', clipPath: 'inset(-800px 0px -100px 0px round 0.75rem)' }}
                            >
                                <div className="cc-canvas-strip" style={{ transform: 'translateX(-240px)' }}>
                                    {canvas}
                                </div>
                            </div>

                            {/* P2 outside: back cover (faces back) */}
                            <div className="cc-back" style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
                                <div className="cc-back-glow"></div>
                                <div className="cc-back-frame"></div>
                                <div className="cc-back-inscription">Genesis Collection</div>
                                <div className="cc-back-logo">
                                    HEAT
                                    <br />
                                    CHECKS
                                </div>
                                <div className="cc-back-serial">{serialLabel}</div>
                            </div>
                        </div>

                        {/* ===== P1: right panel ===== */}
                        <motion.div
                            className="cc-flap cc-flap--right"
                            style={{ transformStyle: 'preserve-3d' }}
                            animate={{ rotateY: isOpen ? 0 : -180, z: isOpen ? 0 : 2 }}
                            transition={{ duration: 0.6, ease: 'easeInOut', delay: isOpen ? 0.6 : 0 }}
                        >
                            {/* P1 inside: right canvas (faces front) */}
                            <div
                                className="cc-face"
                                style={{ backfaceVisibility: 'hidden', clipPath: 'inset(-800px 0px -100px 0px round 0.75rem)' }}
                            >
                                <div className="cc-canvas-strip" style={{ transform: 'translateX(-480px)' }}>
                                    {canvas}
                                </div>
                            </div>

                            {/* P1 outside: hidden inner flap (faces back) */}
                            <div className="cc-flap-back" style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
                                <div className="cc-flap-glow"></div>
                            </div>
                        </motion.div>

                        {/* ===== P3: left panel (front cover) ===== */}
                        <motion.div
                            className="cc-flap cc-flap--left"
                            style={{ transformStyle: 'preserve-3d' }}
                            animate={{ rotateY: isOpen ? 0 : 180, z: isOpen ? 0 : 4 }}
                            transition={{ duration: 0.6, ease: 'easeInOut', delay: isOpen ? 0 : 0.6 }}
                        >
                            {/* P3 inside: left canvas (faces front) */}
                            <div
                                className="cc-face"
                                style={{ backfaceVisibility: 'hidden', clipPath: 'inset(-800px 0px -100px 0px round 0.75rem)' }}
                            >
                                <div className="cc-canvas-strip" style={{ transform: 'translateX(0px)' }}>
                                    {canvas}
                                </div>
                            </div>

                            {/* P3 outside: front cover (faces back, but faces user when folded) */}
                            <div className="cc-cover" style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}>
                                <img src={coverSrc} alt={coverAlt} className="cc-cover-art" draggable={false} />
                                {/* Glossy lacquer coat: top-light highlight fading to a darker base */}
                                <div className="cc-cover-lacquer"></div>
                                {/* Curved specular highlight across the top corner, like a foil card under light */}
                                <div className="cc-cover-specular"></div>
                                {/* Sweeping shine */}
                                <div className="cc-cover-sweep-wrap">
                                    <div className="cc-cover-sweep"></div>
                                </div>
                                {/* Extra shine on hover - edition-tinted */}
                                <div className="cc-cover-sheen"></div>
                                {/* Glass rim */}
                                <div className="cc-cover-rim"></div>
                            </div>
                        </motion.div>
                    </motion.div>
                </motion.div>
            </div>
        </div>
    );
};

export default CollectibleCard;
