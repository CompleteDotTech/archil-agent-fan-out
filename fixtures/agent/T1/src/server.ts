import { serve } from '@hono/node-server';
import { createApp } from './app.js';

// Fixed local demo port; importing app.ts never starts a listener.
serve({ fetch: createApp().fetch, port: 3000 });
