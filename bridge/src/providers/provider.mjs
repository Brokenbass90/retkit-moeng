export function normalizeProviderStatus(input, id) {
  const auth = ['yes', 'no', 'unknown'].includes(input?.authenticated) ? input.authenticated : 'unknown';
  return {
    id,
    detected: Boolean(input?.detected),
    authenticated: auth,
    version: input?.version ? String(input.version) : null,
    detail: input?.detail ? String(input.detail) : null,
  };
}

export function assertProviderContract(provider) {
  for (const name of ['detect', 'connect', 'send', 'cancel', 'close']) {
    if (typeof provider?.[name] !== 'function') throw new Error(`Provider missing ${name}()`);
  }
  return provider;
}
