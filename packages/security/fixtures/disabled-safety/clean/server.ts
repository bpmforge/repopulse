import tls from 'node:tls';
import Fastify from 'fastify';
import cors from '@fastify/cors';

const ca = process.env.DB_CA;
export const socket = tls.connect({ host: 'db.internal', port: 5432, ca });

const app = Fastify();
await app.register(cors, { origin: ['https://app.example.com'], credentials: true });
export default app;
