import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';

// Plugin to serve static HTML files from public directory
const staticHtmlPlugin = () => {
  return {
    name: 'static-html',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Skip API routes and assets
        if (req.url?.startsWith('/api/') || req.url?.startsWith('/assets/') || req.url?.startsWith('/images/')) {
          return next();
        }
        
        const urlPath = req.url || '/';
        const ext = path.extname(urlPath);
        
        // Explicitly handle XML files (sitemap.xml, robots.txt, etc.)
        if (ext === '.xml' || ext === '.txt') {
          const normalizedPath = urlPath.startsWith('/') ? urlPath.slice(1) : urlPath;
          const publicPath = path.join(process.cwd(), 'public', normalizedPath);
          
          if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
            const contentType = ext === '.xml' ? 'application/xml' : 'text/plain';
            res.setHeader('Content-Type', contentType);
            res.end(fs.readFileSync(publicPath));
            return;
          }
        }
        
        // Skip if it's already a file request with extension (but not .html)
        if (ext && ext !== '.html' && ext !== '') {
          return next();
        }
        
        // React app routes - rewrite /app to root so Vite can process it
        if (urlPath === '/app' || urlPath === '/app/') {
          // Rewrite to root so Vite serves and processes the root index.html
          // This allows Vite's React plugin to transform the code properly
          req.url = '/';
          return next();
        }
        
        // For /app/* routes, rewrite to /* so Vite can handle assets correctly
        if (urlPath.startsWith('/app/')) {
          req.url = urlPath.replace('/app', '');
          return next();
        }
        
        // Root route - check if static HTML exists first, otherwise let React app handle it
        if (!urlPath || urlPath === '/') {
          // Check if this is coming from /app (we can't easily detect this, so we'll prioritize Vite)
          // Only serve public/index.html if explicitly requested and not from /app
          // For now, let Vite handle root to support /app -> / rewrite
          const staticIndexPath = path.join(process.cwd(), 'public', 'index.html');
          // Skip serving static HTML for root to allow /app to work
          // Users should access static site via direct paths, not root
          return next();
        }
        
        // For /index.html specifically, let Vite handle it (this is the React app)
        if (urlPath === '/index.html') {
          return next();
        }
        
        // Try to find static HTML file
        let htmlPath = urlPath;
        
        // If ends with /, look for index.html in that directory
        if (htmlPath.endsWith('/')) {
          htmlPath = htmlPath + 'index.html';
        } 
        // If doesn't end with .html, try adding it
        else if (!htmlPath.endsWith('.html')) {
          htmlPath = htmlPath + '.html';
        }
        
        // Remove leading slash for path.join
        const normalizedPath = htmlPath.startsWith('/') ? htmlPath.slice(1) : htmlPath;
        const publicPath = path.join(process.cwd(), 'public', normalizedPath);
        
        // Check if static HTML file exists in public folder
        if (fs.existsSync(publicPath) && fs.statSync(publicPath).isFile()) {
          // Serve the static HTML file
          res.setHeader('Content-Type', 'text/html');
          res.end(fs.readFileSync(publicPath));
          return;
        }
        
        // Otherwise, let Vite handle it (fall through to React app)
        next();
      });
    }
  };
};

export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        fs: {
          strict: false,
        },
      },
      plugins: [
        react({
          include: /\.(jsx|tsx)$/,
          jsxRuntime: 'automatic',
          babel: {
            plugins: []
          }
        }),
        staticHtmlPlugin()
      ],
      publicDir: 'public',
      // REMOVED: define block that was baking API keys into the build
      // The code correctly uses import.meta.env.VITE_GEMINI_API_KEY which Vite handles safely
      // process.env fallbacks in the code will be undefined in browser, which is correct
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
