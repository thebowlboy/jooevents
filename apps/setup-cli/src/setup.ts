export type SetupCommand = Readonly<{
  label: string;
  argv: readonly string[];
}>;

export type SetupProvider = Readonly<{
  id: string;
  label: string;
  summary: string;
  supportedArtifact: string;
  preflight: readonly SetupCommand[];
  authCheck: SetupCommand;
  authenticate: SetupCommand;
  deploy: SetupCommand;
  afterDeploy: readonly string[];
}>;

export type SetupOptions = Readonly<{
  providerId: string | undefined;
  planOnly: boolean;
  help: boolean;
}>;

const command = (label: string, ...argv: string[]): SetupCommand => ({ label, argv });

export const setupProviders: readonly SetupProvider[] = [
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    summary: 'Deploy the browser-only sample to a public workers.dev address.',
    supportedArtifact: 'browser-only sample; synthetic data; no shared persistence',
    preflight: [
      command('Install the pinned dependencies', 'bun', 'install', '--frozen-lockfile'),
      command('Type-check the demo Worker', 'bun', 'run', '--cwd', 'apps/demo-worker', 'check'),
      command('Test the demo Worker', 'bun', 'test', 'apps/demo-worker'),
      command('Build and inspect the browser sample', 'bun', 'run', 'demo:build:cloudflare'),
      command(
        'Compile the Cloudflare deployment without publishing it',
        'bunx',
        'wrangler',
        'deploy',
        '--config',
        'wrangler.demo.community.jsonc',
        '--dry-run'
      )
    ],
    authCheck: command('Check the active Cloudflare account', 'bunx', 'wrangler', 'whoami'),
    authenticate: command('Open Cloudflare login in the browser', 'bunx', 'wrangler', 'login'),
    deploy: command(
      'Deploy the browser sample',
      'bunx',
      'wrangler',
      'deploy',
      '--config',
      'wrangler.demo.community.jsonc'
    ),
    afterDeploy: [
      'Wrangler prints the public HTTPS address when deployment finishes.',
      'Use only synthetic data. Reloads reset most changes, and browsers do not share state.',
      'If the sample should be private, put the Worker behind a Cloudflare Access policy before sharing it.'
    ]
  }
];

export function parseSetupOptions(argv: readonly string[]): SetupOptions {
  let providerId: string | undefined;
  let planOnly = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') {
      planOnly = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--provider') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--provider needs a provider id.');
      }
      providerId = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { providerId, planOnly, help };
}

export function findSetupProvider(
  providerId: string,
  providers: readonly SetupProvider[] = setupProviders
): SetupProvider {
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) {
    const available = providers.map((candidate) => candidate.id).join(', ');
    throw new Error(`Unknown provider: ${providerId}. Available now: ${available}.`);
  }
  return provider;
}

export function formatCommand(argv: readonly string[]): string {
  return argv.map((part) => (/^[A-Za-z0-9_./:@=-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

export function formatPlan(provider: SetupProvider): string {
  const lines = [
    `${provider.label}: ${provider.summary}`,
    `Supported today: ${provider.supportedArtifact}`,
    '',
    'Preflight'
  ];

  provider.preflight.forEach((step, index) => {
    lines.push(`  ${index + 1}. ${step.label}`);
    lines.push(`     ${formatCommand(step.argv)}`);
  });

  lines.push('', 'Account');
  lines.push(`  ${provider.authCheck.label}`);
  lines.push(`  ${formatCommand(provider.authCheck.argv)}`);
  lines.push(`  If needed: ${formatCommand(provider.authenticate.argv)}`);
  lines.push('', 'Deploy');
  lines.push(`  ${formatCommand(provider.deploy.argv)}`);

  return lines.join('\n');
}
