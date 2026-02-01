// BACKUP OF TWITTER/REDDIT GENERATOR CODE FROM index.tsx
// This file contains the code sections that need to be re-added after restoring from git

// ============================================================================
// IMPORTS (lines 8-9)
// ============================================================================
import { generateDFSContent } from './scripts/services/dfsTweetService';
import { generateHeatArticleContent } from './scripts/services/heatArticleContentService';

// ============================================================================
// STATE VARIABLES (lines 1640-1655) - Add in HeatchecksFeed component
// ============================================================================
const [showTweetModal, setShowTweetModal] = useState(false);
const [selectedPostForTweet, setSelectedPostForTweet] = useState<HeatcheckPost | null>(null);
const [selectedPlayerIndex, setSelectedPlayerIndex] = useState<number>(0);
const [generatedTweet, setGeneratedTweet] = useState<string>('');
const [generatedReddit, setGeneratedReddit] = useState<{ title: string; body: string } | null>(null);
const [isGeneratingTweet, setIsGeneratingTweet] = useState(false);
const [activeTab, setActiveTab] = useState<'tweet' | 'reddit'>('tweet');

// Heat Article content generation state
const [showHeatArticleModal, setShowHeatArticleModal] = useState(false);
const [selectedPostForHeatArticle, setSelectedPostForHeatArticle] = useState<HeatcheckPost | null>(null);
const [selectedNarrativeIndex, setSelectedNarrativeIndex] = useState<number>(0);
const [generatedHeatTweet, setGeneratedHeatTweet] = useState<string>('');
const [generatedHeatReddit, setGeneratedHeatReddit] = useState<{ title: string; body: string } | null>(null);
const [isGeneratingHeatContent, setIsGeneratingHeatContent] = useState(false);
const [activeHeatTab, setActiveHeatTab] = useState<'tweet' | 'reddit'>('tweet');

// ============================================================================
// HANDLER FUNCTIONS (lines 1688-1809)
// ============================================================================

const handleGenerateTweet = async () => {
    if (!selectedPostForTweet) return;
    
    const dfsPlayers = selectedPostForTweet.heatCheckData?.dfsPlayers || [];
    if (dfsPlayers.length === 0) {
        alert('No players found in this DFS article.');
        return;
    }
    
    const selectedPlayer = dfsPlayers[selectedPlayerIndex];
    setIsGeneratingTweet(true);
    setGeneratedTweet('');
    setGeneratedReddit(null);
    
    try {
        // Show progress message
        setGeneratedTweet('🔍 Researching additional narratives for this player...\n\nThis may take 30-60 seconds...');
        
        const { tweet, reddit } = await generateDFSContent(
            selectedPlayer,
            selectedPostForTweet.league as 'NBA' | 'NFL',
            selectedPostForTweet.matchupScheduledDate || selectedPostForTweet.createdAt
        );
        setGeneratedTweet(tweet);
        setGeneratedReddit(reddit);
    } catch (error: any) {
        console.error("Failed to generate content:", error);
        alert(`Failed to generate content: ${error.message || 'Unknown error'}`);
        setGeneratedTweet('');
        setGeneratedReddit(null);
    } finally {
        setIsGeneratingTweet(false);
    }
};

const handleCopyTweet = () => {
    if (generatedTweet) {
        navigator.clipboard.writeText(generatedTweet).then(() => {
            alert('Tweet copied to clipboard!');
        }).catch(err => {
            console.error('Failed to copy:', err);
            alert('Failed to copy tweet. Please select and copy manually.');
        });
    }
};

const handleCopyReddit = () => {
    if (generatedReddit) {
        const redditText = `${generatedReddit.title}\n\n${generatedReddit.body}`;
        navigator.clipboard.writeText(redditText).then(() => {
            alert('Reddit post copied to clipboard!');
        }).catch(err => {
            console.error('Failed to copy:', err);
            alert('Failed to copy Reddit post. Please select and copy manually.');
        });
    }
};

// Heat Article content generation handlers
const handleGenerateHeatArticleContent = async () => {
    if (!selectedPostForHeatArticle) return;
    
    const narrativeCards = selectedPostForHeatArticle.heatCheckData?.narratives?.candidate_cards || [];
    if (narrativeCards.length === 0) {
        alert('No narratives found in this Heat Article.');
        return;
    }
    
    const selectedNarrative = narrativeCards[selectedNarrativeIndex];
    setIsGeneratingHeatContent(true);
    setGeneratedHeatTweet('');
    setGeneratedHeatReddit(null);
    
    try {
        // Show progress message
        setGeneratedHeatTweet('🔍 Researching additional story context for this narrative...\n\nThis may take 30-60 seconds...');
        
        const { tweet, reddit } = await generateHeatArticleContent(
            selectedNarrative,
            {
                teamA: selectedPostForHeatArticle.teamA,
                teamB: selectedPostForHeatArticle.teamB,
                league: selectedPostForHeatArticle.league,
                matchupDate: selectedPostForHeatArticle.matchupScheduledDate || selectedPostForHeatArticle.createdAt,
                evidenceBundle: selectedPostForHeatArticle.heatCheckData?.evidenceBundle || selectedPostForHeatArticle.heatCheckData?.evidence_bundle,
                factPack: selectedPostForHeatArticle.heatCheckData?.factPack
            }
        );
        setGeneratedHeatTweet(tweet);
        setGeneratedHeatReddit(reddit);
    } catch (error: any) {
        console.error("Failed to generate Heat Article content:", error);
        alert(`Failed to generate content: ${error.message || 'Unknown error'}`);
        setGeneratedHeatTweet('');
        setGeneratedHeatReddit(null);
    } finally {
        setIsGeneratingHeatContent(false);
    }
};

const handleCopyHeatTweet = () => {
    if (generatedHeatTweet) {
        navigator.clipboard.writeText(generatedHeatTweet).then(() => {
            alert('Tweet copied to clipboard!');
        }).catch(err => {
            console.error('Failed to copy:', err);
            alert('Failed to copy tweet. Please select and copy manually.');
        });
    }
};

const handleCopyHeatReddit = () => {
    if (generatedHeatReddit) {
        const redditText = `${generatedHeatReddit.title}\n\n${generatedHeatReddit.body}`;
        navigator.clipboard.writeText(redditText).then(() => {
            alert('Reddit post copied to clipboard!');
        }).catch(err => {
            console.error('Failed to copy:', err);
            alert('Failed to copy Reddit post. Please select and copy manually.');
        });
    }
};







