import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Architecture rulepack loader (W10-03, FR-REG-5).
//
// FAIL-CLOSED, like the secrets pack: a pack that will not parse throws rather
// than falling back to defaults baked into the code. Silent defaults mean the
// thresholds a reader sees in the asset are not the thresholds that ran.

export interface CycleRule {
  id: 'architecture.cycle';
  description: string;
  severity: number;
  escalateAtSize: number;
  escalatedSeverity: number;
}

export interface GodModuleRule {
  id: 'architecture.god_module';
  description: string;
  severity: number;
  percentile: number;
  multiple: number;
  minModules: number;
  minDegree: number;
}

export interface OrphanRule {
  id: 'architecture.orphan_cluster';
  description: string;
  severity: number;
  minClusterSize: number;
}

export interface ArchitecturePack {
  version: number;
  cycle: CycleRule;
  godModule: GodModuleRule;
  orphan: OrphanRule;
}

export class ArchitecturePackError extends Error {}

const PACK_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../rulepacks/architecture/architecture.v1.yaml',
);

/**
 * Reads the pack.
 *
 * A hand-rolled reader for the subset this file uses — the same choice the
 * secrets pack made, and for the same reason: a YAML library would accept
 * anchors, aliases and merge keys, which are features a rulepack has no use
 * for and an attacker with commit access does.
 */
function scalars(lines: string[], start: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\s{0,3}-\s/.test(line) || /^\S/.test(line)) break;
    const match = /^\s+([a-z_]+):\s*(.+?)\s*$/.exec(line);
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

function number(fields: Record<string, string>, key: string, ruleId: string): number {
  const value = Number(fields[key]);
  if (!Number.isFinite(value)) {
    throw new ArchitecturePackError(`${ruleId}: ${key} is missing or not a number`);
  }
  return value;
}

export function loadArchitecturePack(packPath: string = PACK_PATH): ArchitecturePack {
  let text: string;
  try {
    text = readFileSync(packPath, 'utf8');
  } catch (error) {
    throw new ArchitecturePackError(`cannot read ${packPath}: ${String(error)}`);
  }

  const lines = text.split('\n');
  const versionLine = lines.find((l) => /^version:\s*\d+/.test(l));
  if (!versionLine) throw new ArchitecturePackError('pack has no version');

  const byId = new Map<string, Record<string, string>>();
  lines.forEach((line, index) => {
    const match = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line);
    if (match) byId.set(match[1]!, scalars(lines, index + 1));
  });

  const need = (id: string): Record<string, string> => {
    const fields = byId.get(id);
    if (!fields) throw new ArchitecturePackError(`pack is missing rule ${id}`);
    return fields;
  };

  const cycle = need('architecture.cycle');
  const god = need('architecture.god_module');
  const orphan = need('architecture.orphan_cluster');

  return {
    version: Number(/\d+/.exec(versionLine)![0]),
    cycle: {
      id: 'architecture.cycle',
      description: cycle['description'] ?? '',
      severity: number(cycle, 'severity', 'architecture.cycle'),
      escalateAtSize: number(cycle, 'escalate_at_size', 'architecture.cycle'),
      escalatedSeverity: number(cycle, 'escalated_severity', 'architecture.cycle'),
    },
    godModule: {
      id: 'architecture.god_module',
      description: god['description'] ?? '',
      severity: number(god, 'severity', 'architecture.god_module'),
      percentile: number(god, 'percentile', 'architecture.god_module'),
      multiple: number(god, 'multiple', 'architecture.god_module'),
      minModules: number(god, 'min_modules', 'architecture.god_module'),
      minDegree: number(god, 'min_degree', 'architecture.god_module'),
    },
    orphan: {
      id: 'architecture.orphan_cluster',
      description: orphan['description'] ?? '',
      severity: number(orphan, 'severity', 'architecture.orphan_cluster'),
      minClusterSize: number(orphan, 'min_cluster_size', 'architecture.orphan_cluster'),
    },
  };
}
