/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { motion, useMotionValue, useTransform, useSpring } from "motion/react";
import { useEffect, useRef, useState } from "react";

export type Sport = 'baseball' | 'basketball' | 'soccer' | 'football';
export type ActionType = 'primary' | 'secondary' | 'tertiary';

const actionsMap: Record<Sport, { primary: string, secondary: string, tertiary?: string }> = {
  baseball: { primary: 'Hit', secondary: 'Pitch' },
  basketball: { primary: 'Shoot', secondary: 'Dunk' },
  soccer: { primary: 'Kick', secondary: 'Save', tertiary: 'POV Goal' },
  football: { primary: 'Throw', secondary: 'Catch' }
};

const FlameTail = ({ mode = 'flameDirection' }: { mode?: 'flameDirection' | 'left' | 'right' }) => (
  <g 
    style={mode === 'flameDirection' ? { animation: 'flameDirection 4s infinite' } : undefined}
    transform={mode === 'left' ? 'scale(-1, 1)' : mode === 'right' ? 'scale(1, 1)' : undefined}
  >
    <g style={{ animation: 'flameFlicker 0.1s infinite alternate', transformOrigin: '0px 0px' }}>
      {/* Flame paths */}
      <path d="M 20 -20 Q 80 -40 120 -10 Q 70 0 100 20 Q 50 30 20 20 Q -10 0 20 -20 Z" fill="rgba(255,30,30,0.7)" />
      <path d="M 20 -10 Q 60 -20 90 -5 Q 50 0 80 15 Q 40 20 20 10 Q 0 0 20 -10 Z" fill="rgba(6,182,212,0.8)" />
      {/* Smoke puffs */}
      <circle cx="90" cy="-25" r="15" fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth="1" strokeDasharray="2 2" />
      <circle cx="120" cy="10" r="20" fill="rgba(255,30,30,0.1)" stroke="#ff1e1e" strokeWidth="1" strokeDasharray="2 2" />
      <circle cx="150" cy="-5" r="10" fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth="1" />
    </g>
  </g>
);

const renderSportGraphic = (sport: Sport, action: ActionType) => {
  switch (sport) {
    case 'baseball':
      if (action === 'secondary') {
        return (
          <g>
            <path d="M 600 150 Q 350 180 100 200" fill="none" stroke="url(#holoGradient)" strokeWidth="3" strokeDasharray="15 10" style={{ animation: 'genericTrailFade 4s infinite' }} />
            {/* Catcher */}
            <g transform="translate(100, 200)" stroke="#06b6d4" strokeWidth="2" fill="none">
              <circle cx="0" cy="-30" r="10" />
              <path d="M 0 -20 L 0 10 L -15 30 M 0 10 L 15 30 M -10 -10 L 10 -10 L 20 -20" />
              <circle cx="25" cy="-20" r="8" fill="rgba(236,72,153,0.2)" stroke="#ec4899" />
            </g>
            {/* Pitcher */}
            <g style={{ animation: 'pitcherThrow 4s infinite', transformOrigin: '600px 180px' }} stroke="#ec4899" strokeWidth="2" fill="none">
               <circle cx="600" cy="100" r="12" />
               <path d="M 600 112 L 600 150 L 580 180 M 600 150 L 620 180 M 600 120 L 570 110 L 550 80 M 600 120 L 630 130" />
            </g>
            {/* Ball */}
            <g style={{ animation: 'pitchBall 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
              <FlameTail mode="right" />
              <circle cx="0" cy="0" r="15" fill="rgba(6,182,212,0.3)" stroke="#06b6d4" strokeWidth="2" strokeDasharray="4 4" />
            </g>
          </g>
        );
      }
      return (
        <g>
          <path d="M 316 209 Q 500 -400 700 150" fill="none" stroke="url(#holoGradient)" strokeWidth="3" strokeDasharray="15 10" style={{ animation: 'trailFade 4s infinite' }} />
          <circle cx="316" cy="209" fill="none" stroke="#06b6d4" style={{ animation: 'impactShockwave 4s infinite' }} />
          <circle cx="316" cy="209" fill="#ec4899" style={{ animation: 'impactCore 4s infinite' }} />
          <g style={{ animation: 'batSwing 4s infinite', transformOrigin: '40px 100px' }} filter="url(#glow)">
            <rect x="35" y="82" width="15" height="36" rx="5" fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth="2" strokeDasharray="2 2" />
            <path d="M 50 90 L 140 90 C 190 90, 230 75, 340 75 C 365 75, 375 80, 375 100 C 375 120, 365 125, 340 125 C 230 125, 190 110, 140 110 L 50 110 Z" fill="rgba(6,182,212,0.05)" stroke="url(#holoGradient)" strokeWidth="2" strokeDasharray="6 3" />
            <g stroke="#06b6d4" strokeWidth="2" opacity="0.8">
              <line x1="60" y1="90" x2="70" y2="110" />
              <line x1="80" y1="90" x2="90" y2="110" />
              <line x1="100" y1="90" x2="110" y2="110" />
              <line x1="120" y1="90" x2="130" y2="110" />
            </g>
            <path d="M 140 90 C 190 90, 230 75, 340 75" stroke="#ec4899" strokeWidth="1" fill="none" opacity="0.7" />
            <path d="M 140 110 C 190 110, 230 125, 340 125" stroke="#ec4899" strokeWidth="1" fill="none" opacity="0.7" />
            <path d="M 50 100 L 375 100" stroke="#06b6d4" strokeWidth="1" fill="none" opacity="0.5" strokeDasharray="4 4" />
          </g>
          <g style={{ animation: 'ballTrajectory 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
            <FlameTail />
            <circle cx="0" cy="0" r="30" fill="rgba(6,182,212,0.3)" stroke="#ec4899" strokeWidth="3" strokeDasharray="6 6" />
            <path d="M -15 -21 C -3 -9, -3 9, -15 21" stroke="#06b6d4" strokeWidth="2" fill="none" />
            <path d="M 15 -21 C 3 -9, 3 9, 15 21" stroke="#06b6d4" strokeWidth="2" fill="none" />
          </g>
        </g>
      );
    case 'basketball':
      if (action === 'secondary') {
        return (
          <g>
            <g transform="translate(610, 130)" filter="url(#glow)">
              <rect x="30" y="-80" width="10" height="100" fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth="2" />
              <rect x="25" y="-30" width="5" height="30" fill="none" stroke="#ec4899" strokeWidth="2" />
              <ellipse cx="0" cy="0" rx="25" ry="5" fill="none" stroke="#ec4899" strokeWidth="3" />
              <path d="M -25 0 L -15 40 L 15 40 L 25 0" fill="rgba(236,72,153,0.1)" stroke="#06b6d4" strokeWidth="1" strokeDasharray="2 2" />
            </g>
            {/* Dunker */}
            <g style={{ animation: 'dunkPlayer 4s infinite', transformOrigin: '0px 0px' }} stroke="#06b6d4" strokeWidth="2" fill="none">
              <circle cx="0" cy="-40" r="12" />
              <path d="M 0 -28 L 0 20 L -15 50 M 0 20 L 15 40 L 5 70 M -10 -15 L 20 -40 L 40 -20 M 10 -15 L -20 -30" />
            </g>
            {/* Ball */}
            <g style={{ animation: 'dunkBall 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
              <FlameTail mode="left" />
              <circle cx="0" cy="0" r="20" fill="rgba(236,72,153,0.3)" stroke="url(#holoGradient)" strokeWidth="2" strokeDasharray="6 4" />
            </g>
          </g>
        );
      }
      return (
        <g>
          <path d="M 100 250 Q 360 -400 610 130" fill="none" stroke="url(#holoGradient)" strokeWidth="3" strokeDasharray="15 10" style={{ animation: 'genericTrailFade 4s infinite' }} />
          <g transform="translate(610, 130)" filter="url(#glow)">
            <rect x="30" y="-80" width="10" height="100" fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth="2" />
            <rect x="25" y="-30" width="5" height="30" fill="none" stroke="#ec4899" strokeWidth="2" />
            <ellipse cx="0" cy="0" rx="25" ry="5" fill="none" stroke="#ec4899" strokeWidth="3" />
            <path d="M -25 0 L -15 40 L 15 40 L 25 0" fill="rgba(236,72,153,0.1)" stroke="#06b6d4" strokeWidth="1" strokeDasharray="2 2" />
          </g>
          <circle cx="100" cy="250" fill="none" stroke="#06b6d4" style={{ animation: 'leftShockwave 4s infinite' }} />
          <circle cx="610" cy="130" fill="none" stroke="#06b6d4" style={{ animation: 'rightShockwave 4s infinite' }} />
          <circle cx="610" cy="130" fill="#ec4899" style={{ animation: 'rightCore 4s infinite' }} />
          <g style={{ animation: 'bballTrajectory 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
            <FlameTail mode="left" />
            <g style={{ animation: 'bballSpin 4s infinite' }}>
              <circle cx="0" cy="0" r="30" fill="rgba(236,72,153,0.3)" stroke="url(#holoGradient)" strokeWidth="3" strokeDasharray="8 4" />
              <circle cx="0" cy="0" r="28" fill="none" stroke="#ec4899" strokeWidth="2" opacity="0.8" />
              <line x1="-30" y1="0" x2="30" y2="0" stroke="#06b6d4" strokeWidth="2" />
              <line x1="0" y1="-30" x2="0" y2="30" stroke="#06b6d4" strokeWidth="2" />
              <path d="M -20 -25 C -5 -15, -5 15, -20 25" stroke="#ec4899" strokeWidth="2" fill="none" strokeDasharray="4 2" />
              <path d="M 20 -25 C 5 -15, 5 15, 20 25" stroke="#ec4899" strokeWidth="2" fill="none" strokeDasharray="4 2" />
            </g>
          </g>
        </g>
      );
    case 'soccer':
      if (action === 'tertiary') {
        return (
          <g>
            {/* Net background taking up full space */}
            <g opacity="0.4" stroke="#06b6d4" strokeWidth="2" strokeDasharray="4 4" filter="url(#glow)" style={{ animation: 'povNetRumble 4s infinite', transformOrigin: '360px 170px' }}>
              <path d="M 0 50 L 720 50 M 0 100 L 720 100 M 0 150 L 720 150 M 0 200 L 720 200 M 0 250 L 720 250 M 0 300 L 720 300" />
              <path d="M 50 0 L 50 340 M 150 0 L 150 340 M 250 0 L 250 340 M 350 0 L 350 340 M 450 0 L 450 340 M 550 0 L 550 340 M 650 0 L 650 340" />
            </g>
            
            {/* Shockwaves off the back of the net hit */}
            <circle cx="360" cy="170" fill="none" stroke="#ec4899" style={{ animation: 'povShockwave 4s infinite' }} />
            <circle cx="360" cy="170" fill="none" stroke="#06b6d4" style={{ animation: 'povShockwave 4s infinite', animationDelay: '0.1s' }} />

            {/* Ball flying towards camera */}
            <g style={{ animation: 'povBallOut 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
              <g style={{ transform: 'rotate(10deg)' }}>
                <FlameTail />
              </g>
              <g style={{ animation: 'soccerSpin 4s infinite' }}>
                <circle cx="0" cy="0" r="30" fill="rgba(6,182,212,0.8)" stroke="url(#holoGradient)" strokeWidth="4" strokeDasharray="8 4" />
                <polygon points="0,-15 10,-5 6,12 -6,12 -10,-5" fill="rgba(0,0,0,0.8)" stroke="#ec4899" strokeWidth="2" />
                <path d="M 0,-15 L -10,-25 M 10,-5 L 25,-10 M 6,12 L 15,25 M -6,12 L -15,25 M -10,-5 L -25,-10" stroke="#06b6d4" strokeWidth="1" />
              </g>
            </g>
          </g>
        );
      }
      if (action === 'secondary') {
        return (
          <g>
            <g transform="translate(650, 180)" filter="url(#glow)">
              <path d="M 0 -70 L 0 70 M -30 70 L 30 70 M 0 -70 L 40 -40 L 40 70 L 0 70" fill="none" stroke="#06b6d4" strokeWidth="3" />
              <path d="M 0 -70 L 40 70 M 0 -40 L 40 70 M 0 -10 L 40 70 M 0 20 L 40 70" fill="none" stroke="#ec4899" strokeWidth="1" opacity="0.5" strokeDasharray="2 2" />
            </g>
            {/* Kicker */}
            <g transform="translate(100, 220)" stroke="#06b6d4" strokeWidth="2" fill="none">
               <circle cx="0" cy="-50" r="12" />
               <path d="M 0 -38 L 0 10 L -20 50 M 0 10 L 30 20 L 40 50 M -10 -20 L -30 -10 M 10 -20 L 30 -30" />
            </g>
            {/* GK */}
            <g style={{ animation: 'gkDive 4s infinite', transformOrigin: '650px 200px' }} stroke="#ec4899" strokeWidth="2" fill="none">
              <circle cx="0" cy="-30" r="12" />
              <path d="M 0 -18 L 0 30 L -20 60 M 0 30 L 20 60 M -15 -5 L -40 -30 M 15 -5 L 40 -30" />
            </g>
            {/* Ball */}
            <g style={{ animation: 'gkBall 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
              <FlameTail mode="left" />
              <circle cx="0" cy="0" r="20" fill="rgba(6,182,212,0.3)" stroke="url(#holoGradient)" strokeWidth="2" strokeDasharray="6 3" />
            </g>
          </g>
        );
      }
      return (
        <g>
          <g transform="translate(650, 180)" filter="url(#glow)">
            <path d="M 0 -70 L 0 70 M -30 70 L 30 70 M 0 -70 L 40 -40 L 40 70 L 0 70" fill="none" stroke="#06b6d4" strokeWidth="3" />
            <path d="M 0 -70 L 40 70 M 0 -40 L 40 70 M 0 -10 L 40 70 M 0 20 L 40 70" fill="none" stroke="#ec4899" strokeWidth="1" opacity="0.5" strokeDasharray="2 2" />
          </g>
          <circle cx="150" cy="250" fill="none" stroke="#06b6d4" style={{ animation: 'leftShockwave 4s infinite' }} />
          <circle cx="650" cy="180" fill="none" stroke="#06b6d4" style={{ animation: 'rightShockwave 4s infinite' }} />
          <circle cx="650" cy="180" fill="#ec4899" style={{ animation: 'rightCore 4s infinite' }} />
          <g style={{ animation: 'bootSwing 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
             <path d="M -40 -30 L -20 20 L 10 30 L 30 20 L 20 -10 Z" fill="rgba(6,182,212,0.1)" stroke="#06b6d4" strokeWidth="2" strokeDasharray="2 2" />
             <path d="M 10 30 L 10 40 M 0 25 L 0 35 M -10 20 L -10 30" stroke="#ec4899" strokeWidth="2" />
          </g>
          <g style={{ animation: 'soccerTrajectory 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
            <FlameTail mode="left" />
            <g style={{ animation: 'soccerSpin 4s infinite' }}>
              <circle cx="0" cy="0" r="30" fill="rgba(6,182,212,0.3)" stroke="url(#holoGradient)" strokeWidth="3" strokeDasharray="8 4" />
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
    case 'football':
      if (action === 'secondary') {
        return (
          <g>
            {/* QB */}
            <g style={{ animation: 'qbThrow 4s infinite', transformOrigin: '100px 220px' }} transform="translate(100, 220)" stroke="#06b6d4" strokeWidth="2" fill="none">
              <circle cx="0" cy="-50" r="12" />
              <path d="M 0 -38 L 0 10 L -15 50 M 0 10 L 15 50 M -10 -20 L -30 -40 M 10 -20 L 30 -50" />
            </g>
            {/* Receiver */}
            <g style={{ animation: 'receiverRun 4s infinite', transformOrigin: '0px 0px' }} stroke="#ec4899" strokeWidth="2" fill="none">
              <circle cx="0" cy="-40" r="12" />
              <path d="M 0 -28 L 0 20 L -20 40 M 0 20 L 20 50 M -10 -15 L -30 -30 M 10 -15 L 30 -30" />
            </g>
            {/* Ball */}
            <g style={{ animation: 'catchBall 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
              <FlameTail mode="left" />
              <ellipse cx="0" cy="0" rx="20" ry="12" fill="rgba(6,182,212,0.3)" stroke="url(#holoGradient)" strokeWidth="2" strokeDasharray="4 2" />
            </g>
          </g>
        );
      }
      return (
        <g>
          <path d="M 100 280 Q 360 -500 620 100" fill="none" stroke="url(#holoGradient)" strokeWidth="3" strokeDasharray="15 10" style={{ animation: 'genericTrailFade 4s infinite' }} />
          <g transform="translate(620, 100)" filter="url(#glow)">
            <path d="M 0 150 L 0 50 M 0 50 L -40 50 M 0 50 L 40 50 M -40 50 L -40 -50 M 40 50 L 40 -50" fill="none" stroke="#eab308" strokeWidth="4" />
            <path d="M -40 -50 L -40 50 L 40 50 L 40 -50" fill="none" stroke="#ec4899" strokeWidth="1" strokeDasharray="2 2" opacity="0.5" />
          </g>
          <circle cx="100" cy="280" fill="none" stroke="#06b6d4" style={{ animation: 'leftShockwave 4s infinite' }} />
          <circle cx="620" cy="100" fill="none" stroke="#06b6d4" style={{ animation: 'rightShockwave 4s infinite' }} />
          <circle cx="620" cy="100" fill="#ec4899" style={{ animation: 'rightCore 4s infinite' }} />
          <g style={{ animation: 'fbTrajectory 4s infinite', transformOrigin: '0px 0px' }} filter="url(#glow)">
            <FlameTail mode="left" />
            <g style={{ animation: 'fbSpin 4s infinite' }}>
              <ellipse cx="0" cy="0" rx="40" ry="22" fill="rgba(6,182,212,0.3)" stroke="url(#holoGradient)" strokeWidth="3" strokeDasharray="6 3" />
              <path d="M -30 0 C -15 15, 15 15, 30 0 C 15 -15, -15 -15, -30 0 Z" stroke="#ec4899" strokeWidth="2" fill="rgba(236,72,153,0.1)" strokeDasharray="4 2"/>
              <g stroke="#06b6d4" strokeWidth="2">
                <line x1="-15" y1="-8" x2="15" y2="-8" strokeWidth="3" />
                <line x1="-10" y1="-12" x2="-10" y2="-4" />
                <line x1="-3" y1="-12" x2="-3" y2="-4" />
                <line x1="4" y1="-12" x2="4" y2="-4" />
                <line x1="11" y1="-12" x2="11" y2="-4" />
              </g>
              <ellipse cx="-25" cy="0" rx="3" ry="12" fill="none" stroke="#fff" strokeWidth="1" opacity="0.7" />
              <ellipse cx="25" cy="0" rx="3" ry="12" fill="none" stroke="#fff" strokeWidth="1" opacity="0.7" />
            </g>
          </g>
        </g>
      );
    default:
      return null;
  }
};

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

const InsideCanvas = ({ sport, action, isOpen }: { sport: Sport, action: ActionType, isOpen: boolean }) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return registerBgVideo(video);
  }, [sport]);

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
  }, [isOpen, sport]);

  return (
    <div className={`w-[720px] h-[340px] bg-zinc-950 relative flex items-center justify-center animate-hologram ${!isOpen ? 'pause-animations' : ''}`}>
      <style>
        {`
          .pause-animations * {
            animation-play-state: paused !important;
          }
          /* POV Goal */
          @keyframes povBallOut {
            0%, 9% { transform: translate(360px, 170px) scale(0); opacity: 0; }
            10% { transform: translate(360px, 170px) scale(0.5); opacity: 1; filter: brightness(3); }
            60% { transform: translate(360px, 170px) scale(20); opacity: 1; filter: brightness(1); }
            70% { transform: translate(360px, 170px) scale(30); opacity: 0; }
            71%, 100% { opacity: 0; }
          }
          @keyframes povNetRumble {
            0%, 9% { transform: translate(0px, 0px) scale(1); }
            10% { transform: translate(0px, 0px) scale(0.9); }
            12% { transform: translate(10px, -8px) scale(0.95); }
            14% { transform: translate(-8px, -10px) scale(0.92); }
            16% { transform: translate(10px, 10px) scale(1.02); }
            18% { transform: translate(-5px, 5px) scale(0.98); }
            20%, 100% { transform: translate(0px, 0px) scale(1); }
          }
          @keyframes povShockwave {
            0%, 8% { r: 0; opacity: 0; stroke-width: 2; }
            10% { r: 10; opacity: 1; stroke-width: 15; }
            25% { r: 400; opacity: 0; stroke-width: 2; }
            26%, 100% { r: 0; opacity: 0; }
          }
          @keyframes sphereSpin {
            0% { transform: rotateY(0deg); }
            100% { transform: rotateY(360deg); }
          }
          @keyframes gridMove {
            0% { background-position: center 0; }
            100% { background-position: center 40px; }
          }
          /* Pitcher Throw */
          @keyframes pitcherThrow {
            0%, 5% { transform: rotate(0deg); }
            15% { transform: rotate(20deg); }
            25%, 100% { transform: rotate(-30deg); }
          }
          @keyframes pitchBall {
            0%, 15% { transform: translate(570px, 100px) scale(0); opacity: 0; }
            16% { transform: translate(570px, 100px) scale(0.8); opacity: 1; filter: brightness(3); }
            25% { transform: translate(100px, 180px) scale(1.5); opacity: 1; filter: brightness(2); }
            26%, 100% { opacity: 0; }
          }
          /* Dunk */
          @keyframes dunkPlayer {
            0%, 5% { transform: translate(250px, 200px); }
            15% { transform: translate(400px, 100px) rotate(15deg); }
            25% { transform: translate(570px, 40px) rotate(30deg); }
            35%, 100% { transform: translate(570px, 200px) rotate(0deg); }
          }
          @keyframes dunkBall {
            0%, 5% { transform: translate(270px, 160px) scale(1); opacity: 1; }
            15% { transform: translate(440px, 60px) scale(1.2); opacity: 1; filter: brightness(2); }
            25% { transform: translate(610px, 0px) scale(1.5); opacity: 1; filter: brightness(3); }
            30% { transform: translate(610px, 150px) scale(1); opacity: 1; }
            40% { transform: translate(610px, 300px) scale(0.5); opacity: 1; }
            41%, 100% { opacity: 0; }
          }
          /* GK Save */
          @keyframes gkDive {
            0%, 10% { transform: rotate(0deg); }
            20% { transform: translate(-30px, -50px) rotate(-45deg); }
            30%, 100% { transform: translate(0px, 20px) rotate(90deg); }
          }
          @keyframes gkBall {
            0% { transform: translate(140px, 270px) scale(0); opacity: 0; }
            5% { transform: translate(140px, 270px) scale(0.8); opacity: 1; filter: brightness(3); }
            15% { transform: translate(380px, 200px) scale(1.5); opacity: 1; }
            20% { transform: translate(600px, 130px) scale(1); opacity: 1; filter: brightness(3); }
            30% { transform: translate(450px, -50px) scale(0.5); opacity: 1; }
            31%, 100% { opacity: 0; }
          }
          /* Touchdown Catch */
          @keyframes qbThrow {
            0%, 5% { transform: rotate(0deg); }
            10% { transform: rotate(20deg); }
            20%, 100% { transform: rotate(-30deg); }
          }
          @keyframes receiverRun {
            0%, 5% { transform: translate(350px, 220px) rotate(0deg); }
            15% { transform: translate(550px, 220px) rotate(10deg); }
            25% { transform: translate(620px, 150px) rotate(-10deg); }
            35%, 100% { transform: translate(650px, 220px) rotate(0deg); }
          }
          @keyframes catchBall {
            0%, 5% { transform: translate(130px, 170px) scale(0); opacity: 0; }
            6% { transform: translate(130px, 170px) scale(0.8); opacity: 1; filter: brightness(3); }
            15% { transform: translate(350px, 50px) scale(1.5); opacity: 1; }
            25% { transform: translate(600px, 120px) scale(1); opacity: 1; filter: brightness(2); }
            35% { transform: translate(640px, 200px) scale(0.8); opacity: 1; }
            36%, 100% { opacity: 0; }
          }
          .animate-grid {
            animation: gridMove 1s linear infinite;
          }
          @keyframes hologramPulse {
            0%, 100% { filter: drop-shadow(0 0 10px rgba(6,182,212,0.5)) brightness(1); }
            50% { filter: drop-shadow(0 0 25px rgba(6,182,212,0.8)) brightness(1.2); }
          }
          .animate-hologram-pulse {
            animation: hologramPulse 2s ease-in-out infinite;
          }
          @keyframes hologramFlicker {
            0%, 100% { opacity: 0.95; }
            3% { opacity: 0.7; }
            6% { opacity: 0.95; }
            9% { opacity: 0.8; }
            50% { opacity: 0.95; }
            53% { opacity: 0.7; }
            56% { opacity: 1; }
          }
          .animate-hologram {
            animation: hologramFlicker 6s infinite;
          }
          @keyframes scanlineMove {
            0% { transform: translateY(-340px); }
            100% { transform: translateY(340px); }
          }
          @keyframes trailFade {
            0%, 24% { opacity: 0; }
            25% { opacity: 1; }
            50% { opacity: 0.4; }
            70%, 100% { opacity: 0; }
          }
          @keyframes impactShockwave {
            0%, 23% { r: 0; opacity: 0; stroke-width: 10px; }
            24% { r: 20; opacity: 1; stroke-width: 5px; }
            28% { r: 120; opacity: 0; stroke-width: 1px; }
            100% { r: 0; opacity: 0; }
          }
          @keyframes impactCore {
            0%, 23% { r: 0; opacity: 0; }
            24% { r: 10; opacity: 1; }
            26% { r: 0; opacity: 0; }
            100% { r: 0; opacity: 0; }
          }
          @keyframes batSwing {
            0%, 15% { transform: translate(150px, 198px) scale(0.5) rotate(-140deg); }
            24% { transform: translate(150px, 198px) scale(0.5) rotate(-15deg); }
            35% { transform: translate(150px, 198px) scale(0.5) rotate(60deg); }
            45%, 100% { transform: translate(150px, 198px) scale(0.5) rotate(-140deg); }
          }
          @keyframes ballTrajectory {
            0% { transform: translate(800px, 180px) scale(0.5); opacity: 0; }
            5% { transform: translate(750px, 185px) scale(0.6); opacity: 1; }
            24% { transform: translate(316px, 209px) scale(1.2); opacity: 1; }
            25% { transform: translate(316px, 209px) scale(2); opacity: 1; filter: brightness(3); }
            35% { transform: translate(500px, -400px) scale(4); opacity: 1; }
            45% { transform: translate(700px, 150px) scale(1); opacity: 1; }
            46%, 100% { opacity: 0; }
          }
          @keyframes flameDirection {
            0%, 24% { transform: scaleX(1) rotate(0deg); }
            25%, 100% { transform: scaleX(-1) rotate(15deg); }
          }
          @keyframes flameFlicker {
            0% { transform: scale(1) skew(0deg); }
            100% { transform: scale(1.1) skew(5deg); }
          }
          @keyframes genericTrailFade {
            0%, 4% { opacity: 0; }
            5% { opacity: 1; }
            25% { opacity: 0.6; }
            36%, 100% { opacity: 0; }
          }
          @keyframes leftShockwave {
            0%, 4% { r: 0; opacity: 0; stroke-width: 10px; }
            5% { r: 30; opacity: 1; stroke-width: 5px; }
            10% { r: 100; opacity: 0; stroke-width: 1px; }
            100% { r: 0; opacity: 0; }
          }
          @keyframes rightShockwave {
            0%, 24% { r: 0; opacity: 0; stroke-width: 10px; }
            25% { r: 40; opacity: 1; stroke-width: 5px; }
            30% { r: 150; opacity: 0; stroke-width: 1px; }
            100% { r: 0; opacity: 0; }
          }
          @keyframes rightCore {
            0%, 24% { r: 0; opacity: 0; }
            25% { r: 20; opacity: 1; }
            27% { r: 0; opacity: 0; }
            100% { r: 0; opacity: 0; }
          }
          @keyframes bballTrajectory {
            0% { transform: translate(100px, 250px) scale(0); opacity: 0; }
            5% { transform: translate(100px, 250px) scale(0.8); opacity: 1; filter: brightness(1); }
            15% { transform: translate(360px, -350px) scale(3.5); opacity: 1; }
            25% { transform: translate(610px, 130px) scale(0.8); opacity: 1; filter: brightness(1); }
            26% { transform: translate(610px, 130px) scale(1.2); opacity: 1; filter: brightness(3); }
            35% { transform: translate(610px, 400px) scale(0.5); opacity: 1; }
            36%, 100% { opacity: 0; }
          }
          @keyframes bballSpin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(-360deg); }
          }
          @keyframes soccerTrajectory {
            0% { transform: translate(150px, 250px) scale(0); opacity: 0; }
            4% { transform: translate(150px, 250px) scale(0.8); opacity: 1; filter: brightness(1); }
            5% { transform: translate(150px, 250px) scale(1.2); opacity: 1; filter: brightness(3); }
            15% { transform: translate(400px, -400px) scale(3.5); opacity: 1; }
            25% { transform: translate(650px, 180px) scale(0.7); opacity: 1; filter: brightness(1); }
            26% { transform: translate(650px, 180px) scale(1.2); opacity: 1; filter: brightness(3); }
            35% { transform: translate(750px, 250px) scale(0.7); opacity: 1; }
            36%, 100% { opacity: 0; }
          }
          @keyframes soccerSpin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(720deg); }
          }
          @keyframes bootSwing {
            0%, 2% { transform: translate(50px, 200px) rotate(-30deg); opacity: 0; }
            3% { transform: translate(50px, 200px) rotate(-30deg); opacity: 1; }
            5% { transform: translate(110px, 240px) rotate(15deg); opacity: 1; }
            15% { transform: translate(150px, 200px) rotate(40deg); opacity: 0; }
            100% { opacity: 0; }
          }
          @keyframes fbTrajectory {
            0% { transform: translate(100px, 280px) scale(0); opacity: 0; }
            4% { transform: translate(100px, 280px) scale(0.8); opacity: 1; filter: brightness(1); }
            5% { transform: translate(100px, 280px) scale(1.2); opacity: 1; filter: brightness(3); }
            15% { transform: translate(360px, -450px) scale(3.5); opacity: 1; }
            25% { transform: translate(620px, 100px) scale(0.7); opacity: 1; filter: brightness(1); }
            26% { transform: translate(620px, 100px) scale(1.2); opacity: 1; filter: brightness(3); }
            35% { transform: translate(750px, 300px) scale(0.5); opacity: 1; }
            36%, 100% { opacity: 0; }
          }
          @keyframes fbSpin {
            0% { transform: rotate(-30deg); }
            100% { transform: rotate(720deg); }
          }
        `}
      </style>

      {/* Deep Space / Projection Void */}
      <div className="absolute inset-0 bg-[#020617]"></div>

      {/* Video Backdrop (soccer only) — sits under the sun, grid, and hologram layers */}
      {sport === 'soccer' && (
        <video
          ref={videoRef}
          src="/videos/soccerbackdrop.mp4"
          muted
          loop
          playsInline
          preload="auto"
          className="absolute inset-0 w-full h-full object-cover opacity-90 z-0 mix-blend-screen"
          style={{ filter: 'brightness(2) contrast(1.15)' }}
        />
      )}

      {/* Projection Source Glow */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(6,182,212,0.2)_0%,_transparent_70%)] z-0 mix-blend-screen"></div>
      
      {/* Synthwave Sun (Wireframe/Hologram style) */}
      <div className="absolute top-[5%] w-[280px] h-[280px] rounded-full border border-pink-500/50 shadow-[0_0_30px_rgba(236,72,153,0.4)_inset] opacity-80 z-0 flex flex-col justify-end overflow-hidden mix-blend-screen">
        {/* Wireframe sun lines */}
        <div className="w-full h-[1px] bg-pink-500/80 mb-2 shadow-[0_0_5px_#ec4899]"></div>
        <div className="w-full h-[2px] bg-pink-500/80 mb-3 shadow-[0_0_5px_#ec4899]"></div>
        <div className="w-full h-[2px] bg-pink-500/80 mb-4 shadow-[0_0_5px_#ec4899]"></div>
        <div className="w-full h-[3px] bg-pink-500/80 mb-5 shadow-[0_0_5px_#ec4899]"></div>
        <div className="w-full h-[4px] bg-pink-500/80 mb-6 shadow-[0_0_5px_#ec4899]"></div>
        <div className="w-full h-[5px] bg-pink-500/80 mb-6 shadow-[0_0_5px_#ec4899]"></div>
      </div>

      {/* Rotating holo-sphere carrying the match texts, one on each side */}
      {sport === 'soccer' && (
        <div
          className="absolute top-[5%] w-[280px] h-[280px] z-10 pointer-events-none"
          style={{ perspective: '800px' }}
        >
          <div
            className="absolute inset-0"
            style={{ transformStyle: 'preserve-3d', animation: 'sphereSpin 12s linear infinite' }}
          >
            {/* Wireframe longitude rings that sweep as the sphere turns */}
            <div className="absolute inset-2 rounded-full border border-pink-500/40 shadow-[0_0_10px_rgba(236,72,153,0.2)_inset]"></div>
            <div className="absolute inset-2 rounded-full border border-cyan-400/40" style={{ transform: 'rotateY(60deg)' }}></div>
            <div className="absolute inset-2 rounded-full border border-cyan-400/40" style={{ transform: 'rotateY(120deg)' }}></div>

            {/* Face A: match title */}
            <div
              className="absolute inset-0 flex items-center justify-center p-9 text-center"
              style={{ transform: 'translateZ(70px)', backfaceVisibility: 'hidden' }}
            >
              <p className="text-cyan-300 text-[13px] font-mono font-bold uppercase tracking-[0.2em] leading-relaxed [text-wrap:balance] drop-shadow-[0_0_10px_rgba(6,182,212,0.9)]">
                2026 World Cup Final: Spain vs Argentina
              </p>
            </div>

            {/* Face B: highlight caption */}
            <div
              className="absolute inset-0 flex items-center justify-center p-9 text-center"
              style={{ transform: 'rotateY(180deg) translateZ(70px)', backfaceVisibility: 'hidden' }}
            >
              <p className="text-pink-400 text-[12px] font-mono font-bold uppercase tracking-wider leading-relaxed [text-wrap:balance] drop-shadow-[0_0_10px_rgba(236,72,153,0.9)]">
                Ferran Torres scored the winning goal in the 106th minute to win the World Cup
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Laser Grid Floor */}
      <div className="absolute bottom-0 w-full h-[55%] perspective-[800px] z-0">
        <div 
          className="w-[200%] h-[200%] absolute bottom-0 left-[-50%] origin-bottom rotate-x-[75deg] opacity-60 animate-grid"
          style={{
            backgroundImage: `
              linear-gradient(transparent 95%, #06b6d4 100%),
              linear-gradient(90deg, transparent 95%, #06b6d4 100%)
            `,
            backgroundSize: '40px 40px',
            boxShadow: 'inset 0 0 100px #020617'
          }}
        ></div>
      </div>

      {/* Hologram Canvas (Full Width) */}
      <div className="z-10 absolute inset-0 pointer-events-none mix-blend-screen">
        <svg width="720" height="340" viewBox="0 0 720 340" className="animate-hologram-pulse overflow-visible absolute inset-0">
          <defs>
            <linearGradient id="holoGradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#06b6d4" />
              <stop offset="50%" stopColor="#ec4899" />
              <stop offset="100%" stopColor="#06b6d4" />
            </linearGradient>
            <filter id="glow">
              <feGaussianBlur stdDeviation="3" result="coloredBlur"/>
              <feMerge>
                <feMergeNode in="coloredBlur"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>

          {renderSportGraphic(sport, action)}
        </svg>
      </div>
      
      {/* Hologram Scanlines Overlay */}
      <div className="absolute inset-0 pointer-events-none z-20 opacity-20 mix-blend-overlay" style={{
        backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, #06b6d4 2px, #06b6d4 4px)',
        backgroundSize: '100% 4px'
      }}></div>
      
      {/* Holographic Scanning Beam */}
      <div className="absolute inset-0 pointer-events-none z-30 opacity-30 mix-blend-screen overflow-hidden">
        <div className="w-full h-[20%] bg-gradient-to-b from-transparent via-cyan-400 to-transparent blur-md animate-[scanlineMove_4s_linear_infinite]"></div>
      </div>
    </div>
  );
};

export default function App() {
  const [isOpen, setIsOpen] = useState(false);
  const [sport, setSport] = useState<Sport>('baseball');
  const [action, setAction] = useState<ActionType>('primary');
  
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

  // Full 360 degree rotation on Y axis based on mouse position
  const rotateXRaw = useTransform(y, [0, 1], [40, -40]); 
  const rotateYRaw = useTransform(x, [0, 1], [-180, 180]); // -180 to 180 allows completely flipping it around

  // Add spring physics for a premium, heavy 3D feel
  const rotateX = useSpring(rotateXRaw, { stiffness: 100, damping: 30 });
  const rotateY = useSpring(rotateYRaw, { stiffness: 100, damping: 30 });

  return (
    <div className="w-full h-screen bg-zinc-950 flex flex-col items-center justify-center overflow-hidden font-sans selection:bg-cyan-500/30">
      
      {/* Instructional Hint */}
      <motion.div 
        animate={{ opacity: isOpen ? 0.3 : 0.8 }}
        className="absolute top-12 text-zinc-400 tracking-[0.2em] text-xs font-semibold pointer-events-none transition-opacity"
      >
        {isOpen ? "MOVE MOUSE TO INSPECT" : "CLICK CARD TO UNFOLD"}
      </motion.div>

      {/* Main 3D Perspective Scene */}
      <div 
        className="relative flex items-center justify-center scale-75 md:scale-100" 
        style={{ perspective: '1200px' }}
      >
        {/* Tilt Wrapper */}
        <motion.div 
          style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }}
          className="relative flex items-center justify-center"
        >
          {/* MAIN ASSEMBLY (P2 - Center Panel) */}
          <motion.div
            className="relative w-[240px] h-[340px] cursor-pointer"
            style={{ transformStyle: 'preserve-3d' }}
            animate={{ z: isOpen ? 80 : 0 }}
            transition={{ duration: 1.2, ease: "easeInOut" }}
            onClick={() => setIsOpen(!isOpen)}
          >
            
            {/* ================= P2: CENTER PANEL ================= */}
            <div className="absolute inset-0 rounded-xl" style={{ transformStyle: 'preserve-3d' }}>
              {/* P2 Inside: Center Canvas (Faces Front) */}
              <div 
                className="absolute inset-0 rounded-xl border-y border-cyan-800 shadow-[0_0_30px_rgba(6,182,212,0.15)] bg-zinc-950" 
                style={{ backfaceVisibility: 'hidden', clipPath: 'inset(-800px 0px -100px 0px round 0.75rem)' }}
              >
                <div className="w-[720px] h-full absolute left-0 top-0" style={{ transform: 'translateX(-240px)' }}>
                  <InsideCanvas sport={sport} action={action} isOpen={isOpen} />
                </div>
              </div>

              {/* P2 Outside: Back Cover (Faces Back) */}
              <div 
                className="absolute inset-0 rounded-xl bg-zinc-900 border border-zinc-700 shadow-[0_0_40px_rgba(0,0,0,0.8)] flex items-center justify-center overflow-hidden" 
                style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
              >
                <div className="w-full h-full opacity-30 bg-[radial-gradient(circle_at_center,_#f59e0b_0%,_transparent_70%)]"></div>
                <div className="absolute border-4 border-double border-amber-500 shadow-[0_0_15px_rgba(245,158,11,0.4),inset_0_0_15px_rgba(245,158,11,0.4)] opacity-80 w-[90%] h-[92%] rounded-lg pointer-events-none"></div>
                <div className="absolute top-[7%] left-[9%] text-amber-300 text-[9px] font-bold uppercase tracking-[0.25em] drop-shadow-[0_0_6px_rgba(245,158,11,0.7)] select-none">
                  Genesis Collection
                </div>
                <div className="font-black tracking-[0.35em] rotate-[-45deg] text-3xl select-none text-center bg-gradient-to-b from-amber-100 via-yellow-400 to-amber-600 bg-clip-text text-transparent drop-shadow-[0_0_14px_rgba(250,204,21,0.65)]">
                  HEAT
                  <br />
                  CHECKS
                </div>
              </div>
            </div>

            {/* ================= P1: RIGHT PANEL ================= */}
            <motion.div
              className="absolute top-0 left-full w-full h-full origin-left z-10"
              style={{ transformStyle: 'preserve-3d' }}
              animate={{ rotateY: isOpen ? 0 : -180, z: isOpen ? 0 : 2 }}
              transition={{ duration: 0.6, ease: "easeInOut", delay: isOpen ? 0.6 : 0 }}
            >
              {/* P1 Inside: Right Canvas (Faces Front) */}
              <div 
                className="absolute inset-0 rounded-xl border border-cyan-800 shadow-[0_0_30px_rgba(6,182,212,0.15)] bg-zinc-950" 
                style={{ backfaceVisibility: 'hidden', clipPath: 'inset(-800px 0px -100px 0px round 0.75rem)' }}
              >
                <div className="w-[720px] h-full absolute left-0 top-0" style={{ transform: 'translateX(-480px)' }}>
                  <InsideCanvas sport={sport} action={action} isOpen={isOpen} />
                </div>
              </div>

              {/* P1 Outside: Hidden Inner Flap (Faces Back) */}
              <div 
                className="absolute inset-0 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-center overflow-hidden" 
                style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
              >
                <div className="w-full h-full opacity-20 bg-[radial-gradient(circle_at_center,_#06b6d4_0%,_transparent_70%)]"></div>
              </div>
            </motion.div>

            {/* ================= P3: LEFT PANEL (FRONT COVER) ================= */}
            <motion.div
              className="absolute top-0 right-full w-full h-full origin-right z-20"
              style={{ transformStyle: 'preserve-3d' }}
              animate={{ rotateY: isOpen ? 0 : 180, z: isOpen ? 0 : 4 }}
              transition={{ duration: 0.6, ease: "easeInOut", delay: isOpen ? 0 : 0.6 }}
            >
              {/* P3 Inside: Left Canvas (Faces Front) */}
              <div 
                className="absolute inset-0 rounded-xl border border-cyan-800 shadow-[0_0_30px_rgba(6,182,212,0.15)] bg-zinc-950" 
                style={{ backfaceVisibility: 'hidden', clipPath: 'inset(-800px 0px -100px 0px round 0.75rem)' }}
              >
                <div className="w-[720px] h-full absolute left-0 top-0" style={{ transform: 'translateX(0px)' }}>
                  <InsideCanvas sport={sport} action={action} isOpen={isOpen} />
                </div>
              </div>

              {/* P3 Outside: Front Cover (Faces Back, but faces User when folded) */}
              <div
                className="absolute inset-0 rounded-xl overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.8)] border border-fuchsia-500/70 bg-zinc-900 group"
                style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
              >
                {/* Gold plated cover art */}
                <img
                  src="/images/neon_og_card.jpg"
                  alt="Neon card"
                  className="absolute inset-0 w-full h-full object-cover"
                  draggable={false}
                />

                {/* Glossy lacquer coat: top-light highlight fading to a darker base */}
                <div className="absolute inset-0 pointer-events-none bg-gradient-to-b from-white/20 via-transparent via-30% to-black/25"></div>

                {/* Curved specular highlight across the top corner, like a foil card under light */}
                <div className="absolute -top-1/4 -left-1/4 w-[150%] h-[60%] pointer-events-none rounded-[100%] bg-gradient-to-b from-white/30 to-transparent blur-md"></div>

                {/* Sweeping shine */}
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                  <div className="absolute top-[-20%] bottom-[-20%] w-[45%] -skew-x-12 bg-gradient-to-r from-transparent via-white/50 to-transparent animate-[glossSweep_4s_ease-in-out_infinite]"></div>
                </div>

                {/* Extra shine on hover */}
                <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-fuchsia-300/25 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none mix-blend-overlay"></div>

                {/* Glass rim */}
                <div className="absolute inset-0 rounded-xl ring-1 ring-inset ring-white/30 pointer-events-none"></div>
              </div>
            </motion.div>

          </motion.div>
        </motion.div>
      </div>

      {/* UI Controls */}
      <div className="absolute bottom-6 z-50 flex flex-col items-center gap-3">
        {/* Actions Sub-Menu */}
        <motion.div 
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1.1 }}
          className="flex gap-2 p-1.5 rounded-full bg-zinc-900/60 backdrop-blur-md border border-zinc-800"
        >
          <button
            onClick={() => setAction('primary')}
            className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-widest transition-all duration-300 ${
              action === 'primary' 
                ? 'bg-pink-500/20 text-pink-400 border border-pink-500/50' 
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
            }`}
          >
            {actionsMap[sport].primary.toUpperCase()}
          </button>
          <button
            onClick={() => setAction('secondary')}
            className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-widest transition-all duration-300 ${
              action === 'secondary' 
                ? 'bg-pink-500/20 text-pink-400 border border-pink-500/50' 
                : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
            }`}
          >
            {actionsMap[sport].secondary.toUpperCase()}
          </button>
          {actionsMap[sport].tertiary && (
            <button
              onClick={() => setAction('tertiary')}
              className={`px-3 py-1 rounded-full text-[10px] font-bold tracking-widest transition-all duration-300 ${
                action === 'tertiary' 
                  ? 'bg-pink-500/20 text-pink-400 border border-pink-500/50' 
                  : 'text-zinc-500 hover:text-zinc-300 border border-transparent'
              }`}
            >
              {actionsMap[sport].tertiary?.toUpperCase()}
            </button>
          )}
        </motion.div>

        {/* Sports Main Menu */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 1 }}
          className="flex gap-2 p-2 rounded-full bg-zinc-900/80 backdrop-blur-md border border-zinc-700 shadow-2xl"
        >
          {(['baseball', 'basketball', 'soccer', 'football'] as Sport[]).map((s) => (
            <button
              key={s}
              onClick={() => {
                setSport(s);
                setAction('primary');
              }}
              className={`px-4 py-2 rounded-full text-xs font-bold tracking-wider transition-all duration-300 ${
                sport === s 
                  ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/50 shadow-[0_0_10px_rgba(6,182,212,0.3)]' 
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 border border-transparent'
              }`}
            >
              {s.toUpperCase()}
            </button>
          ))}
        </motion.div>
      </div>
    </div>
  );
}

