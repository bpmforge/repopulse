import { describe, expect, it } from 'vitest';
import type { T2Host } from '../t2/client.js';
import {
  chooseVerifierHost,
  excerptAround,
  FINDER_UNKNOWN,
  findingVerdict,
  NO_INDEPENDENT_HOST,
  OFF_NETWORK_NOT_ALLOWED,
  parseVerifyAnswer,
  verifyDimension,
} from './second-model.js';

// W21-03: the pieces every production verify caller shares.

const lan = (providerId: number, ip: string): T2Host => ({
  baseUrl: `http://${ip}:1234/v1`,
  modelSlot: `model-${providerId}`,
  name: `lan-${providerId}`,
  providerId,
});
const hosted = (providerId: number): T2Host => ({
  baseUrl: `https://api.example-hosted.com/v1`,
  modelSlot: `hosted-${providerId}`,
  name: `hosted-${providerId}`,
  providerId,
});

describe('chooseVerifierHost', () => {
  it('never picks the finder, nor another connection on the finder host', () => {
    const sameBox = { ...lan(2, '10.0.0.5'), name: 'same box, other model' };
    const hosts = [lan(1, '10.0.0.5'), { ...sameBox, baseUrl: lan(1, '10.0.0.5').baseUrl }];
    expect(
      chooseVerifierHost(hosts, { providerId: 1, model: 'model-1' }, { offNetworkAllowed: true }),
    ).toEqual({ refused: NO_INDEPENDENT_HOST });
  });

  it('prefers a local connection over a hosted one', () => {
    const hosts = [lan(1, '10.0.0.5'), hosted(3), lan(2, '10.0.0.6')];
    const got = chooseVerifierHost(
      hosts,
      { providerId: 1, model: 'm' },
      { offNetworkAllowed: true },
    );
    expect('host' in got && got.host.providerId).toBe(2);
  });

  it('uses an off-network connection only when the caller allows it (Tier 3 opted in, local-only off)', () => {
    const hosts = [lan(1, '10.0.0.5'), hosted(3)];
    expect(
      chooseVerifierHost(hosts, { providerId: 1, model: 'm' }, { offNetworkAllowed: false }),
    ).toEqual({ refused: OFF_NETWORK_NOT_ALLOWED });
    const got = chooseVerifierHost(
      hosts,
      { providerId: 1, model: 'm' },
      { offNetworkAllowed: true },
    );
    expect('host' in got && got.host.providerId).toBe(3);
  });

  it('refuses when who raised it is not known', () => {
    const hosts = [lan(1, '10.0.0.5'), lan(2, '10.0.0.6')];
    expect(
      chooseVerifierHost(hosts, { providerId: null, model: 'm' }, { offNetworkAllowed: true }),
    ).toEqual({ refused: FINDER_UNKNOWN });
  });

  it('for a tool-raised finding any eligible configured connection will do', () => {
    const envHost: T2Host = { baseUrl: 'http://10.0.0.9:1234/v1', modelSlot: 'x' };
    const got = chooseVerifierHost([envHost, lan(4, '10.0.0.7')], null, {
      offNetworkAllowed: false,
    });
    // The unpinnable environment host is skipped.
    expect('host' in got && got.host.providerId).toBe(4);
  });

  it("follows the caller's own off-network rule when it gives one", () => {
    const hosts = [lan(1, '10.0.0.5'), lan(2, '10.0.0.6')];
    expect(
      chooseVerifierHost(
        hosts,
        { providerId: 1, model: 'm' },
        { offNetworkAllowed: false, leavesNetwork: () => true },
      ),
    ).toEqual({ refused: OFF_NETWORK_NOT_ALLOWED });
  });
});

describe('parseVerifyAnswer', () => {
  it('reads plain and fenced JSON', () => {
    expect(parseVerifyAnswer('{"refuted":true,"reason":"safe here"}')).toEqual({
      refuted: true,
      reason: 'safe here',
    });
    expect(parseVerifyAnswer('```json\n{"refuted":false,"reason":"holds"}\n```')).toEqual({
      refuted: false,
      reason: 'holds',
    });
  });
  it('anything else is unreadable, never a confirmation', () => {
    expect(parseVerifyAnswer('looks right to me')).toBeNull();
    expect(parseVerifyAnswer('{"refuted":"no"}')).toBeNull();
    expect(parseVerifyAnswer('[]')).toBeNull();
  });
});

describe('findingVerdict', () => {
  it('a refutation marks contradicted, with the verifier recorded', () => {
    expect(
      findingVerdict({
        refuted: true,
        reason: 'wrapped by middleware',
        verifier: { model: 'b', providerId: 2, connection: 'Box B' },
      }),
    ).toEqual({
      status: 'contradicted',
      model: 'b',
      providerId: 2,
      connection: 'Box B',
      reason: 'wrapped by middleware',
    });
  });
  it('a refusal stays unverified, with why', () => {
    expect(findingVerdict({ unverified: true, reason: 'AI is off' })).toEqual({
      status: 'unverified',
      model: null,
      providerId: null,
      connection: null,
      reason: 'AI is off',
    });
  });
});

describe('verifyDimension and excerptAround', () => {
  it('maps finding dimensions onto gateway dimensions', () => {
    expect(verifyDimension('slop')).toBe('ai_slop');
    expect(verifyDimension('dependency')).toBe('security');
    expect(verifyDimension('logging')).toBe('code_health');
  });
  it('cuts a window around the quoted line', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
    const cut = excerptAround(text, { quote: 'line 50' }, 2).split('\n');
    expect(cut).toEqual(['line 48', 'line 49', 'line 50', 'line 51', 'line 52']);
    expect(excerptAround(text, { line: 1 }, 1).split('\n')).toEqual(['line 1', 'line 2']);
  });
});
