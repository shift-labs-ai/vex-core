// Bindings from vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    STORE: DurableObjectNamespace;
    APP: DurableObjectNamespace;
    JOBS: DurableObjectNamespace;
    API: DurableObjectNamespace;
  }
}
