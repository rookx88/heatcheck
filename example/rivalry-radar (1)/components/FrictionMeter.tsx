import React from 'react';

interface FrictionMeterProps {
  score: number;
}

const FrictionMeter: React.FC<FrictionMeterProps> = ({ score }) => {
  // Determine color based on score
  const getColor = (s: number) => {
    if (s < 30) return 'bg-blue-500';
    if (s < 60) return 'bg-yellow-500';
    if (s < 85) return 'bg-orange-500';
    return 'bg-red-600';
  };

  const getLabel = (s: number) => {
    if (s < 30) return 'Low Tension';
    if (s < 60) return 'Simmering';
    if (s < 85) return 'Heated Rivalry';
    return 'All-Out War';
  };

  return (
    <div className="w-full bg-slate-800 p-6 rounded-xl border border-slate-700 shadow-lg">
      <div className="flex justify-between items-end mb-2">
        <span className="text-slate-400 text-sm font-semibold uppercase tracking-wider">Friction Score</span>
        <span className={`text-3xl font-bold ${score > 80 ? 'text-red-500' : 'text-white'}`}>
          {score}<span className="text-sm text-slate-500 font-normal">/100</span>
        </span>
      </div>
      
      <div className="h-4 w-full bg-slate-900 rounded-full overflow-hidden relative">
        <div 
          className={`h-full transition-all duration-1000 ease-out ${getColor(score)}`}
          style={{ width: `${score}%` }}
        />
        {/* Tick marks */}
        <div className="absolute top-0 left-1/4 h-full w-0.5 bg-slate-800/50"></div>
        <div className="absolute top-0 left-2/4 h-full w-0.5 bg-slate-800/50"></div>
        <div className="absolute top-0 left-3/4 h-full w-0.5 bg-slate-800/50"></div>
      </div>

      <div className="mt-3 flex justify-between items-center">
        <span className="text-sm text-slate-400 italic">{getLabel(score)}</span>
        {score > 85 && (
           <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-900/50 text-red-200 animate-pulse">
             High Alert
           </span>
        )}
      </div>
    </div>
  );
};

export default FrictionMeter;