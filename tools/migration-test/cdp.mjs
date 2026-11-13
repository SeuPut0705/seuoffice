// The DevTools protocol, the part the migration test needs: find the page
// that exposes a bridge global and evaluate in it. Electron and the CEF shell
// both accept --remote-debugging-port, and both expose the same preload
// globals (window.aiOffice, window.aiOfficeUpdate), so one checker reads the
// old and the new app alike. Node 22+ (global fetch and WebSocket).

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function pages(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return (await res.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
}

async function evaluateIn(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error(`cannot connect to ${target.url}`))
  })
  try {
    const reply = await new Promise((resolve, reject) => {
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.id === 1) resolve(msg)
      }
      ws.onclose = () => reject(new Error(`${target.url} closed`))
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      )
    })
    if (reply.error) throw new Error(reply.error.message)
    const { result, exceptionDetails } = reply.result
    if (exceptionDetails) {
      throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    }
    return result.value
  } finally {
    ws.close()
  }
}

/** Waits for a page where `global` is an object, then evaluates `expression` there */
export async function evaluate(port, global, expression, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      for (const target of await pages(port)) {
        if (await evaluateIn(target, `typeof window.${global} === 'object'`)) {
          return await evaluateIn(target, expression)
        }
      }
    } catch (err) {
      last = err
    }
    await sleep(1000)
  }
  throw new Error(`no page with window.${global} on port ${port}${last ? `: ${last.message}` : ''}`)
}
