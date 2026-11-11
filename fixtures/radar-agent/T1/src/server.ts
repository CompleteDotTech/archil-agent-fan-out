import { serve } from '@hono/node-server';
import { createApp } from './app.js';
serve({ fetch: createApp().fetch, port: 3000 });
console.log('Radar: http://localhost:3000');
