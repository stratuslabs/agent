// Setup never imports a plugin — it reads manifests — so nothing here is
// exercised by the tests this fixture exists for. It is a real entry point
// anyway, because a package without one does not resolve at all, and because
// a fixture that could not actually load would be a misleading thing to
// point a future loader test at.
export const createPlugin = () => ({ setup: () => {} });
