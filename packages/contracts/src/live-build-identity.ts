import { z } from 'zod';

export const LIVE_BUILD_IDENTITY_FILENAME = '.jooevents-live-build.json';
export const LIVE_BUILD_IDENTITY_SCOPE = 'application_dependency_closure' as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const liveBuildIdentityFileSchema = z.strictObject({
  path: z.string().min(1).max(512).refine((value) => {
    if (value.startsWith('/') || value.includes('\\') || value.includes('\0')) return false;
    const segments = value.split('/');
    return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
  }, 'Build file paths must be normalized relative POSIX paths.'),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: sha256Schema
});

const liveBuildIdentityBodyShape = {
  formatVersion: z.literal(1),
  kind: z.literal('live'),
  scope: z.literal(LIVE_BUILD_IDENTITY_SCOPE),
  files: z.array(liveBuildIdentityFileSchema).min(1).max(4096)
} as const;

function strictlySortedFiles(
  value: { readonly files: readonly { readonly path: string }[] },
  context: z.RefinementCtx
): void {
  for (let index = 1; index < value.files.length; index += 1) {
    const previous = value.files[index - 1];
    const current = value.files[index];
    if (!previous || !current || previous.path >= current.path) {
      context.addIssue({
        code: 'custom',
        path: ['files', index, 'path'],
        message: 'Build identity files must be unique and sorted by path.'
      });
    }
  }
}

export const liveBuildIdentityBodySchema = z
  .strictObject(liveBuildIdentityBodyShape)
  .superRefine(strictlySortedFiles);

export const liveBuildIdentitySchema = z
  .strictObject({
    ...liveBuildIdentityBodyShape,
    digestSha256: sha256Schema
  })
  .superRefine(strictlySortedFiles);

type ParsedLiveBuildIdentityFile = z.infer<typeof liveBuildIdentityFileSchema>;
type ParsedLiveBuildIdentityBody = z.infer<typeof liveBuildIdentityBodySchema>;
type ParsedLiveBuildIdentity = z.infer<typeof liveBuildIdentitySchema>;

export type LiveBuildIdentityFile = Readonly<ParsedLiveBuildIdentityFile>;
export type LiveBuildIdentityBody = Readonly<
  Omit<ParsedLiveBuildIdentityBody, 'files'> & {
    readonly files: readonly LiveBuildIdentityFile[];
  }
>;
export type LiveBuildIdentity = Readonly<
  Omit<ParsedLiveBuildIdentity, 'files'> & {
    readonly files: readonly LiveBuildIdentityFile[];
  }
>;

/** Stable digest input shared by the build producer and runtime verifier. */
export function liveBuildIdentityDigestPayload(value: LiveBuildIdentityBody): string {
  const parsed = liveBuildIdentityBodySchema.parse({
    formatVersion: value.formatVersion,
    kind: value.kind,
    scope: value.scope,
    files: value.files
  });
  return JSON.stringify({
    formatVersion: parsed.formatVersion,
    kind: parsed.kind,
    scope: parsed.scope,
    files: parsed.files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256
    }))
  });
}
