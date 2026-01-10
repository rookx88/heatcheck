import React, { useState, useEffect } from 'react';
import type { HeatcheckPost } from '../index';
import { apiClient } from '../apiClient';

export const ArchivePage: React.FC = () => {
    const [posts, setPosts] = useState<HeatcheckPost[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        setLoading(true);
        apiClient.listPublishedPosts()
            .then(publishedPosts => {
                setPosts(publishedPosts);
                setLoading(false);
            })
            .catch(error => {
                console.error("Could not load posts:", error);
                setLoading(false);
            });
    }, []);

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
                .archive-container {
                    max-width: 1200px;
                    margin: 2rem auto;
                    padding: 2rem;
                }
                .archive-container h1 {
                    color: #f84242;
                    font-size: 3rem;
                    margin-bottom: 2rem;
                    text-transform: uppercase;
                }
                .archive-list {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
                    gap: 2rem;
                }
                .archive-item {
                    background: rgba(10, 14, 26, 0.8);
                    border: 2px solid #00ff41;
                    padding: 1.5rem;
                    text-decoration: none;
                    color: inherit;
                    display: block;
                    transition: all 0.3s ease;
                }
                .archive-item:hover {
                    border-color: #00ff80;
                    transform: translateY(-2px);
                }
                .archive-item h2 {
                    color: #00ff41;
                    font-size: 1.5rem;
                    margin-bottom: 0.5rem;
                }
                .archive-item p {
                    color: #b3ffb3;
                    font-size: 0.9rem;
                }
            `}</style>
            <div className="archive-container">
                <h1>ARCHIVE</h1>
                {loading ? (
                    <p>Loading...</p>
                ) : (
                    <div className="archive-list">
                        {posts.map(post => (
                            <a 
                                key={post.id}
                                href={`/posts/${post.websiteStory.seo.slug}`}
                                className="archive-item"
                                onClick={(e) => e.preventDefault()}
                            >
                                <h2>{post.websiteStory.headline}</h2>
                                <p>{post.websiteStory.dek}</p>
                                <p style={{ fontSize: '0.8rem', color: '#7fff7f', marginTop: '0.5rem' }}>
                                    {post.league} | {post.teamA} vs {post.teamB}
                                </p>
                            </a>
                        ))}
                    </div>
                )}
            </div>
        </>
    );
};











