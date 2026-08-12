export const OPERATION_SURFACES = [
  'operator_http',
  'participant_http',
  'public_http',
  'external_mcp',
  'app_model',
  'application_job',
  'provider_ingress'
] as const;

export type OperationSurface = (typeof OPERATION_SURFACES)[number];

const operationSurfaceSet: ReadonlySet<string> = new Set(OPERATION_SURFACES);

export function isOperationSurface(value: unknown): value is OperationSurface {
  return typeof value === 'string' && operationSurfaceSet.has(value);
}

export function parseOperationSurface(value: unknown): OperationSurface {
  if (!isOperationSurface(value)) throw new TypeError('unknown operation surface');
  return value;
}
