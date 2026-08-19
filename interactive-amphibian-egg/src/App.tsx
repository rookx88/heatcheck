/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * NOTE: This component deliberately uses hand-written inline styles
 * and no utility-CSS framework (e.g. Tailwind), adhering to project requirements.
 */
import React, { useState, useRef } from 'react';
import { motion, useMotionValue, useSpring, useAnimationFrame } from 'motion/react';
import { Star, Heart, Smile, Sun, Sparkles, Cloud, Wand2 } from 'lucide-react';

const globalStyles: React.CSSProperties = {
  width: '100vw',
  height: '100vh',
  backgroundColor: '#aaddff',
  backgroundImage: 'radial-gradient(circle at 50% 50%, #d4f0ff 0%, #aaddff 100%)',
  overflow: 'hidden',
  color: '#6b4c8a',
  fontFamily: '"Comic Sans MS", "Chalkboard SE", "Marker Felt", system-ui, sans-serif',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  margin: 0,
  padding: 0,
};

const FloatingMagic = () => {
  const particles = useRef(Array.from({ length: 30 }).map(() => ({
    size: Math.random() * 8 + 4,
    left: Math.random() * 100,
    delay: Math.random() * 5,
    duration: Math.random() * 4 + 4,
    color: Math.random() > 0.5 ? '#ffb3d9' : '#fff0b3',
    isStar: Math.random() > 0.7,
  }))).current;

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
      {particles.map((p, i) => (
        <motion.div
          key={i}
          style={{
            position: 'absolute',
            left: `${p.left}%`,
            bottom: '-20px',
            width: p.size,
            height: p.size,
            borderRadius: p.isStar ? '0%' : '50%',
            clipPath: p.isStar ? 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)' : 'none',
            backgroundColor: p.color,
            boxShadow: p.isStar ? 'none' : `0 0 ${p.size}px ${p.color}`,
          }}
          animate={{
            y: ['0vh', '-110vh'],
            x: [0, Math.random() * 60 - 30, Math.random() * 60 - 30],
            opacity: [0, Math.random() * 0.7 + 0.3, 0],
            rotate: [0, Math.random() * 360],
          }}
          transition={{
            duration: p.duration,
            repeat: Infinity,
            delay: p.delay,
            ease: 'linear',
          }}
        />
      ))}
    </div>
  );
};

const COLORS = [
  { name: 'Pink', value: 'rgba(255, 128, 181, 0.8)', hex: '#ff80b5' },
  { name: 'Yellow', value: 'rgba(255, 223, 128, 0.8)', hex: '#ffdf80' },
  { name: 'Mint', value: 'rgba(128, 255, 181, 0.8)', hex: '#80ffb5' },
  { name: 'Purple', value: 'rgba(181, 128, 255, 0.8)', hex: '#b580ff' },
];

const EggStats = ({ hatched, activeColor, setActiveColor }: { hatched: boolean, activeColor: typeof COLORS[0], setActiveColor: (c: typeof COLORS[0]) => void }) => {
  return (
    <motion.div
      style={{
        position: 'absolute',
        left: '30px',
        top: '30px',
        width: '280px',
        border: '4px solid #ffffff',
        backgroundColor: 'rgba(255, 255, 255, 0.6)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderRadius: '24px',
        padding: '20px',
        boxShadow: '0 8px 32px rgba(107, 76, 138, 0.15)',
        zIndex: 10,
      }}
      initial={{ opacity: 0, scale: 0.8, rotate: -5 }}
      animate={{ opacity: 1, scale: 1, rotate: 0 }}
      transition={{ duration: 0.8, type: 'spring', bounce: 0.5 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', borderBottom: '3px dashed rgba(107, 76, 138, 0.2)', paddingBottom: '12px', marginBottom: '16px' }}>
        <Sparkles size={24} color={hatched ? '#ff66a3' : '#ffb338'} fill={hatched ? '#ff66a3' : '#ffb338'} />
        <div style={{ fontSize: '16px', letterSpacing: '1px', fontWeight: '900', color: hatched ? '#ff66a3' : '#ffb338', textTransform: 'uppercase' }}>
          {hatched ? 'Hatched!' : 'Ready to Hatch!'}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <StatRow icon={<Sun size={18} />} label="Warmth" value={hatched ? 'Perfect ☀️' : 'Cozy'} />
        <StatRow icon={<Wand2 size={18} />} label="Magic Level" value={hatched ? '9,001 ✨' : 'Glowing'} />
        <StatRow icon={<Smile size={18} />} label="Playfulness" value={hatched ? 'MAXIMUM!' : 'Wiggling'} />
        <StatRow icon={<Heart size={18} />} label="Happiness" value="100% 💖" />
      </div>

      <div style={{ display: 'flex', gap: '12px', marginTop: '16px', paddingTop: '16px', borderTop: '3px dashed rgba(107, 76, 138, 0.2)', justifyContent: 'center' }}>
        {COLORS.map(c => (
          <button
            key={c.name}
            onClick={() => setActiveColor(c)}
            style={{
              width: 28, height: 28, borderRadius: '50%',
              backgroundColor: c.hex,
              border: activeColor.name === c.name ? '3px solid #6b4c8a' : '3px solid transparent',
              cursor: 'pointer',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
              transition: 'transform 0.1s ease',
              transform: activeColor.name === c.name ? 'scale(1.2)' : 'scale(1)'
            }}
          />
        ))}
      </div>
    </motion.div>
  );
};

const StatRow = ({ icon, label, value }: { icon: React.ReactNode, label: string, value: string }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '15px', fontWeight: 'bold' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#8c6eab' }}>
      {icon}
      <span>{label}</span>
    </div>
    <motion.span
      animate={{ scale: [1, 1.05, 1] }}
      transition={{ duration: Math.random() * 2 + 1, repeat: Infinity, ease: 'easeInOut' }}
      style={{ color: '#6b4c8a' }}
    >
      {value}
    </motion.span>
  </div>
);

const faceDefs = [
  { id: 'front', rotateY: 0, rotateX: 0 },
  { id: 'back', rotateY: 180, rotateX: 0 },
  { id: 'left', rotateY: -90, rotateX: 0 },
  { id: 'right', rotateY: 90, rotateX: 0 },
  { id: 'top', rotateY: 0, rotateX: 90 },
  { id: 'bottom', rotateY: 0, rotateX: -90 },
];

const NeopianEgg = ({ hatched, setHatched, activeColor }: { hatched: boolean, setHatched: (h: boolean) => void, activeColor: typeof COLORS[0] }) => {
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);
  const rotateX = useSpring(dragY, { stiffness: 80, damping: 25 });
  const rotateY = useSpring(dragX, { stiffness: 80, damping: 25 });
  const isDragging = useRef(false);

  useAnimationFrame((t, delta) => {
    if (!isDragging.current && !hatched) {
      dragX.set(dragX.get() + delta * 0.02);
      dragY.set(dragY.get() + delta * 0.01);
    } else if (hatched) {
      dragX.set(dragX.get() + delta * 0.005);
      dragY.set(dragY.get() + delta * 0.002);
    }
  });

  return (
    <div style={{ perspective: '1200px', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10 }}>
      <motion.div
        style={{
          position: 'relative',
          width: 200, height: 200,
          rotateX, rotateY,
          transformStyle: 'preserve-3d',
          cursor: hatched ? 'default' : 'grab',
        }}
        onPanStart={() => isDragging.current = true}
        onPan={(e, info) => {
          dragX.set(dragX.get() + info.delta.x * 0.5);
          dragY.set(dragY.get() - info.delta.y * 0.5);
        }}
        onPanEnd={() => isDragging.current = false}
        onTap={() => { if (!hatched) setHatched(true); }}
        whileTap={{ cursor: 'grabbing' }}
        whileHover={{ scale: hatched ? 1 : 1.05 }}
      >
        {/* Cute Tadpole */}
        <motion.div
          style={{
            position: 'absolute',
            left: '50%', top: '50%',
            marginLeft: -35, marginTop: -35,
            width: 70, height: 70,
            transformStyle: 'preserve-3d',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
          }}
          animate={{
            scale: hatched ? 2.5 : 1,
            y: hatched ? [0, -30, 0] : [0, -10, 0],
          }}
          transition={{
            duration: hatched ? 1.5 : 2,
            repeat: Infinity,
            ease: "easeInOut",
          }}
        >
          {/* Tadpole Head */}
          <motion.div style={{
            width: 70, height: 70,
            borderRadius: '50% 50% 45% 45%',
            backgroundColor: activeColor.hex,
            boxShadow: `inset -8px -8px 20px rgba(0,0,0,0.15), 0 10px 20px ${activeColor.value}`,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 2,
          }}>
            {/* Cute Eyes */}
            <div style={{ display: 'flex', gap: '14px', marginTop: '-12px' }}>
              <div style={{ width: 12, height: 12, backgroundColor: '#fff', borderRadius: '50%', display: 'flex' }}>
                 <div style={{ width: 6, height: 6, backgroundColor: '#1a1a1a', borderRadius: '50%', margin: '2px 0 0 2px' }} />
              </div>
              <div style={{ width: 12, height: 12, backgroundColor: '#fff', borderRadius: '50%', display: 'flex' }}>
                 <div style={{ width: 6, height: 6, backgroundColor: '#1a1a1a', borderRadius: '50%', margin: '2px 0 0 2px' }} />
              </div>
            </div>
            {/* Blush */}
            <div style={{ position: 'absolute', top: '50%', left: '15%', width: 12, height: 6, backgroundColor: '#ff99aa', borderRadius: '50%', opacity: 0.8 }} />
            <div style={{ position: 'absolute', top: '50%', right: '15%', width: 12, height: 6, backgroundColor: '#ff99aa', borderRadius: '50%', opacity: 0.8 }} />
          </motion.div>
          {/* Tadpole Tail */}
          <motion.div
            style={{
              width: 16, height: 55,
              backgroundColor: activeColor.hex,
              borderRadius: '0 0 50% 50%',
              marginTop: -15,
              transformOrigin: 'top center',
              zIndex: 1,
            }}
            animate={{ rotateZ: [-35, 35, -35] }}
            transition={{ duration: 0.4, repeat: Infinity, ease: 'easeInOut' }}
          />
        </motion.div>

        {/* Jelly Egg Faces */}
        {faceDefs.map((face) => {
          const isVertical = ['front', 'back', 'left', 'right'].includes(face.id);
          const faceHeight = isVertical ? 260 : 200;
          const topOffset = isVertical ? -30 : 0;
          const zOffset = isVertical ? 100 : 130;
          const borderRadius = isVertical ? '50% 50% 50% 50% / 60% 60% 40% 40%' : '50%';

          return (
            <motion.div
              key={face.id}
              style={{
                position: 'absolute',
                top: topOffset,
                left: 0,
                width: 200,
                height: faceHeight,
                borderRadius: borderRadius,
                // Bright cyan jelly base with chosen spots
                background: `
                  radial-gradient(circle at 20% 30%, ${activeColor.value} 15%, transparent 18%),
                  radial-gradient(circle at 80% 60%, ${activeColor.value} 20%, transparent 24%),
                  radial-gradient(circle at 40% 80%, ${activeColor.value} 12%, transparent 15%),
                  rgba(128, 229, 255, 0.65)
                `,
                border: '4px solid rgba(255, 255, 255, 0.8)',
                boxShadow: 'inset 0 0 30px rgba(255, 255, 255, 1), 0 8px 24px rgba(0,0,0,0.1)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
                backfaceVisibility: 'visible',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              initial={{
                transform: `rotateY(${face.rotateY}deg) rotateX(${face.rotateX}deg) translateZ(${zOffset}px) scale(1)`
              }}
              animate={{
                transform: hatched
                  ? `rotateY(${face.rotateY}deg) rotateX(${face.rotateX}deg) translateZ(800px) scale(0)`
                  : `rotateY(${face.rotateY}deg) rotateX(${face.rotateX}deg) translateZ(${zOffset}px) scale(1)`,
                opacity: hatched ? 0 : 1
              }}
              transition={{
                duration: hatched ? 1.2 : 0,
                ease: hatched ? "backIn" : "linear"
              }}
            >
              {/* Cute highlight to make it look like shiny plastic/jelly */}
              <div style={{
                position: 'absolute',
                top: '10%',
                left: '20%',
                width: '30%',
                height: '15%',
                backgroundColor: 'rgba(255, 255, 255, 0.6)',
                borderRadius: '50%',
                transform: 'rotate(-20deg)',
                filter: 'blur(2px)'
              }} />
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
};

export default function App() {
  const [hatched, setHatched] = useState(false);
  const [activeColor, setActiveColor] = useState(COLORS[0]);

  return (
    <motion.div
      style={globalStyles}
      animate={{
        backgroundColor: hatched ? '#ffe6f2' : '#aaddff',
        backgroundImage: hatched
          ? 'radial-gradient(circle at 50% 50%, #ffffff 0%, #ffe6f2 100%)'
          : 'radial-gradient(circle at 50% 50%, #d4f0ff 0%, #aaddff 100%)'
      }}
      transition={{ duration: 1.5 }}
    >
      <FloatingMagic />
      <EggStats hatched={hatched} activeColor={activeColor} setActiveColor={setActiveColor} />
      <NeopianEgg hatched={hatched} setHatched={setHatched} activeColor={activeColor} />
      
      {/* Hatching Magic Flash Effect */}
      <motion.div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundColor: '#ffffff',
          zIndex: 9999,
          pointerEvents: 'none',
        }}
        initial={{ opacity: 0 }}
        animate={{ opacity: hatched ? [0, 1, 0] : 0 }}
        transition={{ duration: 2.5, times: [0, 0.05, 1], ease: "easeOut" }}
      />
    </motion.div>
  );
}


