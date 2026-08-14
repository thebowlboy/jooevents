import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  findSetupProvider,
  formatCommand,
  formatPlan,
  parseSetupOptions,
  setupProviders,
  type SetupCommand,
  type SetupProvider
} from './setup';

const heading = 'JooEvents demo setup';

function printHelp(): void {
  console.log(`${heading}

Usage:
  bun run demo:setup
  bun run demo:setup -- --provider cloudflare
  bun run demo:setup -- --provider cloudflare --plan

The guided path deploys the browser-only sample. A production installation is not
available yet. --plan prints every command without running it.`);
}

async function chooseProvider(): Promise<SetupProvider> {
  if (setupProviders.length === 1) return setupProviders[0]!;

  const prompts = createInterface({ input: stdin, output: stdout });
  console.log('Where should the sample run?');
  setupProviders.forEach((provider, index) => {
    console.log(`  ${index + 1}. ${provider.label} — ${provider.summary}`);
  });
  const answer = await prompts.question('Provider: ');
  prompts.close();
  const selected = Number.parseInt(answer, 10) - 1;
  const provider = setupProviders[selected];
  if (!provider) throw new Error('Choose one of the listed providers.');
  return provider;
}

async function confirm(question: string): Promise<boolean> {
  const prompts = createInterface({ input: stdin, output: stdout });
  const answer = (await prompts.question(`${question} [y/N] `)).trim().toLowerCase();
  prompts.close();
  return answer === 'y' || answer === 'yes';
}

async function runCommand(step: SetupCommand): Promise<boolean> {
  console.log(`\n${step.label}`);
  console.log(`  ${formatCommand(step.argv)}`);
  const child = Bun.spawn([...step.argv], {
    cwd: process.cwd(),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  return (await child.exited) === 0;
}

async function run(): Promise<void> {
  let options;
  try {
    options = parseSetupOptions(Bun.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    printHelp();
    return;
  }

  console.log(`\n${heading}\n`);
  console.log('This currently prepares the browser-only sample, not a production installation.');
  console.log('Cloudflare is first, not forever. Provider-specific work stays behind one setup contract.');
  console.log('The CLI never asks for a token or password. Wrangler owns its browser login.\n');

  const provider = options.providerId
    ? findSetupProvider(options.providerId)
    : await chooseProvider();

  if (options.planOnly) {
    console.log(formatPlan(provider));
    return;
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    console.error('Guided setup needs an interactive terminal. Use --plan to inspect the commands.');
    process.exitCode = 2;
    return;
  }

  console.log(`${provider.label}: ${provider.summary}`);
  console.log(`Supported today: ${provider.supportedArtifact}\n`);

  if (!(await confirm('Run the local preflight checks?'))) {
    console.log('Nothing changed. Run again whenever you are ready.');
    return;
  }

  for (const step of provider.preflight) {
    if (!(await runCommand(step))) {
      throw new Error(`Stopped at: ${step.label}. Fix that checkpoint, then run demo setup again.`);
    }
  }

  if (!(await runCommand(provider.authCheck))) {
    console.log('\nWrangler is not authenticated in this terminal.');
    if (!(await confirm('Open Cloudflare login now?'))) {
      console.log(`Run ${formatCommand(provider.authenticate.argv)} when you are ready, then start demo setup again.`);
      return;
    }
    if (!(await runCommand(provider.authenticate)) || !(await runCommand(provider.authCheck))) {
      throw new Error('Cloudflare login could not be verified. No deployment was attempted.');
    }
  }

  console.log('\nPreflight passed and the Cloudflare account is visible.');
  console.log('The next command creates or updates a public Worker. It still contains synthetic data only.');
  if (!(await confirm('Deploy the sample?'))) {
    console.log(`Nothing was deployed. To finish later: ${formatCommand(provider.deploy.argv)}`);
    return;
  }

  if (!(await runCommand(provider.deploy))) {
    throw new Error('Wrangler did not complete the deployment.');
  }

  console.log('\nDone.');
  for (const line of provider.afterDeploy) console.log(`- ${line}`);
}

run().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
