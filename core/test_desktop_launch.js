'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const appDir = path.resolve(__dirname, '..');
const events = {}, windows = [];
let ready;
class FakeWindow {
  constructor() { this.visible = false; this.shown = 0; this.focused = 0; this.urls = []; this.webContents = {setWindowOpenHandler() {}}; windows.push(this); }
  show() { this.visible = true; this.shown++; }
  focus() { this.focused++; }
  isMinimized() { return false; }
  loadURL(url) { this.urls.push(url); return Promise.resolve(); }
}
const electron = { app:{requestSingleInstanceLock:()=>true,on:(name,fn)=>{events[name]=fn;},whenReady:()=>({then:fn=>{ready=fn;}}),quit:()=>{throw new Error('Unexpected app quit');}},
  BrowserWindow:FakeWindow,shell:{},ipcMain:{handle(){}},dialog:{showErrorBox:(title,body)=>{throw new Error(title+': '+body);}} };
function stub(name, exports) {const id=require.resolve(name);require.cache[id]={id,filename:id,loaded:true,exports};}
stub('electron',electron);
stub('./version',{codeStamp:()=> 'test-build'});
stub('./probe',{PORT_FROM:18652,PORT_TO:18652,probePort:async()=>({pid:process.pid,code_stamp:'test-build',running:0}),
  waitPortFree:async()=>true,waitForServer:async()=>18652,needsRestart:()=>false});
require(path.join(appDir,'main.js'));
(async()=>{
  await ready();
  const win=windows[0];
  assert(win.visible && win.shown>0,'desktop launch must explicitly show its window, including hidden launcher inheritance');
  assert.deepEqual(win.urls,['http://127.0.0.1:18652'],'main process must load the app directly without unobserved splash JavaScript navigation');
  win.visible=false;const shown=win.shown;
  await events['second-instance']();
  assert(win.visible && win.shown>shown && win.focused>0,'clicking shortcut again must reveal an existing hidden window');
  console.log('PASS desktop startup shows window, directly loads UI and reveals hidden single-instance window');
})().catch(e=>{console.error(e);process.exitCode=1;});
