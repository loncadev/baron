import { describe, expect, it } from 'vitest';
import { createLinearCredentialProbe } from './index.js';

const apiKey = process.env.LINEAR_API_KEY;
const team = process.env.LINEAR_TEAM;
const live = Boolean(apiKey && team);

/**
 * Gated live check that the probe's discriminator matches the provider's real error shapes.
 *
 * The offline tests prove the classification given a message. They cannot prove Linear actually
 * words its errors that way, and the whole probe turns on that: if a real "not found" does not look
 * like one to the matcher, the probe reports `unknown` and a working key goes unverified. This is
 * the test that makes the design a measurement rather than a hypothesis.
 *
 * It writes nothing — the write check deliberately targets an id no issue can have.
 */
describe.skipIf(!live)('linear live credential probe', () => {
  it('confirms a full personal key can read and write, without writing anything', async () => {
    const findings = await createLinearCredentialProbe({
      apiKey: apiKey as string,
      team: team as string,
    }).probe(['issues:read', 'issues:write']);

    const byCapability = Object.fromEntries(findings.map((f) => [f.capability, f]));

    expect(byCapability['issues:read']?.status, byCapability['issues:read']?.detail).toBe(
      'granted',
    );
    // `unknown` here would mean the matcher does not recognise Linear's real not-found wording, and
    // the detail carries the message it actually returned — which is what to write the matcher from.
    expect(byCapability['issues:write']?.status, byCapability['issues:write']?.detail).toBe(
      'granted',
    );
  }, 60_000);
});
