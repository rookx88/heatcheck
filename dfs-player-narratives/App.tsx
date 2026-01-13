import React, { useState } from 'react';
import FileUpload from './components/FileUpload';
import PlayerCard from './components/PlayerCard';
import { parseExcelFile } from './utils/excelParser';
import { analyzeSlate } from './services/geminiService';
import { PlayerAnalysis } from './types';
import { BrainCircuit, Loader2, RotateCcw, AlertTriangle } from 'lucide-react';

function App() {
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<PlayerAnalysis[]>([]);
  const [sport, setSport] = useState<'NBA' | 'NFL'>('NBA');
  const [error, setError] = useState<string | null>(null);

  const handleFileUpload = async (file: File) => {
    setLoading(true);
    setError(null);
    setResults([]);

    try {
      const rawData = await parseExcelFile(file);
      const slicedData = rawData.slice(0, 150); 
      const jsonString = JSON.stringify(slicedData);
      const analysis = await analyzeSlate(jsonString, sport);
      setResults(analysis);
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred.");
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setResults([]);
    setError(null);
  };

  return (
    <div className="public-container">
      {/* Top Left: Logo/Header */}
      <div className="top-left">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
             <div style={{ padding: '0.2rem', border: '1px solid #fff' }}>
                <BrainCircuit size={24} color="#fff" />
             </div>
             <div>
                <h1 style={{ fontSize: '1.2rem', margin: 0, lineHeight: 1 }}>DFS PLAYER</h1>
                <h1 style={{ fontSize: '1.2rem', margin: 0, lineHeight: 1, color: '#f84242' }}>NARRATIVES</h1>
             </div>
        </div>
      </div>

      {/* Top Right: Status/Banner */}
      <div className="top-right">
         <div style={{ fontFamily: "'Courier New', monospace", fontSize: '0.8rem', color: '#00ff41' }}>
            SYSTEM: ONLINE
         </div>
         <div style={{ fontFamily: "'Courier New', monospace", fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
            v2.4.0-NARRATIVE-ENGINE
         </div>
      </div>

      {/* Bottom Left: Navigation */}
      <div className="bottom-left">
         <button 
            onClick={() => setSport('NBA')} 
            className={`nav-link ${sport === 'NBA' ? 'active' : ''}`}
         >
            NBA
         </button>
         <button 
            onClick={() => setSport('NFL')} 
            className={`nav-link ${sport === 'NFL' ? 'active' : ''}`}
         >
            NFL
         </button>
      </div>

      {/* Bottom Right: Content Area */}
      <div className="bottom-right">
         
         {results.length === 0 && !loading && (
            <div style={{ maxWidth: '800px', margin: '0 auto', width: '100%' }}>
                <div className="content-area-title">
                    &gt; UPLOAD SLATE DATA
                </div>
                <FileUpload onFileUpload={handleFileUpload} onUseDemo={() => {}} />
                
                {error && (
                    <div style={{ marginTop: '1rem', border: '1px solid #f84242', background: 'rgba(248, 66, 66, 0.1)', padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#f84242' }}>
                        <AlertTriangle size={20} />
                        {error}
                    </div>
                )}
            </div>
         )}

         {loading && (
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <Loader2 size={64} className="animate-spin" color="#00ff41" />
                <div style={{ marginTop: '2rem', fontFamily: "'Courier New', monospace", color: '#00ff41', fontSize: '1.2rem', letterSpacing: '0.1em' }}>
                    &gt; ANALYZING MATCHUPS...
                </div>
                <div style={{ color: 'rgba(255,255,255,0.5)', fontFamily: "'Courier New', monospace", marginTop: '0.5rem' }}>
                    Accessing Google Search for Injury Reports...
                </div>
            </div>
         )}

         {results.length > 0 && !loading && (
            <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
                    <div className="content-area-title" style={{ marginBottom: 0 }}>
                        &gt; TOP VALUE PLAYS
                    </div>
                    <button 
                        onClick={handleReset} 
                        className="action-btn"
                        style={{ fontSize: '0.7rem' }}
                    >
                        NEW ANALYSIS
                    </button>
                </div>
                
                <div className="post-list">
                    {results.map((player) => (
                        <PlayerCard key={player.rank} player={player} />
                    ))}
                </div>

                <div style={{ marginTop: '3rem', borderTop: '1px dashed rgba(255,255,255,0.2)', paddingTop: '1rem', color: 'rgba(255,255,255,0.4)', fontSize: '0.8rem', fontFamily: "'Courier New', monospace" }}>
                    DISCLAIMER: ANALYSIS BASED ON PROBABILISTIC MODELS. NO GUARANTEES.
                </div>
            </div>
         )}

      </div>
    </div>
  );
}

export default App;
