// Stands in for a picture on the clipboard, which headless Chromium cannot hold.
// Control+Alt+Shift+V pastes a generated PNG into the focused element; Control+Alt+Shift+D
// drops one at the last pointer position. Both dispatch the same events a real paste or
// drop would, so the editor's own handlers do the work.
(() => {
  let pointer = { x: 0, y: 0 }
  window.addEventListener('mousemove', (event) => { pointer = { x: event.clientX, y: event.clientY } }, true)

  const picture = (label, hue) => new Promise((resolve) => {
    const canvas = document.createElement('canvas')
    canvas.width = 480
    canvas.height = 270
    const context = canvas.getContext('2d')
    const gradient = context.createLinearGradient(0, 0, 480, 270)
    gradient.addColorStop(0, `hsl(${hue} 70% 55%)`)
    gradient.addColorStop(1, `hsl(${hue + 60} 70% 40%)`)
    context.fillStyle = gradient
    context.fillRect(0, 0, 480, 270)
    context.fillStyle = 'white'
    context.font = '28px sans-serif'
    context.fillText(label, 24, 145)
    canvas.toBlob((blob) => resolve(new File([blob], 'image.png', { type: 'image/png' })), 'image/png')
  })

  window.addEventListener('keydown', async (event) => {
    if (!(event.ctrlKey && event.altKey && event.shiftKey)) return
    if (event.code === 'KeyV') {
      event.preventDefault()
      const target = document.activeElement ?? document.body
      const data = new DataTransfer()
      data.items.add(await picture('Pasted picture', 200))
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    } else if (event.code === 'KeyD') {
      event.preventDefault()
      const target = document.elementFromPoint(pointer.x, pointer.y) ?? document.body
      const data = new DataTransfer()
      data.items.add(await picture('Dropped picture', 20))
      const init = { dataTransfer: data, clientX: pointer.x, clientY: pointer.y, bubbles: true, cancelable: true }
      target.dispatchEvent(new DragEvent('dragover', init))
      target.dispatchEvent(new DragEvent('drop', init))
    }
  }, true)
})()
