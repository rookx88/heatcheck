import React, { useState, useEffect } from 'react';
import type { HeatcheckPost } from '../../index';
import { apiClient } from '../../apiClient';

/**
 * ===================================================================================
 * PUBLIC WEBSITE - SINGLE POST PAGE (`pages/posts/[slug].tsx`)
 * ===================================================================================
 * This file is a dynamic route in Next.js. It can render any post page,
 * like `/posts/the-betrayal` or `/posts/paybacks-a-bill`.
 *
 * In a real Next.js app, you'd use two functions:
 *
 * 1. `getStaticPaths`: To tell Next.js which pages to pre-build based on all the slugs
 *    of your published posts.
 *
 * 2. `getStaticProps`: To fetch the data for ONE specific post based on the slug
 *    provided in the URL params.
 *
 * ===================================================================================
 */

// This component simulates the page, assuming the post data is passed in as a prop.
const PublicPostPage: React.FC<{ slug: string }> = ({ slug }) => {
    const [post, setPost] = useState<HeatcheckPost | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        // In a real app, data comes from props. We fetch client-side for demo.
        if (slug) {
            apiClient.getPostBySlug(slug)
                .then(data => {
                    setPost(data);
                    setLoading(false);
                })
                .catch(error => {
                    console.error(`Could not load post with slug "${slug}":`, error);
                    setLoading(false);
                });
        }
    }, [slug]);

    if (loading) {
        return <p>Loading article...</p>;
    }

    if (!post) {
        return <p>Article not found.</p>;
    }

    return (
        <>
            <style>{`
                 /* Using the same styles as the homepage for simplicity */
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; background: #f9f9f9; color: #333; margin: 0; }
                .public-container { max-width: 800px; margin: 2rem auto; padding: 0 1rem; }
                .post-header { margin-bottom: 2rem; text-align: center; }
                .post-header h1 { font-size: 3.5rem; margin: 0 0 0.5rem 0; color: #111; line-height: 1.1; }
                .post-header p { font-size: 1.3rem; color: #666; margin: 0; }
                .post-content { font-size: 1.1rem; }
                .post-content h4 { font-size: 1.25rem; color: #111; border-bottom: 2px solid #eee; padding-bottom: 0.5rem; margin: 2.5rem 0 1rem 0; }
                .post-content ul { list-style-type: '📊'; padding-left: 1.5rem; }
                .post-content li { padding-left: 0.75rem; margin-bottom: 0.5rem; }
                .post-final-call { background: #fff; border: 1px solid #eee; border-left: 4px solid #0070f3; padding: 1.5rem; margin-top: 2rem; border-radius: 4px; }
            `}</style>
            <div className="public-container">
                <article>
                    <header className="post-header">
                        <h1>{post.websiteStory.headline}</h1>
                        <p>{post.websiteStory.dek}</p>
                    </header>
                    <div className="post-content">
                        <h4>🧾 The File</h4>
                        <p>{post.websiteStory.theBackstory}</p>
                        
                        <h4>📊 The Data</h4>
                        <ul>
                            {post.websiteStory.theData.map((stat, index) => <li key={index}>{stat}</li>)}
                        </ul>

                        <div className="post-final-call">
                            <h4>💥 The Heatchecks Edge</h4>
                            <p>{post.heatchecksEdge.finalCall}</p>
                        </div>
                    </div>
                </article>
            </div>
        </>
    );
};

// Example of how you might render this for testing. You'd need to provide a slug.
// const slug = "your-test-slug"; // Get this from window.location or hardcode for testing
// createRoot(container!).render(<PublicPostPage slug={slug} />);
