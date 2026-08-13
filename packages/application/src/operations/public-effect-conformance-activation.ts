declare const publicEffectConformanceActivationBrand: unique symbol;

/** Internal capability issued only through the isolated conformance API. */
export interface PublicEffectConformanceActivation {
  readonly [publicEffectConformanceActivationBrand]: true;
}

const issuedActivations = new WeakSet<object>();
const activatedBuilders = new WeakMap<object, PublicEffectConformanceActivation>();

export function issuePublicEffectConformanceActivation(): PublicEffectConformanceActivation {
  const activation = Object.freeze({}) as PublicEffectConformanceActivation;
  issuedActivations.add(activation);
  return activation;
}

export function isPublicEffectConformanceActivation(
  value: unknown
): value is PublicEffectConformanceActivation {
  return typeof value === 'object' && value !== null && issuedActivations.has(value);
}

export function bindPublicEffectConformanceBuilder(
  builder: object,
  activation: PublicEffectConformanceActivation
): void {
  if (!isPublicEffectConformanceActivation(activation)) {
    throw new TypeError('Untrusted public effect conformance activation.');
  }
  activatedBuilders.set(builder, activation);
}

export function isPublicEffectConformanceBuilderFor(
  builder: unknown,
  activation: unknown
): boolean {
  return typeof builder === 'object'
    && builder !== null
    && isPublicEffectConformanceActivation(activation)
    && activatedBuilders.get(builder) === activation;
}
