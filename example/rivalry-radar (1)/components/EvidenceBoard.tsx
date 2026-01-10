import React from 'react';
import { EvidenceBundle } from '../types';
import { Quote, Calendar, Link2, ExternalLink } from 'lucide-react';

interface EvidenceBoardProps {
  bundle: EvidenceBundle;
}

const EvidenceBoard: React.FC<EvidenceBoardProps> = ({ bundle }) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
      
      {/* Timeline Column */}
      <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
        <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
          <Calendar className="w-4 h-4 text-blue-400" />
          Timeline of Friction
        </h3>
        <div className="relative pl-2 space-y-8">
          {/* Vertical Line */}
          <div className="absolute top-2 left-[19px] bottom-2 w-0.5 bg-slate-800"></div>

          {bundle.timeline_events.map((event) => (
            <div key={event.event_id} className="relative pl-10">
              {/* Dot */}
              <div className="absolute left-[13px] top-1.5 w-3 h-3 rounded-full bg-slate-700 border-2 border-slate-900 z-10"></div>
              
              <div className="flex flex-col">
                <span className="text-xs font-mono text-slate-500 mb-1">
                  {new Date(event.date_utc).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                </span>
                <span className="text-xs font-bold uppercase tracking-wider text-blue-500 mb-1">
                  {event.event_type}
                </span>
                <p className="text-sm text-slate-300 leading-snug">
                  {event.summary}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quotes Column */}
      <div className="bg-slate-900 rounded-xl border border-slate-800 p-6">
        <h3 className="text-lg font-bold text-white mb-6 flex items-center gap-2">
          <Quote className="w-4 h-4 text-amber-400" />
          Receipts & Quotes
        </h3>
        
        <div className="space-y-4">
          {bundle.quotes.map((quote) => {
             const source = bundle.sources.find(s => s.source_id === quote.source_id);
             return (
              <div key={quote.quote_id} className="bg-slate-950/50 p-4 rounded-lg border border-slate-800/50">
                <blockquote className="text-slate-300 italic text-sm mb-3">
                  "{quote.quote}"
                </blockquote>
                <div className="flex justify-between items-end">
                  <div>
                    <div className="text-sm font-bold text-white">{quote.speaker}</div>
                    <div className="text-xs text-slate-500">{quote.context}</div>
                  </div>
                  {source && (
                    <a 
                      href={source.url} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-slate-600 hover:text-blue-400 transition-colors"
                      title={source.title}
                    >
                      <ExternalLink size={14} />
                    </a>
                  )}
                </div>
              </div>
             );
          })}
          {bundle.quotes.length === 0 && (
            <div className="text-slate-500 text-sm italic">
              No direct quotes found for this specific angle.
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

export default EvidenceBoard;