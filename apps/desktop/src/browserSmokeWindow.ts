import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import type { BrowserWebviews } from './browserWebviews'

/** Real DOM guests for the native behavior smokes; production uses BrowserWebviewHost. */
export function browserSmokeWindow(): BrowserWindow {
  return new BrowserWindow({ show: true, width: 1100, height: 850,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), webviewTag: true,
      sandbox: true, contextIsolation: true, nodeIntegration: false } })
}

export async function mountSmokeWebviews(window: BrowserWindow, registry: BrowserWebviews): Promise<void> {
  ipcMain.handle('manor:browser:webviews:list', () => registry.list())
  ipcMain.handle('manor:browser:webviews:attach', (_event, id: string, token: string, contents: number) => registry.attach(id, token, contents))
  ipcMain.handle('manor:browser:webviews:presented', (_event, id: string, token: string, revision: number) => registry.presented(id, token, revision))
  await window.loadURL('data:text/html,' + encodeURIComponent('<style>body{margin:0;background:white}#app{position:fixed;inset:0;background:white}</style><div id="app"></div>'))
  await window.webContents.executeJavaScript(`(() => {
    const bridge = window.manorDesktop.browser.webviews, guests = new Map(); let revision = -1;
    const receive = (snapshot) => {
      if (snapshot.revision <= revision) return; revision = snapshot.revision;
      for (const [id, row] of guests) if (!snapshot.surfaces.some(s => s.id===id && s.token===row.token)) { row.element.remove(); guests.delete(id); }
      for (const surface of snapshot.surfaces) {
        let row = guests.get(surface.id);
        if (!row) {
          const element = document.createElement('webview');
          element.setAttribute('src',surface.src);element.setAttribute('partition',surface.partition);element.setAttribute('allowpopups','');
          row = {element,token:surface.token,attached:false};guests.set(surface.id,row);
          const attach = async () => {try { await bridge.attach(surface.id,surface.token,element.getWebContentsId());row.attached=true;ack(row); } catch(e) { console.error(e.message) }};
          element.addEventListener('dom-ready',attach);document.body.append(element);
        }
        row.surface=surface;const b=surface.bounds;
        Object.assign(row.element.style,{position:'fixed',display:'flex',visibility:surface.presentation==='hidden'&&!surface.painting?'hidden':'visible',left:(surface.presentation==='hidden'?0:b.x)+'px',top:(surface.presentation==='hidden'?0:b.y)+'px',width:b.width+'px',height:b.height+'px',zIndex:surface.presentation==='hidden'?'-1':'5',pointerEvents:surface.presentation==='sidebar'?'auto':'none'});
        ack(row);
      }
    };
    const ack = row => {if(!row.attached)return;const s=row.surface;requestAnimationFrame(()=>requestAnimationFrame(()=>bridge.presented(s.id,s.token,s.revision).catch(()=>{})))};
    bridge.onChange(receive);bridge.list().then(receive);return true;
  })()`)
}
