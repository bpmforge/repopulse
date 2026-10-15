import tls from 'node:tls';
import Fastify from 'fastify';
import cors from '@fastify/cors';

export const socket = tls.connect({ host: 'db.internal', port: 5432, rejectUnauthorized: false });

const app = Fastify();
await app.register(cors, { origin: true, credentials: true });
export default app;
