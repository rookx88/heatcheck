import React from 'react';

export const AboutPage: React.FC = () => {
    return (
        <>
            <style>{`
                body { 
                    font-family: 'Arial Black', 'Impact', 'Franklin Gothic Bold', 'Helvetica Neue', Arial, sans-serif;
                    font-weight: 900;
                    line-height: 1.6; 
                    background: #0a0e1a; 
                    color: #00ff41; 
                    margin: 0;
                }
                .about-container {
                    max-width: 800px;
                    margin: 2rem auto;
                    padding: 2rem;
                }
                .about-container h1 {
                    color: #f84242;
                    font-size: 3rem;
                    margin-bottom: 1rem;
                    text-transform: uppercase;
                }
                .about-container p {
                    color: #b3ffb3;
                    font-size: 1.1rem;
                    margin-bottom: 1.5rem;
                }
            `}</style>
            <div className="about-container">
                <h1>ABOUT US</h1>
                <p>Heat Checks is a narrative intelligence system that discovers hidden revenge stories and heated matchups in professional sports.</p>
                <p>We use advanced AI to uncover the emotional narratives beneath the surface - the stories that don't appear in basic searches.</p>
            </div>
        </>
    );
};














