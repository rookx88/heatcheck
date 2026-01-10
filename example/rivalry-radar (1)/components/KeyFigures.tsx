import React from 'react';
import { KeyFigure } from '../types';
import { User, Sword, ShieldAlert } from 'lucide-react';

interface KeyFiguresProps {
  figures: KeyFigure[];
}

const KeyFigures: React.FC<KeyFiguresProps> = ({ figures }) => {
  return (
    <div className="space-y-4">
      <h3 className="text-xl font-bold text-white flex items-center gap-2">
        <User className="w-5 h-5 text-blue-400" />
        Key Personnel
      </h3>
      <div className="grid grid-cols-1 gap-4">
        {figures.map((figure, idx) => (
          <div 
            key={idx} 
            className={`p-4 rounded-lg border relative overflow-hidden transition-transform hover:scale-[1.02] ${
              figure.isRevengeGame 
                ? 'bg-red-950/20 border-red-900/50' 
                : 'bg-slate-800/50 border-slate-700'
            }`}
          >
            {figure.isRevengeGame && (
              <div className="absolute top-0 right-0 bg-red-600 text-white text-[10px] font-bold px-2 py-1 uppercase tracking-wider rounded-bl">
                Revenge Game
              </div>
            )}
            
            <div className="flex items-start gap-3">
              <div className={`mt-1 p-2 rounded-full ${figure.isRevengeGame ? 'bg-red-900/30 text-red-400' : 'bg-blue-900/30 text-blue-400'}`}>
                {figure.isRevengeGame ? <Sword size={18} /> : <User size={18} />}
              </div>
              <div>
                <h4 className="font-bold text-white text-lg leading-tight">{figure.name}</h4>
                <div className="text-xs text-slate-400 uppercase tracking-wide font-semibold mb-2">
                  {figure.team} • {figure.role}
                </div>
                <p className="text-sm text-slate-300 leading-relaxed">
                  {figure.relevance}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default KeyFigures;