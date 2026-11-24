const sameDeps = (a, b) => !!a && !!b && a.length === b.length && a.every((d, i) => Object.is(d, b[i]));

export function hookRunner(React) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const live = new Set();

  function mount(render, { contexts = new Map(), label = "" } = {}) {
    const slots = [];
    let at = 0;
    let dirty = false;
    let alive = true;
    let effects = [];
    const instance = { label, notified: 0, renders: 0, subscriptions: 0, sources: new Set() };
    const slot = (make) => (slots[at] ??= make());
    const dispatcher = {
      readContext: (ctx) => (contexts.has(ctx) ? contexts.get(ctx) : ctx._currentValue),
      useContext: (ctx) => dispatcher.readContext(ctx),
      use: (ctx) => dispatcher.readContext(ctx),
      useMemo(make, deps) {
        const s = slot(() => ({}));
        at++;
        if (!("value" in s) || !deps || !sameDeps(s.deps, deps)) {
          s.value = make();
          s.deps = deps;
        }
        return s.value;
      },
      useCallback: (fn, deps) => dispatcher.useMemo(() => fn, deps),
      useRef(initial) {
        const s = slot(() => ({ current: initial }));
        at++;
        return s;
      },
      useState(initial) {
        const s = slot(() => {
          const state = { value: typeof initial === "function" ? initial() : initial };
          state.set = (next) => {
            const v = typeof next === "function" ? next(state.value) : next;
            if (Object.is(v, state.value)) return;
            state.value = v;
            if (alive) dirty = true;
          };
          return state;
        });
        at++;
        return [s.value, s.set];
      },
      useReducer(reducer, arg, init) {
        const [state, set] = dispatcher.useState(() => (init ? init(arg) : arg));
        return [state, (action) => set((s) => reducer(s, action))];
      },
      useSyncExternalStore(subscribe, getSnapshot) {
        const s = slot(() => ({}));
        at++;
        s.getSnapshot = getSnapshot;
        s.value = getSnapshot();
        if (s.subscribe !== subscribe) {
          s.unsubscribe?.();
          s.subscribe = subscribe;
          instance.sources.add(subscribe);
          instance.subscriptions++;
          const off = subscribe(() => {
            instance.notified++;
            if (!Object.is(s.getSnapshot(), s.value)) dirty = true;
          });
          s.unsubscribe = () => {
            instance.subscriptions--;
            off?.();
          };
        }
        return s.value;
      },
      useEffect(effect, deps) {
        const s = slot(() => ({}));
        at++;
        if (s.ran && deps && sameDeps(s.deps, deps)) return;
        s.deps = deps;
        effects.push(() => {
          s.cleanup?.();
          s.ran = true;
          const cleanup = effect();
          s.cleanup = typeof cleanup === "function" ? cleanup : undefined;
        });
      },
      useLayoutEffect: (effect, deps) => dispatcher.useEffect(effect, deps),
      useInsertionEffect: (effect, deps) => dispatcher.useEffect(effect, deps),
      useImperativeHandle() {},
      useDebugValue() {},
      useId: () => "id",
      useTransition: () => [false, (fn) => fn()],
      useDeferredValue: (v) => v,
      useOptimistic: (v) => [v, () => {}],
      useActionState: (fn, v) => [v, () => {}, false],
    };
    const renderNow = () => {
      const previous = internals.H;
      internals.H = dispatcher;
      at = 0;
      dirty = false;
      try {
        render();
        instance.renders++;
      } finally {
        internals.H = previous;
      }
      const run = effects;
      effects = [];
      for (const effect of run) effect();
    };
    try {
      renderNow();
    } catch (error) {
      alive = false;
      for (const s of slots) {
        s?.unsubscribe?.();
        s?.cleanup?.();
      }
      throw error;
    }
    instance.settle = () => {
      for (let n = 0; dirty && alive && n < 20; n++) renderNow();
    };
    instance.unmount = () => {
      if (!alive) return;
      alive = false;
      live.delete(instance);
      for (const s of slots) {
        s?.unsubscribe?.();
        s?.cleanup?.();
      }
    };
    live.add(instance);
    return instance;
  }

  return { mount, live, settleAll: () => live.forEach((i) => i.settle()) };
}
