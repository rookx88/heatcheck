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
        
        // Skip if it's already a file request with extension (but not .html)
        const urlPath = req.url || '/';
        const ext = path.extname(urlPath);
        if (ext && ext !== '.html' && ext !== '') {
          return next();
        }
        
        // Root route - let React app handle it
        if (!urlPath || urlPath === '/' || urlPath === '/index.html') {
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
      plugins: [react(), staticHtmlPlugin()],
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
