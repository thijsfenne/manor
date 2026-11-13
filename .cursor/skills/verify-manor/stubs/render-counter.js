// Render counter for render-cost measurement. Inject with
// MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/render-counter.js and launch
// with MANOR_WEB_PROFILE=1 so component names survive and fibers carry durations.
//
// It stands in for the React DevTools hook and, on every commit, walks only the subtrees
// React worked on (DevTools' own rule: a child list that is the same object as the
// alternate's was skipped). A component counts when it actually ran (PerformedWork),
// including first mounts.
//
// The control CLI has no eval, so two chords drive it: Control+Alt+Shift+KeyR resets, and
// Control+Alt+Shift+KeyP writes the report as JSON into an offscreen
// `region "Render report"` that `snapshot --role region --name "Render report"` reads:
// { commits, renderMs, total, components: { Name: count }, why: { Name: { prop: count } } }.
// renderMs sums the root fiber's actualDuration, i.e. React render time (profiling build
// only). `why` counts, per component that re-rendered, which props arrived as a new value:
// the first thing to read when a memoised row runs anyway.
(() => {
  const PERFORMED_WORK = 1
  // FunctionComponent, ClassComponent, ForwardRef, MemoComponent, SimpleMemoComponent
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15])
  let commits = 0
  let renderMs = 0
  let counts = new Map()
  let why = new Map()

  const nameOf = (fiber) => {
    const type = fiber.type
    if (!type) return null
    if (typeof type === 'function') return type.displayName || type.name || 'Anonymous'
    if (type.displayName) return type.displayName
    const inner = type.type ?? type.render
    return inner ? inner.displayName || inner.name || 'Anonymous' : null
  }

  const visit = (fiber) => {
    // Iterative to survive deep trees.
    const stack = [fiber]
    while (stack.length) {
      const node = stack.pop()
      if (COMPONENT_TAGS.has(node.tag)) {
        const ran = node.alternate === null || (node.flags & PERFORMED_WORK) === PERFORMED_WORK
        if (ran) {
          const name = nameOf(node)
          if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
          const prev = node.alternate?.memoizedProps
          const next = node.memoizedProps
          if (name && prev && next && prev !== next) {
            const changed = why.get(name) ?? new Map()
            for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
              if (prev[key] !== next[key]) changed.set(key, (changed.get(key) ?? 0) + 1)
            }
            why.set(name, changed)
          }
        }
      }
      // A child list shared with the alternate was bailed out as a whole.
      if (node.child && (node.alternate === null || node.child !== node.alternate.child)) {
        for (let child = node.child; child; child = child.sibling) stack.push(child)
      }
    }
  }

  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject(renderer) { this.renderers.set(1, renderer); return 1 },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      commits += 1
      const current = root.current
      if (typeof current.actualDuration === 'number') renderMs += current.actualDuration
      visit(current)
    },
  }

  const output = () => {
    let node = document.getElementById('render-report')
    if (!node) {
      node = document.createElement('pre')
      node.id = 'render-report'
      node.setAttribute('role', 'region')
      node.setAttribute('aria-label', 'Render report')
      node.style.cssText = 'position:fixed;left:-100000px;top:0;width:1px;overflow:hidden'
      document.body.append(node)
    }
    return node
  }
  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey && event.altKey && event.shiftKey)) return
    if (event.code !== 'KeyR' && event.code !== 'KeyP') return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.code === 'KeyR') {
      window.__renders.reset()
      document.getElementById('render-report')?.remove()
    } else {
      output().textContent = JSON.stringify(window.__renders.report())
    }
  }, true)

  window.__renders = {
    reset() { commits = 0; renderMs = 0; counts = new Map(); why = new Map() },
    report() {
      const components = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]))
      const total = [...counts.values()].reduce((sum, n) => sum + n, 0)
      const reasons = Object.fromEntries([...why].map(([name, changed]) => [name, Object.fromEntries(changed)]))
      return { commits, renderMs: Math.round(renderMs * 10) / 10, total, components, why: reasons }
    },
  }
})()
