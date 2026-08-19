import { motion, useMotionValue, useSpring } from 'motion/react';
import { useEffect, useState } from 'react';
import { Fish, Droplets, Leaf, ArrowRight, MousePointerClick, Flame } from 'lucide-react';

const TANK_W = 300;
const TANK_H = 400;
const TANK_D = 300;
const Z_W = TANK_W / 2;
const Z_H = TANK_H / 2;

const Face3D = ({ 
  width, 
  height, 
  rotateX = 0, 
  rotateY = 0, 
  translateZ = 0, 
  children, 
  className = '' 
}: {
  width: number;
  height: number;
  rotateX?: number;
  rotateY?: number;
  translateZ?: number;
  children: React.ReactNode;
  className?: string;
}) => (
  <div
    className={`absolute ${className}`}
    style={{
      width,
      height,
      left: '50%',
      top: '50%',
      marginLeft: -width / 2,
      marginTop: -height / 2,
      transform: `rotateX(${rotateX}deg) rotateY(${rotateY}deg) translateZ(${translateZ}px)`,
      transformStyle: 'preserve-3d'
    }}
  >
    {children}
  </div>
);

const FlippableWall = ({ 
  rotateY, 
  translateZ, 
  title, 
  icon: Icon, 
  article 
}: {
  rotateY: number;
  translateZ: number;
  title: string;
  icon: any;
  article: React.ReactNode;
}) => {
  const [isFlipped, setIsFlipped] = useState(false);

  return (
    <Face3D width={TANK_W} height={TANK_H} rotateY={rotateY} translateZ={translateZ}>
      <motion.div
        className="w-full h-full relative cursor-pointer"
        style={{ transformStyle: 'preserve-3d' }}
        animate={{ rotateY: isFlipped ? 180 : 0 }}
        transition={{ duration: 0.8, type: 'spring', bounce: 0.3 }}
        onClick={() => setIsFlipped(!isFlipped)}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
      >
        {/* Front - Glass */}
        <div
          className="absolute inset-0 flex flex-col items-center justify-center p-6 border-2 border-white/10 bg-cyan-900/30 backdrop-blur-[4px] rounded-xl overflow-hidden shadow-[inset_0_0_40px_rgba(34,211,238,0.15)] group"
          style={{ backfaceVisibility: 'hidden' }}
        >
          <div className="absolute top-0 inset-x-0 h-1/2 bg-gradient-to-b from-white/10 to-transparent pointer-events-none" />
          <Icon className="w-14 h-14 text-cyan-200 mb-6 drop-shadow-lg opacity-90 transition-transform group-hover:scale-110" />
          <h2 className="text-2xl font-bold text-white tracking-wider drop-shadow-md text-center">{title}</h2>
          
          <div className="absolute bottom-6 flex items-center gap-2 text-cyan-200/70 text-[10px] font-bold tracking-[0.2em] uppercase bg-black/20 px-4 py-2 rounded-full opacity-0 translate-y-4 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300">
            <MousePointerClick className="w-4 h-4" />
            <span>Click to Read</span>
          </div>
        </div>

        {/* Back - Article (Opaque) */}
        <div
          className="absolute inset-0 flex flex-col bg-slate-900 border-2 border-cyan-800 rounded-xl overflow-hidden shadow-xl"
          style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
        >
          <div className="flex items-center gap-3 p-5 border-b border-slate-800 bg-slate-900/80 shrink-0">
            <div className="p-2 bg-cyan-500/10 rounded-lg">
              <Icon className="w-5 h-5 text-cyan-400" />
            </div>
            <h3 className="text-lg font-bold text-slate-100 uppercase tracking-wider">{title}</h3>
          </div>
          <div className="p-6 space-y-4 text-sm text-slate-300 leading-relaxed overflow-y-auto overflow-x-hidden no-scrollbar">
            {article}
          </div>
        </div>
      </motion.div>
    </Face3D>
  );
};

const Bubbles = () => (
  <Face3D width={TANK_W} height={200} rotateY={0} translateZ={0} className="pointer-events-none">
    <div className="w-full h-full relative overflow-hidden">
      {[...Array(15)].map((_, i) => (
        <motion.div
          key={i}
          className="absolute bottom-0 w-2 h-2 bg-white/40 rounded-full blur-[1px]"
          style={{ left: `${10 + Math.random() * 80}%` }}
          animate={{
            y: [0, -350],
            x: [0, Math.random() * 30 - 15, 0, Math.random() * 30 - 15]
          }}
          transition={{
            duration: 3 + Math.random() * 4,
            repeat: Infinity,
            delay: Math.random() * 5,
            ease: "linear"
          }}
        />
      ))}
    </div>
  </Face3D>
);

const SwimmingFish = ({ zOffset, delay }: { zOffset: number; delay: number }) => (
  <Face3D width={100} height={50} rotateY={0} translateZ={zOffset} className="pointer-events-none">
    <motion.div
      className="w-full h-full flex items-center justify-center"
      animate={{
        x: [-140, 140, 140, -140, -140],
        scaleX: [1, 1, -1, -1, 1]
      }}
      transition={{ 
        duration: 20, 
        repeat: Infinity, 
        delay,
        times: [0, 0.45, 0.5, 0.95, 1], 
        ease: "linear" 
      }}
    >
      <Fish className="w-10 h-10 text-orange-400 opacity-90 drop-shadow-[0_0_8px_rgba(251,146,60,0.6)]" />
    </motion.div>
  </Face3D>
);

const ARTICLES = [
  {
    title: "Ocean Currents",
    icon: Droplets,
    rotateY: 0,
    content: (
      <>
        <p>
          The global conveyor belt, a system of deep-ocean circulation driven by temperature and salinity, plays a crucial role in regulating Earth's climate.
        </p>
        <p>
          Surface currents, moved by wind, and deep currents mix the oceans' waters, distributing heat from the equator to the poles. Changes in these currents can have dramatic impacts on weather patterns worldwide.
        </p>
        <p>
          Without ocean currents, regional temperatures would be more extreme—super hot at the equator and frigid toward the poles.
        </p>
      </>
    )
  },
  {
    title: "Coral Reefs",
    icon: Fish,
    rotateY: 90,
    content: (
      <>
        <p>
          Often called the "rainforests of the sea", coral reefs are some of the most diverse ecosystems on the planet.
        </p>
        <p>
          They occupy less than 0.1% of the world's ocean surface, yet they provide a home for at least 25% of all marine species, including fish, mollusks, worms, crustaceans, echinoderms, and sponges.
        </p>
        <p>
          Reefs are delicate and face severe threats from climate change, ocean acidification, and water pollution.
        </p>
      </>
    )
  },
  {
    title: "Kelp Forests",
    icon: Leaf,
    rotateY: -90,
    content: (
      <>
        <p>
          Kelp forests are underwater areas with a high density of kelp, which covers a large part of the world's coastlines. They are recognized as one of the most productive and dynamic ecosystems on Earth.
        </p>
        <p>
          These towering algae provide crucial habitat and food for a variety of marine life, serving as nurseries for young fish and offering protection from predators.
        </p>
        <p>
          Giant kelp can grow incredibly fast, sometimes up to two feet per day under ideal conditions.
        </p>
      </>
    )
  },
  {
    title: "Deep Sea Vents",
    icon: Flame,
    rotateY: 180,
    content: (
      <>
        <p>
          Hydrothermal vents are geysers on the seafloor. They continuously spew super-hot, mineral-rich water that helps support diverse and unique ecosystems.
        </p>
        <p>
          Unlike most life on Earth, which relies on sunlight and photosynthesis, the organisms here depend on chemosynthesis—converting toxic minerals into energy.
        </p>
        <p>
          Giant tube worms, blind shrimp, and sulfur-eating bacteria thrive in this extreme environment of total darkness and intense pressure.
        </p>
      </>
    )
  }
];

export default function FishtankCard() {
  const rotateX = useMotionValue(0);
  const rotateY = useMotionValue(0);
  
  // Springs for smooth drag release
  const springX = useSpring(rotateX, { stiffness: 150, damping: 25 });
  const springY = useSpring(rotateY, { stiffness: 150, damping: 25 });

  useEffect(() => {
    // Initial isometric view
    rotateX.set(-15);
    rotateY.set(35);
  }, [rotateX, rotateY]);

  const handlePan = (_: any, info: any) => {
    // Prevent the user from flipping it completely upside down if desired,
    // but for full 3D, let them spin it freely.
    let nextX = rotateX.get() - info.delta.y * 0.4;
    // clamp X rotation to avoid weird gimbal lock feel
    nextX = Math.max(-80, Math.min(80, nextX));
    rotateX.set(nextX);
    rotateY.set(rotateY.get() + info.delta.x * 0.4);
  };

  return (
    <div className="w-screen h-screen overflow-hidden bg-slate-950 flex flex-col items-center justify-center font-sans touch-none select-none">
      <div className="absolute top-8 sm:top-12 flex flex-col items-center text-center z-10 pointer-events-none px-4">
        <h1 className="text-xl sm:text-3xl font-bold text-white tracking-widest uppercase mb-2">Abyssal Knowledge</h1>
        <p className="text-cyan-400/80 text-[10px] sm:text-sm font-medium tracking-widest uppercase">Drag to rotate &bull; Click panels to read</p>
      </div>

      <motion.div 
        onPan={handlePan}
        style={{ perspective: '1200px' }} 
        className="absolute inset-0 flex items-center justify-center cursor-grab active:cursor-grabbing scale-75 sm:scale-90 md:scale-100"
        aria-hidden="true"
      >
        <motion.div
          className="relative w-0 h-0 flex items-center justify-center"
          style={{ 
            rotateX: springX, 
            rotateY: springY, 
            transformStyle: 'preserve-3d' 
          }}
        >
          {/* Ambient Inner Glow */}
          <div
            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-[350px] bg-cyan-500/30 blur-[100px] pointer-events-none"
            style={{ transform: 'translateZ(-50px)' }}
          />

          {/* BOTTOM BASE (Sand/Gravel) */}
          <Face3D width={TANK_W} height={TANK_D} rotateX={-90} translateZ={Z_H}>
            <div className="w-full h-full bg-slate-900 border-2 border-slate-700 rounded-xl shadow-[0_0_80px_rgba(0,0,0,0.8)] flex items-center justify-center">
              <div className="w-full h-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-amber-900/20 to-slate-900 rounded-xl" />
            </div>
          </Face3D>

          {/* TOP LID / RIM */}
          <Face3D width={TANK_W} height={TANK_D} rotateX={90} translateZ={Z_H}>
            <div className="w-full h-full border-[6px] border-cyan-800/40 rounded-xl shadow-[inset_0_0_20px_rgba(6,182,212,0.1)] pointer-events-none" />
          </Face3D>

          {/* WATER ANIMATION SURFACE (Inside) */}
          {/* Sits lower in the tank: Z_H is the top (200). We move it DOWN by using a negative translateZ on the rotated X face. */}
          <Face3D width={TANK_W - 4} height={TANK_D - 4} rotateX={90} translateZ={-50} className="pointer-events-none">
            <motion.div
              className="w-full h-full bg-cyan-400/20 rounded-xl"
              style={{
                boxShadow: 'inset 0 0 50px rgba(6, 182, 212, 0.4)',
                backgroundImage: 'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.15) 0%, transparent 70%)'
              }}
              animate={{ z: [0, 8, 0] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
            />
          </Face3D>

          {/* INNER SCENERY */}
          <SwimmingFish zOffset={-60} delay={0} />
          <SwimmingFish zOffset={40} delay={8} />
          <Bubbles />

          {/* FLIPPABLE SIDES */}
          {ARTICLES.map((article, idx) => (
            <FlippableWall
              key={idx}
              rotateY={article.rotateY}
              translateZ={Z_W}
              title={article.title}
              icon={article.icon}
              article={article.content}
            />
          ))}
        </motion.div>
      </motion.div>

      {/* SEO & Screen Reader Fallback */}
      <div className="sr-only">
        <h2>Abyssal Knowledge - Interactive Articles</h2>
        {ARTICLES.map((article, idx) => (
          <article key={idx}>
            <h3>{article.title}</h3>
            {article.content}
          </article>
        ))}
      </div>
    </div>
  );
}
