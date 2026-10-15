import {
  basenameMatches,
  extractJson,
  hasExtension,
  relativeTo,
  type AdapterContext,
  type AdapterFinding,
  type ToolAdapter,
} from './types.js';

// checkov adapter (W18-26, Apache-2.0; Python, its dependency set pinned by
// hash in packages/security/sandbox/checkov-requirements.txt). Verified against
// checkov 3.3.29 by running it on fixtures/adapters/checkov with no network
// namespace (`unshare -n`) and a read-only HOME; fixtures/adapters/recorded
// holds that output.
//
// FRAMEWORKS, chosen rather than defaulted. checkov's default is every runner
// it has, which here would mean:
//   - `secrets` re-reporting what the in-house secrets scanner already owns;
//   - `github_actions` re-reporting what actionlint reads more precisely;
//   - `helm` and `kustomize`, which shell out to helm/kustomize binaries this
//     image does not carry — they would skip silently, and a framework that
//     never runs must not be listed as one that does (Helm charts are NOT
//     scanned: rendering them needs the helm binary and, for charts with
//     dependencies, the network);
//   - `sca_*`, which need the Prisma Cloud API.
// So: Terraform, CloudFormation, Kubernetes manifests, and Dockerfiles — the
// last overlapping hadolint, resolved per check by TOOL_DEDUP_MAP rather than
// by dropping one side wholesale (checkov knows port 22 and USER-less images;
// hadolint knows the rest of the Dockerfile better).
const FRAMEWORKS = ['terraform', 'cloudformation', 'kubernetes', 'dockerfile'];

/**
 * The checks that run, and what each is worth.
 *
 * An ALLOWLIST, passed to checkov as --check. Unfiltered, checkov reports ~20
 * findings for a ten-line Kubernetes Deployment — readiness probes, CPU limits,
 * digest pinning, NetworkPolicy — and 13 for a two-resource Terraform file,
 * most of them "enable Multi-AZ" and "enable performance insights". Those are
 * operational preferences; a findings list made of them is skipped, and the
 * public database in the middle of it is skipped with them. What is kept is
 * exposure, privilege, credentials and encryption: the class where a single
 * finding is worth someone's afternoon.
 *
 * Severity is ours, not checkov's: with --skip-download (no Prisma Cloud call)
 * checkov reports `severity: null` for every check.
 */
export const CHECKOV_CHECKS: Record<string, number> = {
  // AWS — open to the internet.
  CKV_AWS_24: 4, // SG: 0.0.0.0/0 to port 22
  CKV_AWS_25: 4, // SG: 0.0.0.0/0 to port 3389
  CKV_AWS_277: 4, // SG: 0.0.0.0/0 to all ports
  CKV_AWS_260: 2, // SG: 0.0.0.0/0 to port 80 — often intended, so lower
  CKV_AWS_17: 4, // RDS publicly accessible
  CKV_AWS_20: 4, // S3 ACL public READ
  CKV_AWS_57: 4, // S3 ACL public WRITE
  CKV_AWS_88: 2, // EC2 with public IP
  // AWS — privilege.
  CKV_AWS_1: 4, // IAM policy "*:*"
  CKV_AWS_62: 4, // IAM policy "*:*"
  CKV_AWS_63: 3, // IAM policy action "*"
  CKV_AWS_33: 4, // KMS key policy wildcard principal
  CKV_AWS_107: 3, // IAM credentials exposure
  CKV_AWS_287: 3, // IAM credentials exposure
  CKV_AWS_110: 4, // IAM privilege escalation
  CKV_AWS_286: 4, // IAM privilege escalation
  // AWS — credentials in code.
  CKV_AWS_41: 4, // hard-coded access key in provider
  CKV_AWS_45: 4, // secrets in Lambda environment
  CKV_AWS_46: 4, // secrets in EC2 user data
  // AWS — encryption and transport. S3 default encryption (CKV_AWS_19) is
  // deliberately absent: S3 has encrypted new objects by default since 2023,
  // so the check fires on correct, modern buckets.
  CKV_AWS_16: 3, // RDS not encrypted at rest
  CKV_AWS_3: 2, // EBS not encrypted
  CKV_AWS_8: 2, // launch config / instance EBS not encrypted
  CKV_AWS_2: 3, // ALB listener not HTTPS
  CKV_AWS_103: 3, // LB listener below TLS 1.2
  // Azure.
  CKV_AZURE_9: 4, // RDP open to the internet
  CKV_AZURE_10: 4, // SSH open to the internet
  CKV_AZURE_160: 2, // HTTP open to the internet
  CKV_AZURE_77: 3, // UDP open to the internet
  CKV_AZURE_11: 4, // SQL firewall 0.0.0.0/0
  CKV_AZURE_59: 4, // storage account public access
  CKV_AZURE_190: 4, // storage blob public access
  CKV_AZURE_3: 3, // storage without HTTPS-only
  // GCP.
  CKV_GCP_2: 4, // firewall: SSH from anywhere
  CKV_GCP_3: 4, // firewall: RDP from anywhere
  CKV_GCP_88: 4, // firewall: MySQL from anywhere
  CKV_GCP_106: 2, // firewall: HTTP from anywhere
  CKV_GCP_28: 4, // bucket public
  CKV_GCP_114: 3, // bucket without public-access prevention
  CKV_GCP_60: 3, // Cloud SQL public IP
  CKV_GCP_6: 3, // Cloud SQL without SSL
  CKV_GCP_42: 4, // service account with admin role
  // Kubernetes — container escapes.
  CKV_K8S_16: 4, // privileged container
  CKV_K8S_17: 4, // host PID
  CKV_K8S_18: 4, // host IPC
  CKV_K8S_19: 4, // host network
  CKV_K8S_27: 4, // docker socket mounted
  CKV_K8S_39: 4, // CAP_SYS_ADMIN
  CKV_K8S_20: 3, // allowPrivilegeEscalation
  // Kubernetes — RBAC escalation.
  CKV_K8S_49: 3, // wildcard in Role/ClusterRole
  CKV_K8S_155: 3, // control over admission webhooks
  CKV_K8S_156: 3, // approve CSRs
  CKV_K8S_157: 3, // bind roles
  CKV_K8S_158: 3, // escalate roles
  CKV_K8S_14: 2, // image tag latest/blank
  // Dockerfile. Several overlap hadolint; TOOL_DEDUP_MAP decides which wins.
  // CKV_DOCKER_4 ("COPY instead of ADD") is absent: it fires on `ADD x.tar.gz`,
  // which is the documented reason ADD exists (it extracts). hadolint's DL3020
  // knows the difference — measured on the fixture, where checkov flagged the
  // archive and hadolint correctly did not.
  CKV_DOCKER_1: 2, // EXPOSE 22
  CKV_DOCKER_3: 2, // no USER at all
  CKV_DOCKER_7: 2, // FROM :latest               (hadolint DL3007)
  CKV_DOCKER_8: 3, // last USER is root          (hadolint DL3002)
  CKV_DOCKER_10: 2, // relative WORKDIR          (hadolint DL3000)
  CKV_DOCKER_11: 2, // duplicate FROM alias      (hadolint DL3024)
};

/** Directory names that, in practice, hold Kubernetes or CloudFormation YAML. */
const IAC_DIR_SEGMENTS = new Set([
  'k8s',
  'kube',
  'kubernetes',
  'manifests',
  'deploy',
  'deployment',
  'deployments',
  'cloudformation',
  'cfn',
  'infra',
  'infrastructure',
  'iac',
]);

const DOCKERFILE_PATTERNS = ['Dockerfile', 'Dockerfile.*', '*.Dockerfile', '*.dockerfile'];

/**
 * Should checkov start at all?
 *
 * It costs ~4 s of Python start-up before it reads a file, so it is not run on
 * every repository that happens to contain YAML (nearly all of them). Terraform
 * and Dockerfiles are recognisable by name; Kubernetes and CloudFormation are
 * not — they are YAML or JSON whose identity is in the content — so a
 * conventional directory or file name is the routing signal. A manifest in
 * an unconventional place is still scanned whenever anything else starts
 * checkov, because it scans the whole tree; it is only a repository whose ONLY
 * IaC is unconventionally placed that this misses.
 */
function looksLikeIac(file: string): boolean {
  if (file.endsWith('.tf') || file.endsWith('.tf.json')) return true;
  if (basenameMatches(file, DOCKERFILE_PATTERNS)) return true;
  if (!/\.(ya?ml|json|template)$/.test(file)) return false;
  const segments = file.split('/');
  const base = segments.pop() ?? '';
  if (segments.some((segment) => IAC_DIR_SEGMENTS.has(segment.toLowerCase()))) return true;
  // AWS SAM / CloudFormation conventions.
  return (
    /^(template|.*\.cfn|.*\.k8s|.*-stack)\.(ya?ml|json)$/i.test(base) || base.endsWith('.template')
  );
}

interface CheckovFailed {
  check_id?: unknown;
  check_name?: unknown;
  file_abs_path?: unknown;
  file_path?: unknown;
  file_line_range?: unknown;
  resource?: unknown;
}

/** checkov prints one report object, a list of them, or a bare summary. */
function reports(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [parsed];
}

export const checkovAdapter: ToolAdapter = {
  key: 'checkov',
  version: '3.3.29',
  license: 'Apache-2.0',
  shadow: true,

  detect(ctx: AdapterContext): boolean {
    return hasExtension(ctx.files, ['.tf', '.tf.json']) || ctx.files.some(looksLikeIac);
  },

  command(ctx: AdapterContext): string[] {
    return [
      // checkov reads `.checkov.yaml` from the working directory (the
      // snapshot, in the sandbox) AND from the `-d` directory — but it finds
      // the latter by looking for a bare `-d`/`--directory` token in argv, so
      // `--directory=PATH` slips past it. Both are closed here: `cd /` for the
      // first, the `=` form for the second. Measured: a fixture repo's
      // `skip-check:` was honoured before, ignored after. A repository's config
      // must not decide what our scanner reports.
      'sh',
      '-c',
      'cd / && exec "$@"',
      'sh',
      'checkov',
      `--directory=${ctx.mountPath}`,
      '--framework',
      ...FRAMEWORKS,
      '--check',
      Object.keys(CHECKOV_CHECKS).join(','),
      '--output',
      'json',
      '--quiet',
      '--compact',
      // No call to the Prisma Cloud platform for guidelines or severities.
      // Without it checkov still makes no network request when no API key is
      // set — verified under `unshare -n` — and the sandbox has no network
      // anyway; this keeps it from trying.
      '--skip-download',
    ];
  },

  parse(stdout: string, ctx: AdapterContext): AdapterFinding[] {
    const json = extractJson(stdout);
    if (!json) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return [];
    }

    const out: AdapterFinding[] = [];
    for (const report of reports(parsed)) {
      if (!report || typeof report !== 'object') continue;
      const results = (report as { results?: { failed_checks?: unknown } }).results;
      const failed = results?.failed_checks;
      if (!Array.isArray(failed)) continue;
      for (const raw of failed as CheckovFailed[]) {
        const id = typeof raw?.check_id === 'string' ? raw.check_id : '';
        // The allowlist is enforced here too: --check is the cost control,
        // this is the guarantee — a checkov upgrade that changed how --check
        // matches must not widen what we report.
        const severity = CHECKOV_CHECKS[id];
        if (severity === undefined) continue;
        const name = typeof raw.check_name === 'string' ? raw.check_name : id;
        const resource = typeof raw.resource === 'string' ? raw.resource : '';
        const range = Array.isArray(raw.file_line_range) ? raw.file_line_range : [];
        const start = typeof range[0] === 'number' && range[0] > 0 ? range[0] : 1;
        const end = typeof range[1] === 'number' && range[1] >= start ? range[1] : start;
        const file =
          typeof raw.file_abs_path === 'string'
            ? relativeTo(ctx.mountPath, raw.file_abs_path)
            : typeof raw.file_path === 'string'
              ? raw.file_path.replace(/^\//, '')
              : '';
        const message = resource ? `${name} (${resource})` : name;
        out.push({
          ruleId: `tool.checkov.${id}`,
          file,
          lineStart: start,
          lineEnd: end,
          severity,
          title: `${id}: ${name}`.slice(0, 120),
          message,
          dimension: 'iac',
          nativeRule: id,
        });
      }
    }
    return out;
  },
};
