import React from 'react';
import { PlayerAnalysis, NarrativeType } from '../types';
import { TrendingUp, AlertTriangle, User, ShieldAlert, Zap, Banknote } from 'lucide-react';

interface PlayerCardProps {
  player: PlayerAnalysis;
}

const PlayerCard: React.FC<PlayerCardProps> = ({ player }) => {
  
  // Dynamic styling based on narrative type
  const getTypeColor = (type: string) => {
    switch (type) {
      case NarrativeType.REVENGE:
        return '#f84242'; // Red
      case NarrativeType.PACE:
        return '#00ff41'; // Green
      case NarrativeType.GAME_SCRIPT:
        return '#00a8ff'; // Blue
      case NarrativeType.SHADOW:
        return '#fbbf24'; // Amber
      default:
        return '#cccccc';
    }
  };

  const color = getTypeColor(player.narrativeType);

  return (
    <div className="post-card" style={{ borderLeftColor: color }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
        <div>
           <div style={{ fontFamily: "'Courier New', monospace", color: color, fontSize: '0.8rem', fontWeight: 'bold' }}>
             #{player.rank} // {player.position}
           </div>
           <h3 style={{ fontSize: '1.4rem', margin: '0.2rem 0', textTransform: 'uppercase', lineHeight: '1.1', textShadow: `0 0 10px ${color}40` }}>
             {player.playerName}
           </h3>
           <div style={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.6)', fontFamily: "'Courier New', monospace" }}>
             {player.team} vs {player.opponent}
           </div>
        </div>
        <div style={{ textAlign: 'right' }}>
           <div style={{ fontSize: '1.2rem', color: '#fff', fontFamily: "'Courier New', monospace", fontWeight: 'bold' }}>
             ${player.salary}
           </div>
           <div style={{ fontSize: '0.7rem', color: color }}>
             CONFIDENCE: {player.confidenceScore}%
           </div>
        </div>
      </div>

      {/* Narrative Badge */}
      <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '0.5rem', 
          marginBottom: '1rem', 
          paddingBottom: '0.5rem', 
          borderBottom: '1px dashed rgba(255,255,255,0.2)' 
      }}>
        <div className="narrative-tag" style={{ color: color, borderColor: color }}>
           {player.narrativeType}
        </div>
        {player.keyStat && (
            <div style={{ marginLeft: 'auto', fontSize: '0.7rem', color: '#fff', fontFamily: "'Courier New', monospace" }}>
                {player.keyStat}
            </div>
        )}
      </div>

      {/* Analysis */}
      <div style={{ 
          fontFamily: "'Courier New', monospace", 
          fontSize: '0.85rem', 
          lineHeight: '1.5', 
          color: 'rgba(255,255,255,0.8)',
          flex: 1
      }}>
        <span style={{ color: color, marginRight: '0.5rem' }}>&gt;</span>
        {player.analysis}
      </div>

      {/* Footer Decor */}
      <div style={{ marginTop: '1rem', height: '2px', background: `linear-gradient(90deg, ${color} 0%, transparent 100%)`, opacity: 0.5 }}></div>
    </div>
  );
};

export default PlayerCard;
