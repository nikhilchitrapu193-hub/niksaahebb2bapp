// =============================================================================
// fake-supabase.js — a tiny in-memory stand-in for the supabase-js client, so
// page tests run offline. It supports exactly the calls the app makes:
//   from(table).select/eq/order/limit/maybeSingle/single/insert/update/delete
//   rpc(name, args), auth.*, storage.from().getPublicUrl/upload
//
// Usage:
//   const fake = createFake({ tables: { products: [...] }, rpc: { place_order: () => ({...}) } });
//   globalThis.supabase = { createClient: () => fake.client };
//   fake.calls  → every write / rpc the app made, for assertions
// =============================================================================

export function createFake({ tables = {}, rpc = {}, session = null } = {}) {
  const calls = [];
  const state = { session };

  function from(table) {
    const q = { filters: [], op: 'select', payload: null, one: null };
    const builder = {
      select() { return builder; },
      eq(column, value) { q.filters.push([column, value]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { q.one = 'maybe'; return builder; },
      single() { q.one = 'single'; return builder; },
      insert(payload) { q.op = 'insert'; q.payload = payload; return builder; },
      update(payload) { q.op = 'update'; q.payload = payload; return builder; },
      delete() { q.op = 'delete'; return builder; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    function run() {
      if (q.op !== 'select') calls.push({ type: q.op, table, payload: q.payload, filters: q.filters });
      const rows = (tables[table] ?? []).filter((row) => q.filters.every(([c, v]) => row[c] === v));
      if (q.op !== 'select') return { data: q.one ? q.payload : null, error: null };
      if (q.one) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    return builder;
  }

  const client = {
    from,
    rpc: async (name, args) => {
      calls.push({ type: 'rpc', name, args });
      if (!rpc[name]) return { data: null, error: { message: `no fake for rpc ${name}` } };
      return { data: await rpc[name](args), error: null };
    },
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      signInWithPassword: async ({ email }) => {
        if (email === 'bad@example.com') return { data: null, error: { message: 'Invalid login credentials' } };
        state.session = { user: { id: 'u-' + email, email } };
        return { data: { session: state.session }, error: null };
      },
      signUp: async () => ({ data: { session: null }, error: null }),
      signOut: async () => { state.session = null; return { error: null }; },
      resetPasswordForEmail: async () => ({ data: {}, error: null }),
      updateUser: async () => ({ data: {}, error: null }),
    },
    functions: {
      invoke: async (name, { body } = {}) => {
        calls.push({ type: 'function', name, body });
        if (!rpc[name]) return { data: null, error: { message: `no fake for function ${name}` } };
        return { data: await rpc[name](body), error: null };
      },
    },
    storage: {
      from: (bucket) => ({
        getPublicUrl: (path) => ({ data: { publicUrl: `https://files.test/${bucket}/${path}` } }),
        upload: async () => ({ data: {}, error: null }),
      }),
    },
  };

  return { client, calls, state, tables };
}

// -----------------------------------------------------------------------------
// App modules are cached after their first import, so they keep whichever client
// they were created with. To give every test a fresh backend we hand the app one
// stable proxy and point it at the current fake with useFake().
// -----------------------------------------------------------------------------

let current = null;

export const proxyClient = new Proxy({}, {
  get: (_target, property) => current.client[property],
});

/** Make `fake` the backend for the shared proxy client and install window.supabase. */
export function useFake(fake) {
  current = fake;
  globalThis.supabase = { createClient: () => proxyClient };
}
