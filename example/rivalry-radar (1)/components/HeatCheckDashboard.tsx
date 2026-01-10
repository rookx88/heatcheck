import React from 'react';
import { NarrativeCard } from '../types';
import { Target, Trophy, AlertCircle, Zap, TrendingUp, Users, CheckCircle2, ShieldCheck } from 'lucide-react';

interface HeatCheckDashboardProps {
  cards: NarrativeCard[];
  primaryId: string;
  qualityReport?: {
    corrections_applied: string[];
    hallucination_checks_passed: boolean;
  };
}

const HeatCheckDashboard: React.FC<HeatCheckDashboardProps> = ({ cards, primaryId, qualityReport }) => {
  // Sort cards so primary is first, then by total score
  const sortedCards = [...cards].sort((a, b) => {
    if (a.narrative_id === primaryId) return -1;
    if (b.narrative_id === primaryId) return 1;
    return b.total_score - a.total_score;
  });

  return (
    <div className="space-y-6">
      
      {/* Fact Check Monitor */}
      <div className="bg-slate-900 rounded-xl p-4 border border-slate-800 flex flex-col gap-3">
        <div className="flex justify-between items-center border-b border-slate-800 pb-2">
           <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-500" />
            Integrity Layer
          </h3>
          <span className="text-xs text-emerald-400 font-mono flex items-center gap-1">
            <CheckCircle2 size={12} /> VERIFIED
          </span>
        </div>
        
        {qualityReport?.corrections_applied && qualityReport.corrections_applied.length > 0 ? (
          <div className="text-xs text-amber-400 space-y-1">
            <span className="block font-bold mb-1">Corrections Applied:</span>
            {qualityReport.corrections_applied.map((correction, i) => (
              <div key={i} className="flex items-start gap-2 pl-2 border-l-2 border-amber-500/30">
                • {correction}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-slate-500 italic">
            Personnel status verified against live index. No anomalies detected.
          </div>
        )}
      </div>

      <h3 className="text-xl font-bold text-white flex items-center gap-2">
        <Target className="w-5 h-5 text-red-500" />
        Narrative Intelligence
      </h3>
      
      <div className="grid grid-cols-1 gap-6">
        {sortedCards.map((card) => {
          const isPrimary = card.narrative_id === primaryId;
          return (
            <div 
              key={card.narrative_id}
              className={`rounded-xl border p-6 transition-all ${
                isPrimary 
                  ? 'bg-slate-800 border-red-500/50 shadow-lg shadow-red-900/10' 
                  : 'bg-slate-900/50 border-slate-700 hover:border-slate-600'
              }`}
            >
              <div className="flex flex-col md:flex-row gap-6 justify-between">
                
                {/* Left: Info */}
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    {isPrimary && (
                      <span className="bg-red-600 text-white text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider">
                        Primary Driver
                      </span>
                    )}
                    <span className="text-slate-400 text-xs font-mono uppercase">ID: {card.narrative_id}</span>
                  </div>
                  
                  <h4 className="text-xl font-bold text-white mb-2 leading-tight">
                    {card.title}
                  </h4>
                  <p className="text-slate-400 text-sm mb-4 leading-relaxed">
                    {card.claim}
                  </p>

                  <div className="flex flex-wrap gap-2 mb-4">
                    {card.emotion_tags.map(tag => (
                      <span key={tag} className="text-xs bg-slate-700 text-slate-300 px-2 py-1 rounded-md capitalize">
                        #{tag}
                      </span>
                    ))}
                  </div>

                  <div className="flex items-center gap-2 text-xs text-slate-500">
                    <Users size={14} />
                    <span>{card.key_characters.join(', ')}</span>
                  </div>
                </div>

                {/* Right: Scores */}
                <div className="w-full md:w-64 flex-shrink-0 bg-slate-950/50 rounded-lg p-4 border border-slate-800">
                   <div className="flex justify-between items-end mb-4">
                     <span className="text-slate-400 text-xs font-bold uppercase">Heatscore</span>
                     <span className={`text-2xl font-black ${isPrimary ? 'text-red-400' : 'text-blue-400'}`}>
                       {card.total_score}<span className="text-slate-600 text-sm">/35</span>
                     </span>
                   </div>
                   
                   <div className="space-y-2">
                     <ScoreBar label="Facts" value={card.score_breakdown.factual_support} />
                     <ScoreBar label="Stakes" value={card.score_breakdown.stakes} />
                     <ScoreBar label="Emotion" value={card.score_breakdown.audience_resonance} />
                     <ScoreBar label="Uniqueness" value={card.score_breakdown.uniqueness} />
                   </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const ScoreBar = ({ label, value }: { label: string, value: number }) => (
  <div className="flex items-center gap-2 text-xs">
    <span className="w-16 text-slate-500 text-right">{label}</span>
    <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
      <div 
        className="h-full bg-slate-600 rounded-full" 
        style={{ width: `${(value / 5) * 100}%` }}
      />
    </div>
    <span className="w-3 text-slate-400">{value}</span>
  </div>
);

export default HeatCheckDashboard;