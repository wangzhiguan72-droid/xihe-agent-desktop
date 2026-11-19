// 本机界面偏好在样式首次绘制前读取，不依赖模型设置或网络。
'use strict';
(() => {
  const key = 'xihe.appearance';
  const system = window.matchMedia('(prefers-color-scheme: light)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let prefs = { theme: 'system', intro: true };
  let timer;
  let introRun = 0;
  function read() {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      return { theme: ['dark', 'light', 'system'].includes(saved?.theme) ? saved.theme : 'system', intro: saved?.intro !== false };
    } catch { return { theme: 'system', intro: true }; }
  }
  function apply() {
    const theme = prefs.theme === 'system' ? (system.matches ? 'light' : 'dark') : prefs.theme;
    document.documentElement.dataset.theme = theme;
    const select = document.getElementById('setTheme');
    const toggle = document.getElementById('setIntro');
    const quick = document.getElementById('btnTheme');
    if (select) select.value = prefs.theme;
    if (toggle) toggle.checked = prefs.intro;
    if (quick) { quick.title = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'; quick.setAttribute('aria-label', quick.title); }
  }
  function save(patch) {
    prefs = { ...prefs, ...patch };
    try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* 存储受限时仍允许当前窗口设置 */ }
    apply();
  }
  function stopIntro() {
    introRun++;
    clearTimeout(timer);
    window.xiheJinwuMotion?.stop();
    document.getElementById('dlgIntro').close();
  }
  async function playIntro() {
    const run = ++introRun;
    clearTimeout(timer);
    const dialog = document.getElementById('dlgIntro');
    document.getElementById('introDisable').checked = !prefs.intro;
    if (dialog.open) dialog.close();
    dialog.showModal();
    // 在场景载入前也设置退场兜底，网络异常不能挡住主界面。
    timer = setTimeout(stopIntro, 7000);
    try { await window.xiheJinwuMotion.mount(document.querySelector('.intro-scene')); }
    catch { /* SVG加载失败时保留静态金乌，仍可跳过 */ }
    if (run !== introRun || !dialog.open) return;
    clearTimeout(timer);
    timer = setTimeout(stopIntro, reducedMotion.matches ? 1000 : window.xiheJinwuMotion.duration + 100);
  }
  prefs = read();
  apply();
  window.xiheAppearance = { get: () => ({ ...prefs }), playIntro, ready: false };
  system.addEventListener('change', apply);
  window.addEventListener('storage', e => { if (e.key === key || e.key === null) { prefs = read(); apply(); } });
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('btnTheme').onclick = () => save({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' });
    document.getElementById('setTheme').onchange = e => save({ theme: e.target.value });
    document.getElementById('setIntro').onchange = e => save({ intro: e.target.checked });
    document.getElementById('introDisable').onchange = e => save({ intro: !e.target.checked });
    document.getElementById('btnReplayIntro').onclick = playIntro;
    document.getElementById('btnSkipIntro').onclick = stopIntro;
    document.getElementById('dlgIntro').addEventListener('close', () => { if (!document.getElementById('dlgIntro').open) { clearTimeout(timer); window.xiheJinwuMotion?.stop(); } });
    window.xiheAppearance.ready = true;
    if (prefs.intro) playIntro();
  });
})();
