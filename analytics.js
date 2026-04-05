// Vercel Web Analytics initialization
// This script injects Vercel Analytics tracking for web deployment
import { inject } from '@vercel/analytics';

// Only initialize analytics if not running in Electron
if (typeof window !== 'undefined' && !window.studioBridge?.isElectron) {
    inject();
    console.log('[Analytics] Vercel Web Analytics initialized');
} else {
    console.log('[Analytics] Skipping - running in Electron');
}
