// ココフォリアの部屋の中にキャラシ（共有ページ）を出す小さなプログラム。
// 共有ページと同じ公開の置き場（sheets/ccfolia.js）に置き、ブックマーク（ブックマークレット）から読み込む。
// ブックマークは「これを読み込む」だけなので、ここを直せば登録し直さなくても新しい版が使われる。
//   ・キャラシは部屋ごとに覚える（ココフォリア側の localStorage）。最初の1回だけ共有ページのURLを貼る
//   ・キャラシの中で「ココフォリアで振る」を押すと、発言者をそのキャラ名にしてチャットに送り、発言者を元に戻す
//   ・動くのは押した人の画面だけ。部屋のデータは変えない
(() => {
  const KEY = 'stt-ccfolia';
  const ORIGIN = new URL(document.currentScript ? document.currentScript.src : location.href).origin;
  const room = (location.pathname.match(/\/rooms\/([^/?#]+)/) || [])[1] || '';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const save = (st) => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* 保存できなくても使える */ } };
  const st = load(); st.rooms ||= {}; st.recent ||= [];
  const clean = (u) => { try { const x = new URL(String(u).trim()); return x.origin === ORIGIN && /\/sheets\/[\w-]+\.html$/.test(x.pathname) ? x.origin + x.pathname : ''; } catch (e) { return ''; } };
  const preset = clean(window.__sttPreset || ''); window.__sttPreset = '';
  if (preset && room) { st.rooms[room] = { ...(st.rooms[room] || {}), url: preset }; save(st); }

  let p = document.getElementById('stt-sheet');
  if (p) { if (preset) { p.remove(); p = null; } else { p.style.display = p.style.display === 'none' ? 'flex' : 'none'; return; } }

  const css = (el, s) => { el.style.cssText = s; return el; };
  const el = (tag, s, text) => { const e = css(document.createElement(tag), s || ''); if (text != null) e.textContent = text; return e; };
  const pos = st.pos || { left: 8, top: 60, width: 620, height: Math.round(innerHeight * 0.75) };
  p = el('div', `position:fixed;left:${pos.left}px;top:${pos.top}px;width:${pos.width}px;height:${pos.height}px;z-index:99999;background:#2a2116;border:1px solid #b06a2c;border-radius:8px;resize:both;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 6px 20px #000b;min-width:280px;min-height:160px`);
  p.id = 'stt-sheet';
  const bar = el('div', 'cursor:move;color:#f3e6d0;font:12px sans-serif;padding:4px 6px 4px 10px;display:flex;gap:8px;align-items:center;user-select:none;touch-action:none');
  const title = el('span', 'flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis', 'キャラシ');
  const btn = (t, tip) => { const b = el('button', 'font:12px sans-serif;border:0;border-radius:6px;padding:3px 8px;background:#b06a2c;color:#fff;cursor:pointer', t); b.type = 'button'; b.title = tip || ''; return b; };
  const bSwitch = btn('キャラを替える', '別のキャラシにする');
  const bClose = btn('×', '隠す（もう一度ブックマークを押すと出る）');
  bar.append(title, bSwitch, bClose);
  const body = el('div', 'flex:1;display:flex;background:#fffdf8;min-height:0');
  p.append(bar, body);
  document.body.append(p);

  const remember = () => { const r = p.getBoundingClientRect(); st.pos = { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; save(st); };
  new ResizeObserver(() => { if (p.style.display !== 'none') remember(); }).observe(p);
  bClose.onclick = () => { p.style.display = 'none'; };
  bar.onpointerdown = (e) => {
    if (e.target.tagName === 'BUTTON') return;
    const sx = e.clientX - p.offsetLeft, sy = e.clientY - p.offsetTop;
    const f = body.querySelector('iframe'); if (f) f.style.pointerEvents = 'none';
    const mv = (v) => { p.style.left = Math.min(innerWidth - 60, Math.max(0, v.clientX - sx)) + 'px'; p.style.top = Math.min(innerHeight - 30, Math.max(0, v.clientY - sy)) + 'px'; };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (f) f.style.pointerEvents = ''; remember(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  };

  // キャラシを選ぶ画面：共有ページのURLを貼る／前に使ったキャラから選ぶ
  const choose = () => {
    title.textContent = 'キャラシを選ぶ';
    const box = el('div', 'padding:14px;font:14px sans-serif;color:#2a2116;overflow:auto;flex:1');
    box.append(el('p', 'margin:0 0 8px;font-weight:bold', 'キャラシの共有リンク（閲覧ページのURL）を貼ってください'));
    const inp = el('input', 'width:100%;box-sizing:border-box;font:14px sans-serif;padding:6px;border:1px solid #b06a2c;border-radius:6px');
    inp.placeholder = 'https://…/sheets/….html';
    const ok = btn('この部屋で使う'); ok.style.marginTop = '8px'; ok.style.fontSize = '14px';
    const err = el('p', 'color:#b00;margin:6px 0 0;font-size:12px');
    const go = (u) => { const c = clean(u); if (!c) { err.textContent = 'キャラシの共有リンクではないようです（ツールの「共有リンク」で出したURLを貼ってください）'; return; } st.rooms[room] = { ...(st.rooms[room] || {}), url: c }; save(st); open(); };
    ok.onclick = () => go(inp.value);
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(inp.value); };
    box.append(inp, ok, err);
    if (st.recent.length) {
      box.append(el('p', 'margin:16px 0 6px;font-weight:bold', '前に使ったキャラ'));
      for (const r of st.recent) { const b = btn(r.name || r.url); b.style.cssText += ';display:block;margin:0 0 6px;font-size:14px;background:#efe3cf;color:#2a2116'; b.onclick = () => go(r.url); box.append(b); }
    }
    body.replaceChildren(box);
    setTimeout(() => inp.focus(), 50);
  };
  const open = () => {
    const cur = st.rooms[room];
    if (!cur || !cur.url) { choose(); return; }
    title.textContent = cur.name ? `${cur.name} のキャラシ（帯をつかんで移動／右下で大きさ）` : 'キャラシ';
    const f = el('iframe', 'flex:1;border:0;background:#fff;width:100%');
    f.src = cur.url;
    body.replaceChildren(f);
  };
  bSwitch.onclick = choose;

  // チャット欄に入れて送る。発言者はキャラシの名前にして、送ったら元に戻す
  const setVal = (e, v) => { const pr = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(pr, 'value').set.call(e, v); e.dispatchEvent(new Event('input', { bubbles: true })); };
  const wait = (ms) => new Promise((k) => setTimeout(k, ms));
  let busy = Promise.resolve();
  const send = (text, name) => (busy = busy.then(async () => {
    const t = document.querySelector('textarea[name=text]');
    if (!t) { console.warn('[キャラシ] チャット欄が見つかりません'); return; }
    const n = document.querySelector('input[name=name]');
    const old = n ? n.value : '';
    if (n && name && old !== name) { setVal(n, name); await wait(120); }
    setVal(t, String(text).slice(0, 500)); await wait(60);
    const fm = t.closest('form'); if (fm) fm.requestSubmit();
    await wait(500);
    if (n && name && old && old !== name) setVal(n, old);
  }).catch((e) => console.warn('[キャラシ]', e)));

  if (!window.__sttListen) {
    window.__sttListen = 1;
    addEventListener('message', (e) => {
      if (e.origin !== ORIGIN || !e.data) return;
      const d = e.data;
      if (d.type === 'stt-roll' && d.text) send(d.text, d.name);
      if (d.type === 'stt-hello') {
        const s2 = load(); s2.rooms ||= {}; s2.recent ||= [];
        const cur = s2.rooms[room]; if (!cur) return;
        cur.name = String(d.name || '').slice(0, 40);
        s2.recent = [{ url: cur.url, name: cur.name }, ...s2.recent.filter((r) => r.url !== cur.url)].slice(0, 12);
        Object.assign(st, s2); save(st);
        const tt = document.querySelector('#stt-sheet span'); if (tt && cur.name) tt.textContent = `${cur.name} のキャラシ（帯をつかんで移動／右下で大きさ）`;
      }
    });
  }
  open();
})();
