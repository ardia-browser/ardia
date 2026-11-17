const usage = `Usage: node cdp_tab.mjs <command> <endpoint> [args]

Prepares a browser over its DevTools endpoint for the bench. <endpoint> is a local DevTools port, an http(s) DevTools
URL or a browser websocket URL.

  open <endpoint> <url>                  open <url> as the only tab, active and loaded; fails on a network error page
  lend <endpoint> <extension-id> <url>   run the extension's toolbar-click handler for the tab showing <url>, for browsers
                                         without a toolbar (Ardia hides extension actions)`

const [command, endpoint, ...args] = process.argv.slice(2)
if (!command || !endpoint || command === "-h" || command === "--help") {
  console.log(usage)
  process.exit(command ? 0 : 2)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = (ms) => Date.now() + ms

async function browserSocketUrl() {
  if (/^wss?:\/\//.test(endpoint)) return endpoint
  const base = /^\d+$/.test(endpoint) ? `http://127.0.0.1:${endpoint}` : endpoint.replace(/\/$/, "")
  return (await (await fetch(`${base}/json/version`)).json()).webSocketDebuggerUrl
}

const socket = new WebSocket(await browserSocketUrl())
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = () => reject(new Error(`no DevTools socket at ${endpoint}`))
})
let nextId = 0
const waiting = new Map()
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (waiting.has(message.id)) {
    waiting.get(message.id)(message)
    waiting.delete(message.id)
  }
}
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000)
    waiting.set(id, (message) => {
      clearTimeout(timer)
      if (message.error) reject(new Error(`${method}: ${message.error.message}`))
      else resolve(message.result)
    })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })

const pages = async () => (await send("Target.getTargets")).targetInfos.filter((t) => t.type === "page")

async function evaluate(targetId, expression) {
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true })
  try {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)
    return r.result?.value
  } finally {
    await send("Target.detachFromTarget", { sessionId }).catch(() => undefined)
  }
}

async function loaded(targetId) {
  const until = deadline(45_000)
  while (Date.now() < until) {
    const state = await evaluate(targetId, "[document.readyState, document.title, location.href]").catch(() => undefined)
    const [ready, title, href] = state ?? []
    if (href?.startsWith("chrome-error://")) return { error: true, title }
    if (ready === "complete" && title) return { error: false, title }
    await sleep(250)
  }
  throw new Error("page did not finish loading")
}

async function openOnly(url) {
  let last
  for (let attempt = 0; attempt < 6; attempt++) {
    const before = await pages()
    const { targetId } = await send("Target.createTarget", { url })
    const state = await loaded(targetId)
    for (const tab of before) await send("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined)
    if (!state.error) {
      await send("Target.activateTarget", { targetId })
      const until = deadline(10_000)
      let open = await pages()
      while (open.length !== 1 && Date.now() < until) {
        for (const tab of open) if (tab.targetId !== targetId) await send("Target.closeTarget", { targetId: tab.targetId }).catch(() => undefined)
        await sleep(250)
        open = await pages()
      }
      return { title: state.title, attempts: attempt + 1, tabs: open.map((t) => [t.url, t.title]) }
    }
    last = state.title
    await sleep(5000)
  }
  throw new Error(`${url} kept showing an error page (${last})`)
}

async function lend(extensionId, url) {
  const worker = (await send("Target.getTargets")).targetInfos.find(
    (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`),
  )
  if (!worker) throw new Error(`extension ${extensionId} has no service worker`)
  const { sessionId } = await send("Target.attachToTarget", { targetId: worker.targetId, flatten: true })
  const expression = `chrome.tabs.query({}).then((tabs) => { const tab = tabs.find((t) => t.url === ${JSON.stringify(url)}); if (!tab) throw new Error("no tab shows the url"); chrome.action.onClicked.dispatch(tab); return tab.id })`
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "lend failed")
  return { lent: r.result.value, url }
}

try {
  if (command === "open") console.log(JSON.stringify(await openOnly(args[0])))
  else if (command === "lend") console.log(JSON.stringify(await lend(args[0], args[1])))
  else {
    console.error(usage)
    process.exitCode = 2
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  socket.close()
}
