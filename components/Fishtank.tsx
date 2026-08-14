// ===================================================================================
// FISHTANK — shared 3D "tank" artifact
// ===================================================================================
// Extracted from the article deck client so it can be reused both there (single tank,
// hydrated on a Tank article page) and on the-tank page (a browsable carousel of
// tanks). Renders a draggable 3D "tank" with one readable panel per wall (hook / two
// takes / call) - modeled visually on fishtank-article-card/src/components/FishtankCard.tsx's
// opaque panel styling, but content is always visible - no glass cover, no flip-to-read.
//
// No Tailwind here (this project doesn't use it) - the same visual language is
// hand-written as inline styles instead of utility classes.
// ===================================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useSpring } from 'motion/react';
import { Flame, Zap, Swords } from 'lucide-react';
import {
    getCachedAccount,
    setCachedAccount,
    submitPick,
    getTodayStatus,
    verifyEmailCode,
    resendVerificationCode,
    PickConflictError,
    DailyCapError,
    type TodayStatus,
} from '../tank-pick-client';
import { trackEvent } from '../tank-analytics-client';
import { AllSetModal } from './AllSetModal';

export interface DeckPayload {
    hook: string;
    cards: string[];
    call: { question: string; sides: string[] };
    // Wall-header content, below. All pre-formatted strings computed server-side (never
    // client-side) so this component stays purely presentational. tagline is the one
    // model-generated field; the rest are real facts pulled from the frozen game_snapshot
    // (league/subject, market odds, settle date) - same "never build a hard fact from
    // model prose" rule the schema.org JSON-LD already follows.
    tagline: string;           // Hook wall header - short storyline label, a few words
    contextLabel: string;      // Take 1 header - "{league} · {subject}"
    oddsOrMarketLabel: string; // Take 2 header - live odds, or the market label if no odds
    settleDateLabel: string;   // Call wall header - "Resolves {date}"
}

interface Wall {
    kind: 'hook' | 'card' | 'call';
    label: string;
    icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
    rotateY: number;
}

const TANK_W = 260;
const TANK_H = 340;
const TANK_D = 260;
const Z_W = TANK_W / 2;
const Z_H = TANK_H / 2;

// Fixed at 4 walls - Hook, two Takes, Call - regardless of how many cards the model
// returns (the prompt allows 2-4); extras beyond the first two are simply not shown.
const MAX_CARDS_SHOWN = 2;

function displayCards(payload: DeckPayload): string[] {
    return payload.cards.slice(0, MAX_CARDS_SHOWN);
}

// Card wall headers are positional, not repeated per-card: Take 1 always orients the
// reader (league/subject), Take 2 always shows the market price. Safe to hardcode since
// MAX_CARDS_SHOWN caps the deck at exactly 2 card walls.
const CARD_HEADER_KEYS: (keyof DeckPayload)[] = ['contextLabel', 'oddsOrMarketLabel'];

function buildWalls(payload: DeckPayload): Wall[] {
    const cards = displayCards(payload);
    const pieces: Omit<Wall, 'rotateY'>[] = [
        { kind: 'hook', label: payload.tagline, icon: Flame },
        ...cards.map((_, i) => ({ kind: 'card' as const, label: payload[CARD_HEADER_KEYS[i]] as string, icon: Zap })),
        { kind: 'call', label: payload.settleDateLabel, icon: Swords },
    ];
    const n = pieces.length;
    return pieces.map((p, i) => ({ ...p, rotateY: (360 / n) * i }));
}

// Which wall is currently closest to front-facing the camera, given the cube's
// current rotateY - used to log a wall_viewed event once a drag settles, for the
// "did they actually read before picking" signal.
function nearestWallIndex(walls: Wall[], containerRotateY: number): number {
    let bestIndex = 0;
    let bestDistance = Infinity;
    walls.forEach((wall, i) => {
        const raw = (wall.rotateY + containerRotateY) % 360;
        const normalized = ((raw % 360) + 360) % 360;
        const distance = Math.min(normalized, 360 - normalized);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = i;
        }
    });
    return bestIndex;
}

const Face3D: React.FC<{
    width: number;
    height: number;
    rotateX?: number;
    rotateY?: number;
    translateZ?: number;
    children: React.ReactNode;
    style?: React.CSSProperties;
}> = ({ width, height, rotateX = 0, rotateY = 0, translateZ = 0, children, style }) => (
    <div
        style={{
            position: 'absolute',
            width,
            height,
            left: '50%',
            top: '50%',
            marginLeft: -width / 2,
            marginTop: -height / 2,
            transform: `rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(${translateZ}px)`,
            transformStyle: 'preserve-3d',
            ...style,
        }}
    >
        {children}
    </div>
);

// Content is always visible on each wall - no glass cover, no flip-to-read.
const WallPanel: React.FC<{
    wall: Wall;
    content: React.ReactNode;
}> = ({ wall, content }) => {
    const Icon = wall.icon;
    // The Call wall is where the pick actually happens - give it a fiery-orange glow
    // so it reads as "check this side out" against the other panels' cyan.
    const isCall = wall.kind === 'call';

    return (
        <Face3D width={TANK_W} height={TANK_H} rotateY={wall.rotateY} translateZ={Z_W}>
            <div
                style={{
                    width: '100%', height: '100%',
                    position: 'relative',
                    display: 'flex', flexDirection: 'column',
                    background: 'rgba(15,23,42,0.2)',
                    backdropFilter: 'blur(3px)',
                    WebkitBackdropFilter: 'blur(3px)',
                    border: isCall ? '1.5px solid rgba(251,146,60,0.85)' : '1px solid rgba(0,0,0,0.6)',
                    borderRadius: 12,
                    overflow: 'hidden',
                    boxShadow: isCall
                        ? '0 0 24px 4px rgba(251,146,60,0.45), 0 0 8px rgba(255,138,61,0.6), 0 10px 25px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)'
                        : '0 10px 25px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)',
                    backfaceVisibility: 'hidden',
                    WebkitBackfaceVisibility: 'hidden',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.5rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(15,23,42,0.4)', flexShrink: 0 }}>
                    <div style={{ padding: '0.3rem', background: isCall ? 'rgba(251,146,60,0.18)' : 'rgba(6,182,212,0.15)', borderRadius: 6, flexShrink: 0, marginTop: 1 }}>
                        <Icon size={13} style={{ color: isCall ? '#fb923c' : '#22d3ee' }} />
                    </div>
                    <h4 style={{
                        fontSize: '0.68rem', fontWeight: 700, color: '#f1f5f9', letterSpacing: '0.06em',
                        textTransform: 'uppercase', margin: 0, textShadow: '0 1px 4px rgba(0,0,0,0.7)',
                        minWidth: 0, lineHeight: 1.35,
                        display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                    } as React.CSSProperties}>{wall.label}</h4>
                </div>
                <div style={{ padding: '1.25rem', color: '#e2e8f0', fontSize: '0.9rem', lineHeight: 1.6, overflowY: 'auto', textShadow: '0 1px 4px rgba(0,0,0,0.7)' }}>
                    {content}
                </div>
                {isCall && (
                    <>
                        <CallScanline />
                        <CallCornerBrackets />
                        <CallSparks />
                        <div style={{
                            position: 'absolute', bottom: 6, right: 10,
                            fontFamily: "'Courier New', monospace",
                            fontSize: '0.55rem', letterSpacing: '0.1em',
                            color: 'rgba(251,146,60,0.7)', textTransform: 'uppercase',
                            pointerEvents: 'none',
                        }}>
                            Tank Access
                        </div>
                    </>
                )}
            </div>
        </Face3D>
    );
};

// The Call wall reads as a remote-access panel into the tank itself (matching
// the-tank page's own hotspot: TankScreen.css's .tank-screen__scanline/__glow use this
// exact pale cyan, #7fe9ff, over a scanning gradient band) - the tech signature of the
// world, with the fiery accent above layered on top to say "yours to open."
const CallScanline: React.FC = () => (
    <motion.div
        style={{
            position: 'absolute',
            left: 0,
            right: 0,
            height: 44,
            background: 'linear-gradient(180deg, transparent 0%, rgba(127,233,255,0.32) 50%, transparent 100%)',
            mixBlendMode: 'screen',
            pointerEvents: 'none',
        }}
        animate={{ top: ['-12%', '112%'] }}
        transition={{ duration: 3.4, repeat: Infinity, ease: 'linear' }}
    />
);

// HUD-style targeting corners - the "this panel is live, this is the access point"
// visual shorthand, static (no motion) so it doesn't compete with the scanline/sparks.
const CALL_CORNERS: React.CSSProperties[] = [
    { top: 6, left: 6, borderWidth: '2px 0 0 2px' },
    { top: 6, right: 6, borderWidth: '2px 2px 0 0' },
    { bottom: 6, left: 6, borderWidth: '0 0 2px 2px' },
    { bottom: 6, right: 6, borderWidth: '0 2px 2px 0' },
];

const CallCornerBrackets: React.FC = () => (
    <>
        {CALL_CORNERS.map((pos, i) => (
            <div
                key={i}
                style={{
                    position: 'absolute',
                    width: 16,
                    height: 16,
                    borderStyle: 'solid',
                    borderColor: 'rgba(251,146,60,0.85)',
                    pointerEvents: 'none',
                    ...pos,
                }}
            />
        ))}
    </>
);

const EMBER_COLORS = ['#ffc72c', '#fb923c', '#ff8a3d', '#e8a800'];
const EMBER_COUNT = 12;

// Fixed points scattered along the Call wall's border, not corners-only, so it reads
// as catching along the edge rather than a decorative pattern.
const CALL_SPARK_POSITIONS = [
    { top: '4%', left: '14%' },
    { top: '24%', left: '2%' },
    { top: '8%', left: '84%' },
    { top: '64%', left: '97%' },
    { top: '92%', left: '32%' },
    { top: '52%', left: '3%' },
];

// A light speckle along the Call wall's border, like it's just starting to catch -
// small, low-amplitude flicker, not the full drifting Embers treatment.
const CallSparks: React.FC = () => (
    <>
        {CALL_SPARK_POSITIONS.map((pos, i) => {
            const color = EMBER_COLORS[i % EMBER_COLORS.length];
            const size = 2.5 + (i % 3) * 0.7;
            return (
                <motion.div
                    key={i}
                    style={{
                        position: 'absolute',
                        top: pos.top,
                        left: pos.left,
                        width: size,
                        height: size,
                        borderRadius: '50%',
                        background: color,
                        boxShadow: `0 0 ${size * 2}px ${size * 0.8}px ${color}`,
                        pointerEvents: 'none',
                    }}
                    animate={{ opacity: [0.15, 0.8, 0.25, 0.6, 0.15], scale: [0.8, 1.15, 0.9, 1.05, 0.8] }}
                    transition={{ duration: 2.2 + (i % 3) * 0.5, repeat: Infinity, delay: i * 0.3, ease: 'easeInOut' }}
                />
            );
        })}
    </>
);

// Tiny embers drifting/bouncing inside the tank volume, at a spread of depths so
// they read as floating in the box rather than pinned to one flat plane.
const Embers: React.FC = () => (
    <>
        {Array.from({ length: EMBER_COUNT }).map((_, i) => {
            const zOffset = -80 + (i % 4) * 50;
            const size = 6 + Math.random() * 6;
            const color = EMBER_COLORS[i % EMBER_COLORS.length];
            const duration = 5 + Math.random() * 4;
            const delay = Math.random() * 5;
            const xRange = 30 + Math.random() * 50;
            const yRange = 50 + Math.random() * 70;
            return (
                <Face3D key={i} width={TANK_W} height={TANK_D} rotateY={0} translateZ={zOffset} style={{ pointerEvents: 'none' }}>
                    <motion.div
                        style={{
                            position: 'absolute',
                            left: `${15 + Math.random() * 70}%`,
                            top: `${15 + Math.random() * 70}%`,
                            width: size,
                            height: size,
                            borderRadius: '50%',
                            background: color,
                            boxShadow: `0 0 ${size * 1.5}px ${size * 0.5}px ${color}`,
                        }}
                        animate={{
                            x: [0, xRange, -xRange * 0.6, xRange * 0.3, 0],
                            y: [0, -yRange, -yRange * 0.3, -yRange * 0.8, 0],
                            opacity: [0.6, 1, 0.75, 1, 0.6],
                        }}
                        transition={{ duration, repeat: Infinity, delay, ease: 'easeInOut' }}
                    />
                </Face3D>
            );
        })}
    </>
);

const pillButtonStyle = (active: boolean, disabled?: boolean): React.CSSProperties => ({
    padding: '0.5rem 0.9rem',
    borderRadius: 8,
    border: active ? '2px solid #2fe6d9' : '1px solid rgba(255,255,255,0.25)',
    background: active ? 'rgba(47,230,217,0.15)' : 'transparent',
    color: active ? '#2fe6d9' : '#cbd5e1',
    cursor: disabled ? 'default' : 'pointer',
    fontSize: '0.85rem',
    opacity: disabled && !active ? 0.4 : 1,
});

const inputStyle: React.CSSProperties = {
    padding: '0.5rem 0.75rem',
    borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.25)',
    background: '#0f172a',
    color: '#f1f5f9',
    fontSize: '0.85rem',
    outline: 'none',
};

const submitButtonStyle: React.CSSProperties = {
    padding: '0.5rem 0.9rem',
    borderRadius: 8,
    border: '1px solid rgba(34,211,238,0.5)',
    background: 'rgba(34,211,238,0.15)',
    color: '#22d3ee',
    cursor: 'pointer',
    fontSize: '0.85rem',
    fontWeight: 600,
};

const linkButtonStyle: React.CSSProperties = {
    background: 'none',
    border: 'none',
    color: '#22d3ee',
    fontSize: '0.75rem',
    cursor: 'pointer',
    textDecoration: 'underline',
    padding: 0,
};

type SubmitState = 'idle' | 'choosing' | 'submitting' | 'error';
type VerifyState = 'unverified' | 'verifying' | 'verified' | 'verify-error';

const picksTodayLineStyle: React.CSSProperties = {
    color: 'rgba(255,255,255,0.55)',
    fontSize: '0.72rem',
    marginTop: '0.5rem',
    letterSpacing: '0.02em',
};

// Verification is account-level, not per-pick, so this shows the same regardless of
// which of today's (up to 3) picks/tanks the reader is currently looking at - reachable
// from every branch below where an account is known, not just the "locked on this tank"
// one, so a not-yet-verified account can never end up stranded on a fully-picked tank
// with no way back to the code form.
const VerifyBlock: React.FC<{
    email: string;
    verifyState: VerifyState;
    verifyCode: string;
    setVerifyCode: (v: string) => void;
    verifyError: string | null;
    resendState: 'idle' | 'sending' | 'sent';
    onVerify: (e: React.FormEvent) => void;
    onResend: () => void;
}> = ({ email, verifyState, verifyCode, setVerifyCode, verifyError, resendState, onVerify, onResend }) =>
    verifyState === 'verified' ? (
        <p style={{ color: '#2fe6d9', fontSize: '0.75rem', marginTop: '0.5rem' }}>
            &#10003; {email ? `${email} confirmed` : 'Email confirmed'}
        </p>
    ) : (
        <form onSubmit={onVerify} style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px dashed rgba(255,255,255,0.15)' }}>
            <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.75rem', margin: '0 0 0.5rem 0' }}>
                Confirm your email — check your inbox for a code.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="6-digit code"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                    style={{ ...inputStyle, width: 110 }}
                />
                <button type="submit" style={submitButtonStyle} disabled={verifyState === 'verifying'}>
                    {verifyState === 'verifying' ? 'Checking…' : 'Confirm'}
                </button>
                <button type="button" onClick={onResend} style={linkButtonStyle} disabled={resendState === 'sending'}>
                    {resendState === 'sent' ? 'Code resent' : resendState === 'sending' ? 'Sending…' : 'Resend code'}
                </button>
            </div>
            {verifyState === 'verify-error' && verifyError && (
                <p style={{ color: '#f87171', fontSize: '0.75rem', marginTop: '0.4rem' }}>{verifyError}</p>
            )}
        </form>
    );

const CallContent: React.FC<{ call: DeckPayload['call']; slug: string }> = ({ call, slug }) => {
    const [submitState, setSubmitState] = useState<SubmitState>('idle');
    const [selectedSide, setSelectedSide] = useState<string | null>(null);
    const [selectedSideIndex, setSelectedSideIndex] = useState<number | null>(null);
    const [email, setEmail] = useState('');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // Whether `email` represents a REAL, server-confirmed account (from a cached
    // account, or any response - success, conflict, or cap-reached - that resolved a
    // waitlist row) as opposed to just whatever text currently sits in the brand-new-
    // account email input while the reader is still typing it. These must be two
    // separate flags: `email` alone going truthy mid-keystroke ("j", "ja", "jam"...)
    // must NOT be read as "this is a known account" - that bug swapped the email input
    // out for the verify-code block (and made chooseSide auto-submit whatever partial
    // text was typed) the instant a reader typed their first character.
    const [accountKnown, setAccountKnown] = useState(false);

    // The account's full picture for TODAY - which tanks (including this one) are
    // already picked, and how many of the daily cap remain. Null until an account is
    // known (nothing cached yet, and this reader hasn't picked in this session either).
    const [todayStatus, setTodayStatus] = useState<TodayStatus | null>(null);
    const [statusLoaded, setStatusLoaded] = useState(false);

    const [verifyState, setVerifyState] = useState<VerifyState>('unverified');
    const [verifyCode, setVerifyCode] = useState('');
    const [verifyError, setVerifyError] = useState<string | null>(null);
    const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle');
    const [showAllSet, setShowAllSet] = useState(false);

    // A cached account means this browser already has a real pick history - fetch
    // today's actual server-side status (not a client cache, which would drift across
    // days/devices the way a single cached pick object could get away with under the
    // old one-pick-ever model) so this specific tank knows whether it's already picked
    // and the reader can see how many of today's picks remain.
    const hydrateAccount = useCallback(() => {
        const cached = getCachedAccount();
        if (!cached) {
            setStatusLoaded(true);
            return;
        }
        setEmail(cached.email);
        setAccountKnown(true);
        setVerifyState(cached.verified ? 'verified' : 'unverified');
        getTodayStatus(cached.email)
            .then((status) => {
                setTodayStatus(status);
                if (status.verified) setVerifyState('verified');
            })
            .catch(() => {
                // Best-effort - if this fails, fall back to treating today as unknown
                // (full cap available); the next real submit/conflict response is what
                // actually enforces the cap server-side regardless.
            })
            .finally(() => setStatusLoaded(true));
    }, []);

    useEffect(() => {
        hydrateAccount();
    }, [hydrateAccount]);

    // The mount effect above only ever runs once per real navigation - it does NOT
    // re-run when the browser's back-forward cache restores this exact page (and this
    // exact in-memory React state) from before the navigation away, since bfcache
    // resurrects everything frozen exactly as it was rather than remounting. That
    // leaves email/verifyState/todayStatus stuck at whatever they were the moment the
    // user navigated away - stale if verification or a pick happened elsewhere (another
    // tab, another device, or server-side) since then. Same fix as WorldMap.tsx's
    // identical bfcache issue: `pageshow` with `persisted: true` is the specific signal
    // a page was just restored from bfcache rather than freshly loaded, so that's the
    // one moment this needs to re-hydrate from scratch.
    useEffect(() => {
        const onPageShow = (e: PageTransitionEvent) => {
            if (!e.persisted) return;
            hydrateAccount();
        };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
    }, [hydrateAccount]);

    const myPickHere = todayStatus?.picks.find((p) => p.slug === slug) ?? null;
    const remaining = todayStatus?.remaining ?? 3;

    const submitPickFor = async (side: string, sideIndex: number, submitterEmail: string) => {
        setSubmitState('submitting');
        setErrorMessage(null);
        try {
            const res = await submitPick(submitterEmail, slug, side, sideIndex);
            setCachedAccount({ email: submitterEmail, verified: res.verified });
            setAccountKnown(true);
            if (res.verified) setVerifyState('verified');
            setTodayStatus((prev) => ({
                picks: [...(prev?.picks ?? []), res.pick],
                picksToday: res.picksToday,
                remaining: res.remaining,
                verified: res.verified,
            }));
            setSubmitState('idle');
            setSelectedSide(null);
            setSelectedSideIndex(null);
        } catch (err) {
            if (err instanceof PickConflictError) {
                if (err.existingPick) {
                    const verified = Boolean(err.existingPick.verified);
                    setCachedAccount({ email: submitterEmail, verified });
                    setAccountKnown(true);
                    if (verified) setVerifyState('verified');
                    setTodayStatus((prev) => ({
                        picks: [...(prev?.picks ?? []).filter((p) => p.slug !== slug), err.existingPick!],
                        picksToday: prev?.picksToday ?? 1,
                        remaining: prev?.remaining ?? 2,
                        verified,
                    }));
                }
                setSubmitState('idle');
                return;
            }
            if (err instanceof DailyCapError) {
                // A fresh session (no cached account) never called GET /api/picks/today
                // before this submit, so this 429 may be the very first real signal
                // about verification status this component has ever seen - without
                // consuming it here, an already-verified account hitting the cap on a
                // new device/incognito session gets stuck showing the code prompt
                // indefinitely, since nothing else would ever correct verifyState.
                setCachedAccount({ email: submitterEmail, verified: err.verified });
                setAccountKnown(true);
                if (err.verified) setVerifyState('verified');
                setTodayStatus((prev) => ({
                    picks: prev?.picks ?? [],
                    picksToday: err.picksToday,
                    remaining: err.remaining,
                    verified: err.verified,
                }));
                setErrorMessage(err.message);
                setSubmitState('error');
                return;
            }
            setErrorMessage(err instanceof Error ? err.message : 'Something went wrong. Try again.');
            setSubmitState('error');
        }
    };

    const chooseSide = (side: string, index: number) => {
        if (submitState === 'submitting' || myPickHere || remaining <= 0) return;
        // A known account (already picked at least once - email is cached) doesn't
        // need to re-type its email for pick 2 or 3 - submit immediately. A brand new
        // reader still needs the email form below to establish the account at all.
        // Gated on accountKnown, not on `email` being non-empty - see its declaration.
        if (accountKnown) {
            setSelectedSide(side);
            setSelectedSideIndex(index);
            void submitPickFor(side, index, email);
            return;
        }
        setSelectedSide(side);
        setSelectedSideIndex(index);
        setSubmitState('choosing');
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!selectedSide || selectedSideIndex === null) return;
        await submitPickFor(selectedSide, selectedSideIndex, email);
    };

    const handleVerify = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!email || !verifyCode) return;
        setVerifyState('verifying');
        setVerifyError(null);
        try {
            const result = await verifyEmailCode(email, verifyCode);
            if (result.verified || result.alreadyVerified) {
                setVerifyState('verified');
                setShowAllSet(true);
                setCachedAccount({ email, verified: true });
                setTodayStatus((prev) => (prev ? { ...prev, verified: true } : prev));
            } else {
                setVerifyState('verify-error');
            }
        } catch (err) {
            setVerifyError(err instanceof Error ? err.message : 'Incorrect code.');
            setVerifyState('verify-error');
        }
    };

    const handleResend = async () => {
        if (!email) return;
        setResendState('sending');
        try {
            await resendVerificationCode(email);
            setResendState('sent');
        } catch {
            setResendState('idle');
        }
    };

    const verifyBlock = (
        <VerifyBlock
            email={email}
            verifyState={verifyState}
            verifyCode={verifyCode}
            setVerifyCode={setVerifyCode}
            verifyError={verifyError}
            resendState={resendState}
            onVerify={handleVerify}
            onResend={handleResend}
        />
    );

    // Already picked this specific tank - show the lock-in state for it, regardless of
    // whether today's cap is otherwise used up.
    if (myPickHere) {
        return (
            <div>
                <p style={{ fontWeight: 600, color: '#f1f5f9', marginTop: 0 }}>{call.question}</p>
                <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                    {call.sides.map((side) => (
                        <div key={side} style={pillButtonStyle(myPickHere.side === side, true)}>
                            {side}
                        </div>
                    ))}
                </div>
                <p style={{ color: '#2fe6d9', fontSize: '0.8rem', marginTop: '0.6rem' }}>
                    You're locked in on &ldquo;{myPickHere.side}&rdquo;.
                </p>
                {todayStatus && (
                    <p style={picksTodayLineStyle}>
                        {todayStatus.picksToday} of {todayStatus.picksToday + todayStatus.remaining} picks used today{remaining > 0 ? ` · ${remaining} left` : ''}
                    </p>
                )}
                {accountKnown && verifyBlock}
                {showAllSet && <AllSetModal email={email} onClose={() => setShowAllSet(false)} />}
            </div>
        );
    }

    // Not picked here, but today's cap is used up elsewhere - no point offering a
    // choice that would just 429.
    if (statusLoaded && remaining <= 0) {
        return (
            <div>
                <p style={{ fontWeight: 600, color: '#f1f5f9', marginTop: 0 }}>{call.question}</p>
                <p style={{ color: '#cbd5e1', fontSize: '0.85rem', marginTop: '0.75rem' }}>
                    You've used today's picks — back tomorrow.
                </p>
                {todayStatus && <p style={picksTodayLineStyle}>{todayStatus.picksToday} of {todayStatus.picksToday + todayStatus.remaining} picks used today</p>}
                {accountKnown && verifyBlock}
                {showAllSet && <AllSetModal email={email} onClose={() => setShowAllSet(false)} />}
            </div>
        );
    }

    return (
        <div>
            <p style={{ fontWeight: 600, color: '#f1f5f9', marginTop: 0 }}>{call.question}</p>
            <div style={{ display: 'flex', gap: '0.6rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                {call.sides.map((side, index) => (
                    <button
                        key={side}
                        onClick={(e) => { e.stopPropagation(); chooseSide(side, index); }}
                        style={pillButtonStyle(selectedSide === side)}
                        disabled={submitState === 'submitting'}
                    >
                        {side}
                    </button>
                ))}
            </div>
            {todayStatus && <p style={picksTodayLineStyle}>{todayStatus.picksToday} of {todayStatus.picksToday + todayStatus.remaining} picks used today · {remaining} left</p>}

            {/* Email form only for a brand new account (chooseSide auto-submits once account is known). */}
            {submitState === 'choosing' && selectedSide && !accountKnown && (
                <form
                    onSubmit={handleSubmit}
                    onClick={(e) => e.stopPropagation()}
                    style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
                >
                    <input
                        type="email"
                        required
                        placeholder="you@email.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        style={{ ...inputStyle, flex: '1 1 180px' }}
                    />
                    <button type="submit" style={submitButtonStyle}>
                        Lock it in
                    </button>
                </form>
            )}
            {submitState === 'submitting' && (
                <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.8rem', marginTop: '0.6rem' }}>Locking in…</p>
            )}
            {submitState === 'error' && errorMessage && (
                <p style={{ color: '#f87171', fontSize: '0.75rem', marginTop: '0.5rem' }}>{errorMessage}</p>
            )}

            {/* Nothing to verify until an account actually exists (first pick made) -
                a brand new reader with no email yet has no business seeing this. */}
            {accountKnown && verifyBlock}
            {showAllSet && <AllSetModal email={email} onClose={() => setShowAllSet(false)} />}
        </div>
    );
};

// Same small tilt the cube always opens with (was baked into rotateY's default of 25
// when the hook wall was implicitly wall 0) - kept as a named constant now that the
// front-facing wall is computed instead of hardcoded, so any wall can open at this angle.
const OPEN_TILT_DEG = 25;

export const Fishtank: React.FC<{ payload: DeckPayload; slug: string }> = ({ payload, slug }) => {
    const walls = buildWalls(payload);
    // Prop bets sell the artifact - open with the Call wall already facing forward
    // instead of making the reader drag all the way around to find it.
    const callWall = walls.find(w => w.kind === 'call');
    const initialRotateY = OPEN_TILT_DEG - (callWall?.rotateY ?? 0);

    const rotateX = useMotionValue(-12);
    const rotateY = useMotionValue(initialRotateY);
    const springX = useSpring(rotateX, { stiffness: 150, damping: 25 });
    const springY = useSpring(rotateY, { stiffness: 150, damping: 25 });

    const cards = displayCards(payload);
    const contentByKind = (wall: Wall, index: number): React.ReactNode => {
        if (wall.kind === 'hook') return <p style={{ margin: 0, fontWeight: 600, fontSize: '1rem', color: '#f1f5f9' }}>{payload.hook}</p>;
        if (wall.kind === 'call') return <CallContent call={payload.call} slug={slug} />;
        const cardIndex = index - 1; // hook occupies index 0
        return <p style={{ margin: 0 }}>{cards[cardIndex]}</p>;
    };

    const handlePan = (_: any, info: { delta: { x: number; y: number } }) => {
        let nextX = rotateX.get() - info.delta.y * 0.4;
        nextX = Math.max(-70, Math.min(70, nextX));
        rotateX.set(nextX);
        rotateY.set(rotateY.get() + info.delta.x * 0.4);
    };

    // Fires once per newly-reached wall (not continuously while dragging) - a genuine
    // "rotated to read X" signal, deduped by wall index so Take 1 -> Take 2 still
    // counts as a change even though both share wall_kind='card'.
    const lastLoggedWallIndexRef = useRef<number | null>(null);
    const handlePanEnd = () => {
        const wallIndex = nearestWallIndex(walls, rotateY.get());
        if (lastLoggedWallIndexRef.current === wallIndex) return;
        lastLoggedWallIndexRef.current = wallIndex;
        trackEvent('wall_viewed', { tankSlug: slug, wallKind: walls[wallIndex].kind, metadata: { wallIndex } });
    };

    return (
        <div style={{ width: '100%', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
            <motion.div
                onPan={handlePan}
                onPanEnd={handlePanEnd}
                style={{
                    perspective: 1100,
                    width: '100%',
                    height: 420,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    cursor: 'grab',
                    touchAction: 'none',
                    userSelect: 'none',
                }}
            >
                <motion.div
                    style={{
                        position: 'relative', width: 0, height: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        rotateX: springX, rotateY: springY,
                        transformStyle: 'preserve-3d',
                    }}
                >
                    <div style={{
                        position: 'absolute', top: '50%', left: '50%',
                        transform: 'translate(-50%,-50%) translateZ(-40px)',
                        width: 300, height: 300,
                        background: 'radial-gradient(circle, rgba(6,182,212,0.35), transparent 70%)',
                        filter: 'blur(60px)',
                        pointerEvents: 'none',
                    }} />

                    {/* Base */}
                    <Face3D width={TANK_W} height={TANK_D} rotateX={-90} translateZ={Z_H}>
                        <div style={{ width: '100%', height: '100%', background: 'rgba(15,23,42,0.35)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', border: '1px solid rgba(51,65,85,0.6)', borderRadius: 12, boxShadow: '0 0 60px rgba(0,0,0,0.8)' }} />
                    </Face3D>

                    {/* Lid */}
                    <Face3D width={TANK_W} height={TANK_D} rotateX={90} translateZ={Z_H}>
                        <div style={{ width: '100%', height: '100%', border: '5px solid rgba(21,94,117,0.4)', borderRadius: 12, boxShadow: 'inset 0 0 20px rgba(6,182,212,0.1)', pointerEvents: 'none' }} />
                    </Face3D>

                    {/* Water surface */}
                    <Face3D width={TANK_W - 4} height={TANK_D - 4} rotateX={90} translateZ={-40} style={{ pointerEvents: 'none' }}>
                        <motion.div
                            style={{
                                width: '100%', height: '100%', borderRadius: 12,
                                background: 'rgba(34,211,238,0.2)',
                                boxShadow: 'inset 0 0 50px rgba(6,182,212,0.4)',
                                backgroundImage: 'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.15) 0%, transparent 70%)',
                            }}
                            animate={{ z: [0, 6, 0] }}
                            transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
                        />
                    </Face3D>

                    <Embers />

                    {walls.map((wall, i) => (
                        <WallPanel key={i} wall={wall} content={contentByKind(wall, i)} />
                    ))}
                </motion.div>
            </motion.div>
        </div>
    );
};

export default Fishtank;
