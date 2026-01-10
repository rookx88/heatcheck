import React from 'react';
import ReactMarkdown from 'react-markdown';
import { ArticleData } from '../types';
import { Share2, Bookmark } from 'lucide-react';

interface ArticleViewProps {
  data: ArticleData;
  headline: string; // Passed from parent since it's now separate in HeatCheckMatchup
  subhead?: string;
}

const ArticleView: React.FC<ArticleViewProps> = ({ data, headline, subhead }) => {
  return (
    <article className="bg-slate-900 rounded-xl overflow-hidden border border-slate-800 shadow-2xl">
      {/* Header */}
      <div className="p-8 md:p-12 border-b border-slate-800 bg-gradient-to-b from-slate-800/50 to-slate-900">
        <div className="flex items-center gap-3 mb-6">
          <span className="bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded uppercase tracking-wider">
            HEATCHECK Report
          </span>
          <span className="text-slate-400 text-xs font-medium uppercase tracking-wider">
            {new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
          </span>
        </div>
        
        <h1 className="text-3xl md:text-5xl font-black text-white leading-tight mb-4 font-serif">
          {headline || data.seo.title_options[0]}
        </h1>
        {subhead && (
          <h2 className="text-xl text-slate-300 font-light leading-relaxed max-w-3xl">
            {subhead}
          </h2>
        )}

        <div className="flex gap-4 mt-8">
          <button className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium">
            <Share2 size={16} /> Share
          </button>
          <button className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors text-sm font-medium">
            <Bookmark size={16} /> Save
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="p-8 md:p-12 max-w-none">
        <div className="markdown-content font-serif text-slate-300">
          <ReactMarkdown>{data.long_form_markdown}</ReactMarkdown>
        </div>
      </div>
      
      {/* SEO Footer */}
      <div className="px-8 py-4 bg-slate-950 border-t border-slate-800 text-xs text-slate-600 font-mono">
         Keywords: {data.seo.primary_keyword}, {data.seo.title_options.join(', ')}
      </div>
    </article>
  );
};

export default ArticleView;