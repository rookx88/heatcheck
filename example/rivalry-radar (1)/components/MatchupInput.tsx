import React, { useState } from 'react';
import { MatchupRequest, Sport } from '../types';
import { Search, Loader2 } from 'lucide-react';

interface MatchupInputProps {
  onAnalyze: (req: MatchupRequest) => void;
  isLoading: boolean;
}

const SPORTS: Sport[] = ['NBA', 'NFL', 'Premier League', 'MLB', 'NHL', 'UFC', 'Other'];

const MatchupInput: React.FC<MatchupInputProps> = ({ onAnalyze, isLoading }) => {
  const [teamA, setTeamA] = useState('');
  const [teamB, setTeamB] = useState('');
  const [sport, setSport] = useState<Sport>('NBA');
  const [context, setContext] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamA || !teamB) return;
    onAnalyze({ teamA, teamB, sport, context });
  };

  return (
    <div className="w-full max-w-2xl mx-auto bg-slate-900/80 backdrop-blur-md p-6 md:p-8 rounded-2xl border border-slate-700 shadow-2xl">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-bold text-white mb-2">Initialize Narrative Scan</h2>
        <p className="text-slate-400">Enter a matchup to uncover hidden storylines and friction points.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 relative">
          
          {/* VS Badge */}
          <div className="hidden md:flex absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-slate-800 rounded-full border border-slate-600 items-center justify-center z-10 font-black text-slate-500 italic">
            VS
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300 uppercase tracking-wide">Home / Team A</label>
            <input
              type="text"
              value={teamA}
              onChange={(e) => setTeamA(e.target.value)}
              placeholder="e.g. Lakers"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              disabled={isLoading}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300 uppercase tracking-wide">Away / Team B</label>
            <input
              type="text"
              value={teamB}
              onChange={(e) => setTeamB(e.target.value)}
              placeholder="e.g. Celtics"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition-all"
              disabled={isLoading}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300 uppercase tracking-wide">Sport</label>
            <select
              value={sport}
              onChange={(e) => setSport(e.target.value as Sport)}
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-3 text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all appearance-none"
              disabled={isLoading}
            >
              {SPORTS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-300 uppercase tracking-wide">Context (Optional)</label>
            <input
              type="text"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder="e.g. Playoffs Game 7"
              className="w-full bg-slate-800 border border-slate-600 rounded-lg px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
              disabled={isLoading}
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={isLoading || !teamA || !teamB}
          className={`w-full py-4 rounded-lg font-bold text-lg flex items-center justify-center gap-2 transition-all shadow-lg
            ${isLoading 
              ? 'bg-slate-700 text-slate-400 cursor-not-allowed' 
              : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white hover:shadow-blue-500/25'
            }`}
        >
          {isLoading ? (
            <>
              <Loader2 className="animate-spin" />
              Running Multi-Layer Deduction...
            </>
          ) : (
            <>
              <Search className="w-5 h-5" />
              Analyze Matchup
            </>
          )}
        </button>
      </form>
    </div>
  );
};

export default MatchupInput;