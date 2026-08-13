const issuedProgramReferenceSnapshots = new WeakSet<object>();

export function registerIssuedProgramReferenceSnapshot<Value extends object>(value: Value): Value {
  issuedProgramReferenceSnapshots.add(value);
  return value;
}

export function isIssuedProgramReferenceSnapshot(value: object): boolean {
  return issuedProgramReferenceSnapshots.has(value);
}
