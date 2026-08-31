import { FAKE_TOKEN, startFakeForge } from '@repopulse/shared';

// The fake forge, as a long-running service (W16-60).
//
// The demo stack is the REAL product images with one thing swapped: the forge
// they call. Everything else — the api, the worker, the migrations, the web
// bundle — is byte-for-byte what a customer would run, which is the only way a
// demo is worth anything as evidence that the product works.
//
// WHY THIS IS A SERVICE AND NOT A FLAG. The alternative was an env-guarded
// `if (demo) startFakeForge()` inside the production entrypoints, which puts
// test fixtures on the path of every real install and asks a reader to trust a
// branch. A separate process cannot be reached by accident: production simply
// never runs this file.
//
// WHY api AND worker SHARE ITS NETWORK NAMESPACE. SC-12 allows an http:// forge
// URL only for an exact loopback host — `localhost`, `::1` or 127.* — and the
// fake forge binds 127.0.0.1. A container hostname like `http://forge:3309`
// would be refused by the same guard that stops an attacker pointing the
// product at an internal address, and relaxing that guard to make a demo
// convenient would be trading a real security control for a fixture. Sharing
// the namespace means api and worker reach it at 127.0.0.1, exactly as the
// guard requires, with no code changed and nothing weakened.

const port = Number(process.env.DEMO_FORGE_PORT ?? 3309);
const forge = await startFakeForge(port);

// stdout, not a logger: this process has no request context and its only job is
// to say where it is listening, so `compose logs forge` answers the one
// question anyone asks of it.
process.stdout.write(`[demo-forge] serving fixture repositories on ${forge.baseUrl}\n`);
// The credential the connect flow must be given. Printed rather than left to be
// looked up, because "all of it is done in the UI" is only true if the one
// value you have to paste is somewhere you can find it.
process.stdout.write(`[demo-forge] the token it accepts is: ${FAKE_TOKEN}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void forge.close().then(() => process.exit(0));
  });
}
