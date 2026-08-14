import { describe, expect, test } from 'bun:test';
import {
  findSetupProvider,
  formatCommand,
  formatPlan,
  parseSetupOptions,
  setupProviders
} from './setup';

describe('setup provider registry', () => {
  test('keeps provider ids unique', () => {
    const ids = setupProviders.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('describes the supported Cloudflare artifact without calling it production', () => {
    const cloudflare = findSetupProvider('cloudflare');
    expect(cloudflare.supportedArtifact).toContain('browser-only sample');
    expect(cloudflare.deploy.argv).toContain('wrangler.demo.community.jsonc');
    expect(formatPlan(cloudflare)).not.toContain('production installation');
  });

  test('reports available providers for an unknown id', () => {
    expect(() => findSetupProvider('elsewhere')).toThrow('Available now: cloudflare');
  });
});

describe('setup options', () => {
  test('parses provider and plan mode', () => {
    expect(parseSetupOptions(['--provider', 'cloudflare', '--plan'])).toEqual({
      providerId: 'cloudflare',
      planOnly: true,
      help: false
    });
  });

  test('rejects an option the CLI does not know', () => {
    expect(() => parseSetupOptions(['--surprise'])).toThrow('Unknown option');
  });
});

test('command formatting quotes only arguments that need it', () => {
  expect(formatCommand(['bun', 'run', 'a command'])).toBe('bun run "a command"');
});
