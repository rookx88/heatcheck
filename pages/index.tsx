import React, { useEffect } from 'react';

/**
 * ===================================================================================
 * PUBLIC WEBSITE - HOMEPAGE PREVIEW (`pages/index.tsx`)
 * ===================================================================================
 * This component renders a static HTML preview using vanilla JavaScript
 * for maximum SEO compatibility. The preview is served from /preview.html
 * which contains the terminal-style dark theme interface.
 * ===================================================================================
 */

interface PublicHomePageProps {
    onExit?: () => void;
}

export const PublicHomePage: React.FC<PublicHomePageProps> = ({ onExit }) => {
    useEffect(() => {
        // Make the preview fullscreen by adjusting body and container styles
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        document.body.style.overflow = 'hidden';
        
        const container = document.querySelector('.container');
        if (container) {
            (container as HTMLElement).style.margin = '0';
            (container as HTMLElement).style.padding = '0';
            (container as HTMLElement).style.width = '100vw';
            (container as HTMLElement).style.height = '100vh';
            (container as HTMLElement).style.maxWidth = 'none';
        }
        
        return () => {
            // Cleanup: restore original styles when component unmounts
            document.body.style.margin = '';
            document.body.style.padding = '';
            document.body.style.overflow = '';
            
            if (container) {
                (container as HTMLElement).style.margin = '';
                (container as HTMLElement).style.padding = '';
                (container as HTMLElement).style.width = '';
                (container as HTMLElement).style.height = '';
                (container as HTMLElement).style.maxWidth = '';
            }
        };
    }, []);

    return (
        <div style={{ 
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            border: 'none',
            margin: 0,
            padding: 0,
            zIndex: 1000,
            background: '#000'
        }}>
            {/* Floating exit button */}
            {onExit && (
                <button
                    onClick={onExit}
                    style={{
                        position: 'absolute',
                        top: '1rem',
                        right: '1rem',
                        zIndex: 10001,
                        background: 'rgba(0, 0, 0, 0.8)',
                        border: '2px solid #fff',
                        color: '#fff',
                        padding: '0.5rem 1rem',
                        cursor: 'pointer',
                        fontFamily: 'Arial, sans-serif',
                        fontSize: '0.875rem',
                        fontWeight: 'bold',
                        borderRadius: '4px',
                        transition: 'all 0.3s ease'
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)';
                        e.currentTarget.style.transform = 'scale(1.05)';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(0, 0, 0, 0.8)';
                        e.currentTarget.style.transform = 'scale(1)';
                    }}
                >
                    Exit Preview
                </button>
            )}
            <iframe
                src="/preview.html"
                style={{
                    width: '100%',
                    height: '100%',
                    border: 'none',
                    margin: 0,
                    padding: 0,
                    display: 'block'
                }}
                title="HeatChecks Website Preview"
                sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
            />
        </div>
    );
};