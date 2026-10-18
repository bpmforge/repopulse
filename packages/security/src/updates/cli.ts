import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildBundle, generateSigningKey } from './bundle.js';
import { fetchBundleText, installBundle, installFromFile, rollback, storeStatus } from './store.js';

// Rulepack bundle tool (W19-06). Run it wherever the scan data directory is:
//
//   cli.ts keygen  --out <dir>                         # publisher: make a signing key pair
//   cli.ts build   --src <rulepacks dir> --key <private.pem> --version YYYY.MM.DD.N --out bundle.json
//   cli.ts verify  --root <dir> --file bundle.json     # check without installing
//   cli.ts install --root <dir> (--file bundle.json | --url https://...)
//   cli.ts rollback --root <dir> [--to-shipped]
//   cli.ts status  --root <dir> [--max-age-days 45]
//
// <dir> is the bundle store (default for deploy: $SCAN_RULES_DIR/rulepack-bundle).
// The operator places the publisher's PUBLIC key in <dir>/trusted-keys/*.pem —
// nothing is trusted by default. Run `install` from your own cron, systemd timer
// or Kubernetes CronJob: the schedule is yours.

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const has = (argv: string[], name: string) => argv.includes(`--${name}`);
const need = (argv: string[], name: string): string => {
  const v = flag(argv, name);
  if (!v) {
    process.stderr.write(`missing --${name}\n`);
    process.exit(2);
  }
  return v;
};

function walk(dir: string, base = dir, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.set(path.relative(base, full).split(path.sep).join('/'), readFileSync(full, 'utf8'));
  }
  return out;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'keygen': {
      const out = need(rest, 'out');
      mkdirSync(out, { recursive: true, mode: 0o700 });
      const k = generateSigningKey();
      writeFileSync(path.join(out, `${k.keyId}.private.pem`), k.privateKeyPem, { mode: 0o600 });
      writeFileSync(path.join(out, `${k.keyId}.public.pem`), k.publicKeyPem);
      process.stdout.write(
        `key ${k.keyId}\nKeep ${k.keyId}.private.pem secret; distribute ${k.keyId}.public.pem.\n`,
      );
      return 0;
    }
    case 'build': {
      const files = walk(path.resolve(need(rest, 'src')));
      const bundle = buildBundle({
        files,
        version: need(rest, 'version'),
        createdAt: new Date().toISOString(),
        privateKeyPem: readFileSync(need(rest, 'key'), 'utf8'),
      });
      writeFileSync(need(rest, 'out'), `${JSON.stringify(bundle)}\n`);
      process.stdout.write(
        `built ${bundle.version}: ${bundle.files.length} files, key ${bundle.signature.keyId}\n`,
      );
      return 0;
    }
    case 'verify': {
      // Verification is install without the side effects: a throwaway root that
      // shares the real trusted keys.
      const root = need(rest, 'root');
      const { verifyBundle } = await import('./bundle.js');
      const { loadTrustedKeys } = await import('./store.js');
      const r = verifyBundle(readFileSync(need(rest, 'file'), 'utf8'), loadTrustedKeys(root));
      process.stdout.write(
        r.ok
          ? `OK: ${r.bundle.version}, ${r.bundle.files.length} files, key ${r.keyId}\n`
          : `REFUSED (${r.code}): ${r.reason}\n`,
      );
      return r.ok ? 0 : 1;
    }
    case 'install': {
      const root = need(rest, 'root');
      const url = flag(rest, 'url');
      let result;
      if (url) {
        const fetched = await fetchBundleText(url);
        if (!fetched.ok) {
          process.stderr.write(`FAILED: ${fetched.reason}\n`);
          return 1;
        }
        result = installBundle(
          root,
          fetched.text,
          has(rest, 'allow-downgrade') ? { allowDowngrade: true } : {},
        );
      } else {
        result = installFromFile(
          root,
          need(rest, 'file'),
          has(rest, 'allow-downgrade') ? { allowDowngrade: true } : {},
        );
      }
      process.stdout.write(
        result.ok
          ? `installed ${result.version} (was ${result.previous ?? 'the shipped rulepacks'})\n`
          : `REFUSED (${result.code}): ${result.reason}\n`,
      );
      return result.ok ? 0 : 1;
    }
    case 'rollback': {
      const r = rollback(need(rest, 'root'), has(rest, 'to-shipped') ? { toShipped: true } : {});
      process.stdout.write(
        r.ok ? `now using ${r.version ?? 'the shipped rulepacks'}\n` : `FAILED: ${r.reason}\n`,
      );
      return r.ok ? 0 : 1;
    }
    case 'status': {
      const s = storeStatus(
        need(rest, 'root'),
        flag(rest, 'max-age-days') ? { maxAgeDays: Number(flag(rest, 'max-age-days')) } : {},
      );
      process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
      if (s.stale) process.stderr.write(`WARNING: the installed bundle is ${s.ageDays} days old\n`);
      if (!s.consistent) process.stderr.write('WARNING: current and current.json disagree\n');
      return s.stale || !s.consistent ? 1 : 0;
    }
    default:
      process.stderr.write('usage: cli.ts keygen|build|verify|install|rollback|status ...\n');
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
