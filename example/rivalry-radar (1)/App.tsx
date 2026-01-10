import React, { useState } from 'react';
import { MatchupRequest, HeatCheckResponse } from './types';
import { generateNarrative } from './services/geminiService';
import MatchupInput from './components/MatchupInput';
import ArticleView from './components/ArticleView';
import HeatCheckDashboard from './components/HeatCheckDashboard';
import EvidenceBoard from './components/EvidenceBoard';
import { Flame, AlertTriangle, TrendingUp, Activity } from 'lucide-react';

const App: React.FC = () => {
  const [response, setResponse] = useState<HeatCheckResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async (req: MatchupRequest) => {
    setIsLoading(true);
    setError(null);
    setResponse(null);
    try {
      const data = await generateNarrative(req);
      setResponse(data);
    } catch (err: any) {
      console.error(err);
      setError("Unable to generate HEATCHECK. Please try again. " + (err.message || ""));
    } finally {
      setIsLoading(false);
    }
  };

  const matchup = response?.matchups[0];

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100 selection:bg-blue-500/30">
      {/* Navbar */}
      <header className="border-b border-slate-800 sticky top-0 z-50 bg-[#0f172a]/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-4 md:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-red-600 p-1.5 rounded-lg shadow-lg shadow-red-600/20">
              <Flame className="text-white w-5 h-5" />
            </div>
            <span className="font-bold text-xl tracking-tight text-white">
              HEAT<span className="text-slate-400">CHECK</span>
            </span>
          </div>
          <div className="text-xs font-medium text-slate-500 bg-slate-800 px-3 py-1 rounded-full border border-slate-700">
             System V2.0
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 md:px-8 py-8 md:py-12">
        
        {/* Input Section */}
        {!matchup && (
           <div className={`transition-all duration-500 ${isLoading ? 'opacity-50 pointer-events-none scale-95' : 'opacity-100 scale-100'}`}>
             <div className="text-center mb-12">
               <h1 className="text-4xl md:text-6xl font-black text-white mb-6 tracking-tight">
                 Predictive <span className="text-transparent bg-clip-text bg-gradient-to-r from-red-500 to-orange-500">Narrative</span> Engine
               </h1>
               <p className="text-lg text-slate-400 max-w-2xl mx-auto">
                 Multi-layer analysis of betting markets, historical friction, and social sentiment to identify the hidden stakes in upcoming matchups.
               </p>
             </div>
             <MatchupInput onAnalyze={handleAnalyze} isLoading={isLoading} />
           </div>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-[#0f172a]/80 backdrop-blur-sm">
             <div className="bg-slate-900 p-6 rounded-xl border border-slate-800 shadow-2xl flex flex-col items-center max-w-sm text-center">
                <Activity className="w-10 h-10 text-blue-500 animate-pulse mb-4" />
                <h3 className="text-xl font-bold text-white mb-2">Architecting Narrative</h3>
                <div className="space-y-2 w-full text-xs text-slate-500 font-mono text-left">
                   <div className="flex items-center gap-2">
                     <div className="w-2 h-2 rounded-full bg-green-500 animate-bounce"></div>
                     Phase 1: Cache Orchestration
                   </div>
                   <div className="flex items-center gap-2">
                     <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce delay-100"></div>
                     Phase 2: Odds & Fact Ingestion
                   </div>
                   <div className="flex items-center gap-2">
                     <div className="w-2 h-2 rounded-full bg-purple-500 animate-bounce delay-200"></div>
                     Phase 3: Evidence Mining
                   </div>
                   <div className="flex items-center gap-2">
                     <div className="w-2 h-2 rounded-full bg-orange-500 animate-bounce delay-300"></div>
                     Phase 4: Writer's Room
                   </div>
                   <div className="flex items-center gap-2">
                     <div className="w-2 h-2 rounded-full bg-red-500 animate-bounce delay-400"></div>
                     Phase 6: The Auditor (Fact Check)
                   </div>
                </div>
             </div>
          </div>
        )}

        {/* Error Message */}
        {error && (
          <div className="max-w-2xl mx-auto mt-8 p-4 bg-red-900/20 border border-red-800 rounded-lg flex items-center gap-3 text-red-200">
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {/* Result View */}
        {matchup && (
          <div className="animate-fade-in-up space-y-8">
            <div className="flex justify-between items-center">
              <button 
                onClick={() => setResponse(null)}
                className="text-slate-400 hover:text-white text-sm font-medium flex items-center gap-2 transition-colors"
              >
                &larr; New Scan
              </button>
              <div className="flex gap-2 text-xs font-mono text-slate-500">
                 <span>Run ID: {response?.run_meta.timestamp_utc.split('T')[1]}</span>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              
              {/* Left Column: Article */}
              <div className="lg:col-span-8">
                <ArticleView 
                  data={matchup.article} 
                  headline={matchup.narratives.candidate_cards.find(c => c.narrative_id === matchup.narratives.selected.primary_narrative_id)?.title || ""}
                  subhead={matchup.narratives.candidate_cards.find(c => c.narrative_id === matchup.narratives.selected.primary_narrative_id)?.claim || ""}
                />
              </div>

              {/* Right Column: Intelligence */}
              <div className="lg:col-span-4 space-y-8">
                
                {/* Odds Snapshot (Simplified) */}
                <div className="bg-slate-900 rounded-xl p-6 border border-slate-800">
                   <h3 className="text-sm font-bold text-slate-400 uppercase tracking-wider mb-4 flex items-center gap-2">
                     <TrendingUp className="w-4 h-4" />
                     Market Context
                   </h3>
                   <div className="space-y-3">
                      {matchup.fact_pack.odds.markets.slice(0, 3).map((m, idx) => (
                        <div key={idx} className="flex justify-between items-center text-sm p-2 bg-slate-950 rounded border border-slate-800">
                           <span className="text-slate-300 font-medium">{m.market}</span>
                           <span className="text-white font-mono">{m.outcomes.join('/')} {m.point ? `(${m.point > 0 ? '+' : ''}${m.point})` : ''}</span>
                        </div>
                      ))}
                      {matchup.fact_pack.odds.markets.length === 0 && (
                        <div className="text-xs text-slate-500 italic">No market lines found.</div>
                      )}
                      <div className="text-[10px] text-slate-600 mt-2 text-right">
                        Source: {matchup.fact_pack.odds.source}
                      </div>
                   </div>
                </div>

                <HeatCheckDashboard 
                  cards={matchup.narratives.candidate_cards} 
                  primaryId={matchup.narratives.selected.primary_narrative_id}
                  qualityReport={matchup.quality_report} 
                />
              </div>

              {/* Bottom: Evidence Board */}
              <div className="lg:col-span-12">
                 <EvidenceBoard bundle={matchup.evidence_bundle} />
              </div>

            </div>
          </div>
        )}
      </main>

    </div>
  );
};

export default App;