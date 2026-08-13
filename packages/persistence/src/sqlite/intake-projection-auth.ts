const authenticatedIntakeProjections = new WeakSet<object>();

export function authenticateIntakeProjection<Projection extends object>(
  projection: Projection
): Projection {
  authenticatedIntakeProjections.add(projection);
  return projection;
}

export function assertAuthenticatedIntakeProjection(projection: object): void {
  if (!authenticatedIntakeProjections.has(projection)) {
    throw new TypeError('intake_projection_invalid');
  }
}
