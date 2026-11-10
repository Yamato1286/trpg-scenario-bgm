// ココフォリアの部屋の中にキャラシ（共有ページ）を出す小さなプログラム。
// 共有ページと同じ公開の置き場（sheets/ccfolia.js）に置き、ブックマーク（ブックマークレット）から読み込む。
// ブックマークは「これを読み込む」だけなので、ここを直せば登録し直さなくても新しい版が使われる。
//   ・キャラシは部屋ごとに覚える（ココフォリア側の localStorage）。最初の1回だけ共有ページのURLを貼る
//   ・キャラシの中で「ココフォリアで振る」を押すと、発言者をそのキャラ名にしてチャットに送り、発言者を元に戻す
//   ・動くのは押した人の画面だけ。部屋のデータは変えない
//   ・CoC（クトゥルフ神話TRPG）の部屋では「CoC の判定」に切り替える。キャラシは使わず、駒のチャットパレットの技能から判定を組み立てて送る
(() => {
  // ===== CoC の判定のつまみ：コマンドの組み立て・読み取り（画面に触らない。tests/ccfolia-coc.test.js で確かめる） =====
  // 書式は BCDice 公式のソースで確かめたもの（2026-11-02、master）：
  //   6版 https://github.com/bcdice/BCDice/blob/master/lib/bcdice/game_system/Cthulhu.rb
  //     CCB<=n（c=5,f=96）／CC<=n（c=1,f=100）。目標値は四則の式も可（%r{^CCB?(\d+)?(?:<=([+-/*\d]+))?$}）
  //     結果「(1D100<=n) ＞ 出目 ＞ 成功|失敗|決定的成功|スペシャル|決定的成功/スペシャル|致命的失敗」、故障ナンバーつきは「故障」
  //     組み合わせ CBR(x,y)（c=1）／CBRB(x,y)（c=5）
  //   7版 https://github.com/bcdice/BCDice/blob/master/lib/bcdice/game_system/Cthulhu7th.rb
  //     CC(x)<=n（x＝ボーナス・ペナルティダイス。正規表現は /^CC([-+]?\d+)?(?:<=(\d+)([RHEC])?)?$/。
  //       「CC(1)」の括弧は lib/bcdice/preprocessor.rb の replace_parentheses が計算して「CC1」にする）
  //     結果「(1D100<=n) ボーナス・ペナルティダイス[x] ＞ 出目の一覧 ＞ 出目 ＞ クリティカル|イクストリーム成功|ハード成功|レギュラー成功|失敗|ファンブル」
  //     組み合わせ CBR(x,y)
  //   連射 https://github.com/bcdice/BCDice/blob/master/lib/bcdice/game_system/cthulhu7th/full_auto.rb
  //     FAR(w,x,y,z,d,v)：w 弾丸の数(1～100)、x 技能値、y 故障ナンバー、z ボーナス・ペナルティダイス(-2～2,省略可)、
  //     d 指定難易度で連射を終える(r/h/e,省略可)、v ボレーの弾丸の数(省略可)。間を空けるときは「FaR(40,77,100,,e,4)」
  //   パルプ https://github.com/bcdice/BCDice/blob/master/lib/bcdice/game_system/PulpCthulhu.rb
  //     別のダイスボット「パルプ・クトゥルフ」（Cthulhu7th を継ぐ）。CC・CBR・FAR は同じ書式。FAR の説明に v（ボレー）は無いので、パルプでは v を付けない
  //   空白から後ろはコマンドとして読まれない（preprocessor.rb の trim_after_whitespace）ので、技能名は空白のあとに書く
  const COC = (() => {
    const int = (v) => (v === '' || v == null || !/^[-+]?\d+$/.test(String(v).trim()) ? NaN : Number(v));
    // 技能名：【目星】〈目星〉《目星》[目星]「目星」の中、無ければ最初の語
    const nameOf = (rest) => {
      const s = String(rest || '').trim();
      const m = /[【〈《\[「『]([^】〉》\]」』]+)[】〉》\]」』]/.exec(s);
      return (m ? m[1] : s.split(/\s+/)[0] || '').trim().slice(0, 30);
    };
    const LINE = /^(CCB\d*|CC(?:\(([-+]?\d+)\)|([-+]?\d+))?|1D100)\s*<=\s*(\d+|\{[^}\s]+\})([RHEC](?![^\s]))?\s*(.*)$/i;
    // チャットパレットの文から技能を拾う。版は CCB があれば6版、CC だけなら7版と推定（6版の「CC<=」(1%ルール)もあるので推定は変えられる）
    const parsePalette = (text) => {
      const skills = []; const seen = new Set(); let n6 = 0, n7 = 0;
      for (const raw of String(text || '').split(/\r?\n/)) {
        const m = LINE.exec(raw.trim());
        if (!m) continue;
        const head = m[1].toUpperCase();
        if (head.startsWith('CCB')) n6++; else if (head.startsWith('CC')) n7++;
        const v = /^\d+$/.test(m[4]) ? Number(m[4]) : m[4];
        const name = nameOf(m[6]) || (typeof v === 'number' ? `技能値${v}` : v);
        if (seen.has(name)) continue;
        seen.add(name); skills.push({ name, value: v });
      }
      return { skills, edition: n6 ? '6' : (n7 ? '7' : '') };
    };
    const clampBonus = (b) => Math.max(-2, Math.min(2, int(b) || 0));
    // 技能判定。edition '6' | '7' | 'pulp'。6版は補正（足し引き）、7版・パルプはボーナス(+)/ペナルティ(-)ダイスの数
    const buildSkill = ({ edition, value, name, bonus = 0, mod = 0 }) => {
      const label = name ? ` 【${name}】` : '';
      if (edition === '6') {
        const md = int(mod) || 0;
        const v = typeof value === 'number' ? Math.max(1, value + md) : (md ? `${value}${md > 0 ? '+' : ''}${md}` : value);
        return `CCB<=${v}${label}${md ? `（補正${md > 0 ? '+' : ''}${md}）` : ''}`;
      }
      const b = clampBonus(bonus);
      return `CC${b ? `(${b})` : ''}<=${value}${label}`;
    };
    const buildCombine = ({ edition, a, b }) => {
      const x = int(a?.value ?? a), y = int(b?.value ?? b);
      if (!(x >= 1) || !(y >= 1)) throw new Error('組み合わせは数値の技能を2つ選んでください');
      const names = [a?.name, b?.name].filter(Boolean).map((n) => `【${n}】`).join('');
      return `${edition === '6' ? 'CBRB' : 'CBR'}(${x},${y})${names ? ' ' + names : ''}`;
    };
    // 7版の連射（自動火器）。BCDice の FAR を組み立てるだけ。状況ごとの修正はボーナス/ペナルティ数を手で選ぶ
    const buildFar = ({ bullets, skill, broken, bonus = 0, stop = '', volley = '', pulp = false, name = '' }) => {
      const w = int(bullets), x = int(skill), y = int(broken);
      if (!(w >= 1 && w <= 100)) throw new Error('弾丸の数は1～100');
      if (!(x >= 1 && x <= 100)) throw new Error('技能値は1～100');
      if (!(y >= 1 && y <= 100)) throw new Error('故障ナンバーは1～100');
      const z = clampBonus(bonus);
      const d = /^[rhe]$/i.test(String(stop)) ? String(stop).toLowerCase() : '';
      const v = pulp ? NaN : int(volley);
      if (!pulp && volley !== '' && volley != null && !(v >= 1)) throw new Error('ボレーの弾丸の数は1以上');
      const args = [w, x, y, z || '', d, v >= 1 ? v : ''];
      while (args.length > 3 && args[args.length - 1] === '') args.pop();
      return `FAR(${args.join(',')})${name ? ` 【${name}】` : ''}`;
    };
    // ===== 成長の候補：チャットの記録から、成功した技能を拾う（決めない。候補／要確認として出す） =====
    const CMD = /(CCB\d*|CC(?:\(([-+]?\d+)\)|([-+]?\d+))?)\s*<=\s*(\d+|\{[^}\s]+\})[RHEC]?(?![^\s])[ \t]*([^\n]*)/i;
    const R6 = /\(1D100<=(\d+)\)\s*(?:故障ナンバー\[\d+\])?\s*＞\s*(\d+)\s*＞\s*([^\n＞]+)/i;
    const R7 = /\(1D100<=(\d+)\)\s*ボーナス・ペナルティダイス\[(-?\d+)\]\s*＞[^＞\n]*＞\s*(\d+)\s*＞\s*([^\n＞]+)/i;
    const OK6 = /^(成功|決定的成功|スペシャル|決定的成功\/スペシャル)$/;
    const OK7 = /^(クリティカル|イクストリーム成功|ハード成功|レギュラー成功|成功)$/;
    // 技能でない判定・成長しないことがある技能（本で確認するまで「要確認」にとどめる）
    const NOT_SKILL = /SAN|正気度|幸運|アイデア|知識|^(STR|CON|POW|DEX|APP|SIZ|INT|EDU)|×5|\*5|クトゥルフ神話|信用|技能値\d+/i;
    const parseRoll = (text) => {
      const s = String(text || '');
      const c = CMD.exec(s); if (!c) return null;
      const r7 = R7.exec(s); const r6 = r7 ? null : R6.exec(s);
      if (!r7 && !r6) return null;
      const rest = c[5].replace(/\(1D100.*$/i, '');
      const result = (r7 ? r7[4] : r6[3]).trim();
      return {
        skill: nameOf(rest) || '',
        edition: r7 ? '7' : '6',
        bonus: r7 ? Number(r7[2]) : 0,
        roll: Number(r7 ? r7[3] : r6[2]),
        result,
        success: r7 ? OK7.test(result) : OK6.test(result),
        // 6版で故障ナンバーを付けたとき、故障は成功・失敗を上書きして出る（Cthulhu.rb の説明）ので成否が分からない。「致命的失敗/故障」は失敗
        broken: result === '故障',
      };
    };
    // messages: [{ name, text }]。name を渡すとそのキャラの発言だけを見る
    const extractGrowth = (messages, { name = '' } = {}) => {
      const by = new Map();
      for (const msg of messages || []) {
        if (name && msg.name && msg.name !== name) continue;
        if (name && !msg.name) continue;
        const r = parseRoll(msg.text);
        if (!r || !(r.success || r.broken)) continue;
        const key = r.skill || '（技能名なし）';
        const e = by.get(key) || { skill: key, successes: 0, plain: 0, reasons: new Set() };
        if (r.success) e.successes++;
        const why = [];
        if (!r.skill) why.push('技能名が無い');
        if (r.broken) why.push('故障が出た');
        if (r.bonus > 0) why.push('ボーナス・ダイスつきで成功（成長の扱いは本で確認）');
        if (r.skill && NOT_SKILL.test(r.skill)) why.push('技能でない判定か、成長しない技能の可能性（本で確認）');
        if (why.length) why.forEach((w) => e.reasons.add(w)); else e.plain++;
        by.set(key, e);
      }
      return [...by.values()].map((e) => ({ skill: e.skill, status: e.plain ? '候補' : '要確認', successes: e.successes, reasons: [...e.reasons] }))
        .sort((a, b) => (a.status === b.status ? b.successes - a.successes : (a.status === '候補' ? -1 : 1)));
    };
    return { parsePalette, buildSkill, buildCombine, buildFar, parseRoll, extractGrowth };
  })();
  if (typeof document === 'undefined') { globalThis.__sttCoc = COC; return; } // テストから読むとき

  const KEY = 'stt-ccfolia';
  const ORIGIN = new URL(document.currentScript ? document.currentScript.src : location.href).origin;
  const room = (location.pathname.match(/\/rooms\/([^/?#]+)/) || [])[1] || '';
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
  const save = (st) => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) { /* 保存できなくても使える */ } };
  const st = load(); st.rooms ||= {}; st.recent ||= [];
  const clean = (u) => { try { const x = new URL(String(u).trim()); return x.origin === ORIGIN && /\/sheets\/[\w-]+\.html$/.test(x.pathname) ? x.origin + x.pathname : ''; } catch (e) { return ''; } };
  const preset = clean(window.__sttPreset || ''); window.__sttPreset = '';
  const cleanList = (u) => { try { const x = new URL(String(u)); return x.origin === ORIGIN && /\/sheets\/list-[a-f0-9]+\.json$/.test(x.pathname) ? x.origin + x.pathname : ''; } catch (e) { return ''; } };
  let newList = false;
  if (window.__sttList) { const l = cleanList(window.__sttList); if (l && l !== st.list) { st.list = l; save(st); newList = true; } window.__sttList = ''; }
  // 共有中のキャラの一覧（ブックマークに入っている置き場から読む）
  const fetchList = async () => { if (!st.list) return []; try { const r = await fetch(st.list + '?t=' + Date.now(), { cache: 'no-store' }); const j = await r.json(); return (j.sheets || []).filter((x) => clean(x.url)); } catch (e) { return []; } };
  // この部屋にいるキャラ：発言者の名前と、画面に出ている文字（駒の名前・ステータス欄・チャットの名前）がキャラシの名前と同じもの
  const inRoom = (list) => {
    const words = new Set();
    for (const e of document.querySelectorAll('body *')) { if (e.closest('#stt-sheet') || e.childElementCount) continue; const t = (e.textContent || '').trim(); if (t && t.length <= 40) words.add(t); }
    const sp = (document.querySelector('input[name=name]') || {}).value || '';
    const bySpeaker = list.filter((x) => x.name && x.name === sp);
    return { bySpeaker, present: list.filter((x) => x.name && (words.has(x.name) || x.name === sp)) };
  };
  if (preset && room) { st.rooms[room] = { ...(st.rooms[room] || {}), url: preset }; save(st); }

  let p = document.getElementById('stt-sheet');
  // 押すたびに出す／隠すを切り替える（中の生命力などはそのまま）。新しい設定で押したとき・キャラを選ぶ画面のままのときは作り直す（最新の一覧で選び直す）
  if (p) { const showing = p.style.display !== 'none'; const choosing = !p.querySelector('iframe, #stt-coc'); if (!preset && !newList && !choosing) { p.style.display = showing ? 'none' : 'flex'; return; } p.remove(); p = null; }

  const css = (el, s) => { el.style.cssText = s; return el; };
  const el = (tag, s, text) => { const e = css(document.createElement(tag), s || ''); if (text != null) e.textContent = text; return e; };
  const pos = st.pos || { left: 8, top: 60, width: 620, height: Math.round(innerHeight * 0.75) };
  p = el('div', `position:fixed;left:${pos.left}px;top:${pos.top}px;width:${pos.width}px;height:${pos.height}px;z-index:99999;background:#2a2116;border:1px solid #b06a2c;border-radius:8px;resize:both;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 6px 20px #000b;min-width:280px;min-height:160px`);
  p.id = 'stt-sheet';
  const bar = el('div', 'cursor:move;color:#f3e6d0;font:12px sans-serif;padding:4px 6px 4px 10px;display:flex;gap:8px;align-items:center;user-select:none;touch-action:none');
  const title = el('span', 'flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis', 'キャラシ');
  const btn = (t, tip) => { const b = el('button', 'font:12px sans-serif;border:0;border-radius:6px;padding:3px 8px;background:#b06a2c;color:#fff;cursor:pointer', t); b.type = 'button'; b.title = tip || ''; return b; };
  const bSwitch = btn('キャラを替える', '別のキャラシにする');
  const bMode = btn('CoC の判定', 'クトゥルフ神話TRPGの判定のつまみに切り替える（キャラシは使わず、駒のチャットパレットから）');
  const bClose = btn('×', '隠す（もう一度ブックマークを押すと出る）');
  const bTools = btn('道具', 'パレットを全員分から探す・表情（差分）のボタン・新しい発言の通知');
  bar.append(title, bTools, bMode, bSwitch, bClose);
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
  let listed = [];
  const choose = () => {
    title.textContent = 'キャラシを選ぶ';
    const box = el('div', 'padding:14px;font:14px sans-serif;color:#2a2116;overflow:auto;flex:1');
    const inp = el('input', 'width:100%;box-sizing:border-box;font:14px sans-serif;padding:6px;border:1px solid #b06a2c;border-radius:6px');
    inp.placeholder = 'https://…/sheets/….html';
    const ok = btn('この部屋で使う'); ok.style.marginTop = '8px'; ok.style.fontSize = '14px';
    const err = el('p', 'color:#b00;margin:6px 0 0;font-size:12px');
    const go = (u) => { const c = clean(u); if (!c) { err.textContent = 'キャラシの共有リンクではないようです（ツールの「共有リンク」で出したURLを貼ってください）'; return; } st.rooms[room] = { ...(st.rooms[room] || {}), url: c }; save(st); open(); };
    ok.onclick = () => go(inp.value);
    inp.onkeydown = (e) => { if (e.key === 'Enter') go(inp.value); };
    const pickBtn = (r, hot) => { const b = btn((hot ? '★ この部屋にいる：' : '') + (r.name || r.url) + (r.school ? `（${r.school}）` : '')); b.style.cssText += ';display:block;width:100%;margin:0 0 6px;padding:8px 10px;font-size:15px;background:' + (hot ? '#f6d9b5' : '#efe3cf') + ';color:#2a2116;text-align:left'; b.onclick = () => go(r.url); return b; };
    const rows = listed.length ? listed : st.recent;
    if (rows.length) {
      box.append(el('p', 'margin:0 0 8px;font-weight:bold', listed.length ? 'どのキャラで遊びますか（押すだけ）' : '前に使ったキャラ'));
      const here = new Set(inRoom(rows).present.map((x) => x.url));
      for (const r of [...rows].sort((a, b) => here.has(b.url) - here.has(a.url))) box.append(pickBtn(r, here.has(r.url)));
      box.append(el('p', 'margin:18px 0 6px;font-size:12px;color:#7a6650', '一覧にないキャラは、共有リンクを貼る'));
    } else box.append(el('p', 'margin:0 0 8px;font-weight:bold', 'キャラシの共有リンク（閲覧ページのURL）を貼ってください'));
    box.append(inp, ok, err);
    body.replaceChildren(box);
    if (!rows.length) setTimeout(() => inp.focus(), 50);
  };
  const open = () => {
    const cur = st.rooms[room];
    if (cur && cur.mode === 'tools') return openTools();
    if (cur && cur.mode === 'coc') return openCoc();
    bMode.textContent = 'CoC の判定';
    // 初めての部屋で、画面（チャットパレット・チャット）に CoC の判定の行があれば CoC の判定を出す
    if ((!cur || !cur.url) && !(cur && cur.mode === 'sheet') && COC.parsePalette(screenLines().join('\n')).skills.length) { st.rooms[room] = { ...(cur || {}), mode: 'coc' }; save(st); return openCoc(); }
    if (!cur || !cur.url) {
      title.textContent = 'キャラシを探しています…';
      fetchList().then((list) => {
        listed = list;
        const { bySpeaker, present } = inRoom(list);
        const pick = bySpeaker.length === 1 ? bySpeaker[0] : (present.length === 1 ? present[0] : null);
        if (pick) { st.rooms[room] = { url: clean(pick.url), name: pick.name }; save(st); open(); } else choose();
      });
      return;
    }
    title.textContent = cur.name ? `${cur.name} のキャラシ（帯をつかんで移動／右下で大きさ）` : 'キャラシ';
    const f = el('iframe', 'flex:1;border:0;background:#fff;width:100%');
    f.src = cur.url + '?t=' + Math.floor(Date.now() / 60000); // 公開ページは10分ブラウザに残るので、開くたびに新しい版を読む
    body.replaceChildren(f);
  };
  bMode.onclick = () => { const cur = st.rooms[room] || {}; st.rooms[room] = { ...cur, mode: cur.mode === 'coc' ? 'sheet' : 'coc' }; save(st); open(); };
  bTools.onclick = () => { const cur = st.rooms[room] || {}; st.rooms[room] = { ...cur, mode: cur.mode === 'tools' ? (cur.prev || 'sheet') : 'tools', prev: cur.mode === 'tools' ? cur.prev : (cur.mode || 'sheet') }; save(st); open(); };
  bSwitch.onclick = () => { st.rooms[room] = { ...(st.rooms[room] || {}), mode: 'sheet' }; save(st); fetchList().then((list) => { listed = list; choose(); }); };

  // ===== CoC の判定のつまみ（画面） =====
  // 技能は駒のチャットパレットから読む。ココフォリアの画面の作りは公開されていないので、
  //   ①開いている入力欄（駒の編集のチャットパレット欄など）と画面の文字から CoC の行を拾う「画面から読む」
  //   ②パレットの文を貼る（確実。部屋ごとに覚える）
  // の2つを用意する。①はチャットの記録に出たほかのキャラの行も拾うことがある
  const screenLines = () => {
    const out = [];
    for (const t of document.querySelectorAll('textarea')) { if (t.name === 'text' || t.closest('#stt-sheet')) continue; out.push(...String(t.value || '').split(/\r?\n/)); }
    for (const e of document.querySelectorAll('body *')) { if (e.childElementCount || e.closest('#stt-sheet')) continue; const t = (e.textContent || '').trim(); if (t && t.length <= 80) out.push(t); }
    return out;
  };
  // チャットの記録：判定の結果「(1D100<=n)」を1つだけ含むいちばん大きいかたまりを1つの発言とみる。画面に出ている発言だけ（上へさかのぼると増える）
  const RES1 = /\(1D100<=\d+\)/gi;
  const count = (e) => ((e.textContent || '').match(RES1) || []).length;
  const seenMsgs = new Map();
  const collectChat = (who) => {
    for (const e of document.querySelectorAll('body *')) {
      if (e.closest('#stt-sheet') || count(e) !== 1 || [...e.children].some((c) => count(c) === 1)) continue;
      let box = e;
      for (let i = 0; i < 6 && box.parentElement && box.parentElement !== document.body && count(box.parentElement) === 1; i++) box = box.parentElement;
      const text = box.innerText || box.textContent || '';
      const name = who && text.includes(who) ? who : '';
      seenMsgs.set(text, { name, text });
    }
    return [...seenMsgs.values()];
  };
  const openCoc = () => {
    const cur = (st.rooms[room] ||= { mode: 'coc' }); const c = (cur.coc ||= {});
    const keep = () => save(st);
    title.textContent = 'CoC の判定（押すとそのキャラ名でチャットへ）';
    bMode.textContent = 'キャラシ'; bMode.title = 'シノビガミなどのキャラシに戻す';
    const box = el('div', 'padding:10px;font:13px sans-serif;color:#2a2116;overflow:auto;flex:1'); box.id = 'stt-coc';
    body.replaceChildren(box);
    const input = (v, w, ph) => { const i = el('input', `width:${w};box-sizing:border-box;font:13px sans-serif;padding:3px 5px;border:1px solid #b06a2c;border-radius:5px`); i.value = v ?? ''; i.placeholder = ph || ''; return i; };
    const select = (opts, v) => { const s = el('select', 'font:13px sans-serif;padding:2px;border:1px solid #b06a2c;border-radius:5px'); for (const [val, t] of opts) { const o = el('option', '', t); o.value = val; s.append(o); } s.value = v ?? opts[0][0]; return s; };
    const row = (...xs) => { const r = el('div', 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 6px'); r.append(...xs); return r; };
    const head = (t) => el('p', 'margin:12px 0 6px;font-weight:bold;border-bottom:1px solid #e3cfb0', t);
    const msg = el('p', 'margin:4px 0;font-size:12px;color:#7a6650');
    const who = () => (c.name || (document.querySelector('input[name=name]') || {}).value || '').trim();
    const pal = () => COC.parsePalette(c.palette || '');
    const ed = () => c.ed || pal().edition || '7';
    const go = (text) => { const n = who(); if (!n) { msg.textContent = 'キャラ名を入れてください'; return; } send(text, n); msg.textContent = `送りました：${text}`; };
    const render = () => {
      const p = pal(); const e = ed(); const seven = e !== '6';
      box.replaceChildren();
      // キャラ・版
      const nameIn = input(who(), '11em', 'キャラ名'); nameIn.onchange = () => { c.name = nameIn.value.trim(); keep(); };
      const edSel = select([['', `自動（${p.edition ? (p.edition === '6' ? '6版' : '7版') : '不明→7版'}）`], ['6', '6版（CCB）'], ['7', '7版（CC）'], ['pulp', 'パルプ（7版の書式）']], c.ed || '');
      edSel.onchange = () => { c.ed = edSel.value; keep(); render(); };
      box.append(row(el('span', '', 'キャラ'), nameIn, el('span', '', '版'), edSel));
      if (e === 'pulp') box.append(el('p', 'margin:0 0 6px;font-size:12px;color:#b00', 'パルプは部屋のダイスボットを「パルプ・クトゥルフ」にしてください（コマンドは7版と同じ）'));
      // 修正：7版はボーナス/ペナルティダイスの数を手で選ぶ（火器の状況ごとの修正もここで選ぶ。自動にはしない）。6版は足し引き
      let bonusSel = null, modIn = null;
      if (seven) { bonusSel = select([['2', 'ボーナス2'], ['1', 'ボーナス1'], ['0', 'なし'], ['-1', 'ペナルティ1'], ['-2', 'ペナルティ2']], String(c.bonus || 0)); bonusSel.onchange = () => { c.bonus = Number(bonusSel.value); keep(); }; box.append(row(el('span', '', 'ボーナス/ペナルティ'), bonusSel, el('span', 'font-size:11px;color:#7a6650', '振ったら「なし」に戻る'))); }
      else { modIn = input(c.mod || '', '5em', '±0'); modIn.onchange = () => { c.mod = Number(modIn.value) || 0; keep(); }; box.append(row(el('span', '', '補正（技能値に足す）'), modIn)); }
      box.append(msg);
      // 技能のボタン
      box.append(head(`技能（${p.skills.length}）`));
      const grid = el('div', 'display:flex;flex-wrap:wrap;gap:4px');
      for (const s of p.skills) {
        const b = btn(`${s.name} ${s.value}`); b.style.cssText += ';background:#efe3cf;color:#2a2116;font-size:13px';
        b.onclick = () => { go(COC.buildSkill({ edition: e === '6' ? '6' : '7', value: s.value, name: s.name, bonus: c.bonus || 0, mod: c.mod || 0 })); if (seven && c.bonus) { c.bonus = 0; keep(); bonusSel.value = '0'; } };
        grid.append(b);
      }
      if (!p.skills.length) grid.append(el('span', 'color:#7a6650', '下の「チャットパレット」で技能を読んでください'));
      box.append(grid);
      const nums = p.skills.filter((s) => typeof s.value === 'number');
      const skillSel = (v) => select(nums.map((s, i) => [String(i), `${s.name} ${s.value}`]).concat(nums.length ? [] : [['', '（数値の技能がない）']]), v);
      // 組み合わせ
      box.append(head('組み合わせ（1回振って2つの技能で見る）'));
      const ca = skillSel('0'), cb = skillSel(nums.length > 1 ? '1' : '0'); const bc = btn('振る');
      bc.onclick = () => { try { go(COC.buildCombine({ edition: e === '6' ? '6' : '7', a: nums[ca.value], b: nums[cb.value] })); } catch (er) { msg.textContent = er.message; } };
      box.append(row(ca, el('span', '', '×'), cb, bc));
      // 連射（7版・パルプ）
      if (seven) {
        box.append(head('連射（自動火器・BCDice の FAR）'));
        const f = (c.far ||= {});
        const fs = skillSel(f.skill || '0'); const w = input(f.bullets ?? '', '4em', '弾数'); const y = input(f.broken ?? '', '4em', '故障'); const v = input(f.volley ?? '', '4em', 'ボレー');
        const d = select([['', '最後まで'], ['r', 'レギュラーで終える'], ['h', 'ハードで終える'], ['e', 'イクストリームで終える']], f.stop || '');
        const bf = btn('連射を振る');
        bf.onclick = () => {
          Object.assign(f, { skill: fs.value, bullets: w.value, broken: y.value, volley: v.value, stop: d.value }); keep();
          const s = nums[fs.value];
          try { go(COC.buildFar({ bullets: w.value, skill: s ? s.value : '', broken: y.value, bonus: c.bonus || 0, stop: d.value, volley: v.value, pulp: e === 'pulp', name: s ? s.name : '' })); if (c.bonus) { c.bonus = 0; keep(); bonusSel.value = '0'; } } catch (er) { msg.textContent = er.message; }
        };
        box.append(row(fs, w, y), row(d, ...(e === 'pulp' ? [] : [v, el('span', 'font-size:11px;color:#7a6650', 'ボレー空欄＝技能値÷10')]), bf));
        box.append(el('p', 'margin:0;font-size:11px;color:#7a6650', '状況ごとの修正（距離・連射など）は上のボーナス/ペナルティで手で選ぶ（本で確かめるまで自動にしない）'));
      }
      // 成長の候補
      box.append(head('成長の候補（チャットの記録から）'));
      const gl = el('div', ''); const bg = btn('チャットから拾う', '画面に出ている発言だけを読む。上へさかのぼってから押すと足される');
      bg.onclick = () => {
        const list = COC.extractGrowth(collectChat(who()), { name: who() });
        gl.replaceChildren(...(list.length ? list.map((g) => el('div', `margin:2px 0;color:${g.status === '候補' ? '#2a2116' : '#a05a00'}`, `${g.status === '候補' ? '○ 候補' : '△ 要確認'}　${g.skill}（成功${g.successes}）${g.reasons.length ? '　' + g.reasons.join('／') : ''}`)) : [el('span', 'color:#7a6650', `${who() || 'このキャラ'} の成功した判定は見つかりません（画面に出ている記録だけを読みます）`)]));
      };
      box.append(row(bg, el('span', 'font-size:11px;color:#7a6650', '決めるのは自分で。成功した技能を拾うだけ')), gl);
      // パレットの読み込み
      box.append(head('チャットパレット'));
      const ta = el('textarea', 'width:100%;box-sizing:border-box;height:6em;font:12px monospace;border:1px solid #b06a2c;border-radius:5px'); ta.value = c.palette || ''; ta.placeholder = 'CCB<=65 【目星】\nCC<=50 【図書館】 などを貼る';
      const bRead = btn('貼った文で読む'); bRead.onclick = () => { c.palette = ta.value; keep(); render(); };
      const bScr = btn('画面から読む', '駒の編集のチャットパレット欄などを開いてから押す'); bScr.onclick = () => bScrRead();
      box.append(ta, row(bRead, bScr));
    };
    const bScrRead = () => { const lines = screenLines().filter((l) => COC.parsePalette(l).skills.length); c.palette = [...new Set(lines)].join('\n'); keep(); render(); msg.textContent = `画面から${lines.length}行読みました（ほかのキャラの行が混じったら貼り直してください）`; };
    render();
    if (!c.palette) bScrRead(); // 初めては画面から読んでみる
  };

  // ===== 道具（2026-11-10 作者「@fureno の拡張と同じことを、できるものから」） =====
  // ①パレットを全員分から探す：この部屋にいる共有キャラシ（一覧から）のパレットと、貼ったパレット（NPC など）の行を一度に探し、押すとその名前で送る
  // ②表情（差分）：ココフォリアの「発言の最後に @差分名」で立ち絵が替わる仕組みを使い、チャット欄の文の最後に @名前 を付ける（送るのは自分で）
  // ③通知：タブを見ていないときに新しい発言が出たら、ブラウザの通知とタブの題名で知らせる（自分の名前が出たときだけ、も選べる）
  // どれも押した人の画面だけで動き、部屋のデータは読まない・変えない
  const PAL_LINE = (l) => { const t = String(l || '').trim(); return t && t.length <= 300 && !/^\/\//.test(t) ? t : ''; };
  const sheetPalette = async (url) => { // 共有ページの「const D=…;」からパレット（いまの生命力の状態のもの）を読む
    try { const h = await (await fetch(url + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' })).text(); const m = /const D=(\{[\s\S]*?\});\n/.exec(h); if (!m) return null; const D = JSON.parse(m[1]); return { name: D.name || '', text: (D.palettes && D.palettes[D.startMask || 0]) || '' }; } catch (e) { return null; }
  };
  const openTools = () => {
    bMode.textContent = 'CoC の判定';
    title.textContent = '道具（パレット検索・表情・通知）';
    const cur = (st.rooms[room] ||= {}); const tl = (cur.tools ||= { pals: [], faces: '', notify: false, mention: false });
    const keep = () => save(st);
    const box = el('div', 'padding:10px 12px;font:13px sans-serif;color:#2a2116;overflow:auto;flex:1');
    const head = (t) => el('p', 'margin:10px 0 6px;font-weight:bold;border-bottom:1px solid #e3cfb0', t);
    const msg = el('p', 'margin:4px 0;color:#7a6650;font-size:12px');
    // ① パレット検索
    const q = el('input', 'width:100%;box-sizing:border-box;font:14px sans-serif;padding:6px;border:1px solid #b06a2c;border-radius:6px');
    q.placeholder = '例：感 → 「感知」の行を全員分から（Enter でいちばん上を送る）';
    const res = el('div', 'margin-top:6px');
    let pool = []; // { name, line }
    const rebuild = async () => {
      const out = []; const seen = new Set();
      const list = await fetchList(); const here = inRoom(list).present;
      for (const x of here) { const pal = await sheetPalette(clean(x.url)); if (pal) for (const l of String(pal.text).split(/\r?\n/)) { const t = PAL_LINE(l); if (t && !seen.has(x.name + '\u0000' + t)) { seen.add(x.name + '\u0000' + t); out.push({ name: pal.name || x.name, line: t }); } } }
      for (const pp of tl.pals) for (const l of String(pp.text || '').split(/\r?\n/)) { const t = PAL_LINE(l); if (t && !seen.has(pp.name + '\u0000' + t)) { seen.add(pp.name + '\u0000' + t); out.push({ name: pp.name, line: t }); } }
      pool = out; msg.textContent = `パレット ${new Set(out.map((x) => x.name)).size}人・${out.length}行（共有キャラシ ${here.length}人＋貼ったもの ${tl.pals.length}人）`; draw();
    };
    const hits = () => { const w = q.value.trim(); if (!w) return []; const ws = w.split(/\s+/); return pool.filter((x) => ws.every((k) => (x.name + ' ' + x.line).includes(k))).slice(0, 40); };
    const draw = () => {
      const hs = hits();
      res.replaceChildren(...hs.map((x) => { const b = btn(`${x.name}：${x.line}`); b.style.cssText += ';display:block;width:100%;text-align:left;margin:0 0 4px;padding:6px 8px;font-size:13px;background:#efe3cf;color:#2a2116;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'; b.title = '押すと、この名前で送る'; b.onclick = () => { send(x.line, x.name); msg.textContent = `送りました：${x.name}「${x.line}」`; }; return b; }));
      if (q.value.trim() && !hs.length) res.append(el('p', 'margin:4px 0;color:#7a6650', '見つかりません'));
    };
    q.oninput = draw;
    q.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.isComposing) { const h = hits()[0]; if (h) { send(h.line, h.name); msg.textContent = `送りました：${h.name}「${h.line}」`; } } };
    // 貼ったパレット（共有していないキャラ・NPC）
    const palBox = el('div', '');
    const drawPals = () => {
      palBox.replaceChildren(...tl.pals.map((pp, i) => { const r = el('div', 'display:flex;gap:6px;align-items:center;margin:0 0 4px'); r.append(el('span', 'flex:1', `${pp.name}（${String(pp.text).split(/\r?\n/).filter(PAL_LINE).length}行）`)); const d = btn('外す'); d.onclick = () => { tl.pals.splice(i, 1); keep(); drawPals(); rebuild(); }; r.append(d); return r; }));
    };
    const pn = el('input', 'width:9em;box-sizing:border-box;font:13px sans-serif;padding:4px;border:1px solid #b06a2c;border-radius:5px'); pn.placeholder = '名前';
    const pt = el('textarea', 'width:100%;box-sizing:border-box;height:5em;font:12px monospace;padding:4px;border:1px solid #b06a2c;border-radius:5px;margin-top:4px'); pt.placeholder = '駒のチャットパレットの文を貼る（1行1つ）';
    const pAdd = btn('このパレットを足す'); pAdd.onclick = () => { const n = pn.value.trim(); if (!n || !pt.value.trim()) { msg.textContent = '名前とパレットの文を入れてください'; return; } tl.pals = [...tl.pals.filter((x) => x.name !== n), { name: n.slice(0, 40), text: pt.value.slice(0, 20000) }]; pn.value = ''; pt.value = ''; keep(); drawPals(); rebuild(); };
    pt.onkeydown = (e) => e.stopPropagation(); pn.onkeydown = (e) => e.stopPropagation();
    // ② 表情（差分）
    const DEF_FACES = ['通常', '笑顔', '怒り', '悲しみ', '驚き', '困り'];
    const faceRow = el('div', 'display:flex;flex-wrap:wrap;gap:6px');
    const faceIn = el('input', 'width:100%;box-sizing:border-box;font:13px sans-serif;padding:4px;border:1px solid #b06a2c;border-radius:5px;margin-top:6px'); faceIn.placeholder = '差分の名前を「、」区切りで（空ならツールで作る6つ：通常、笑顔、怒り、悲しみ、驚き、困り）'; faceIn.value = tl.faces || '';
    const faces = () => (tl.faces || '').split(/[、,，\s]+/).map((x) => x.replace(/^@/, '').trim()).filter(Boolean);
    const drawFaces = () => { faceRow.replaceChildren(...(faces().length ? faces() : DEF_FACES).map((f) => { const b = btn('@' + f, 'チャット欄の文の最後に付ける（送るのは自分で）'); b.style.fontSize = '14px'; b.style.padding = '6px 10px'; b.onclick = () => {
      const t = document.querySelector('textarea[name=text]'); if (!t) { msg.textContent = 'チャット欄が見つかりません'; return; }
      const v = t.value.replace(/\s*@[^\s@]+\s*$/, ''); setVal(t, `${v}${v ? ' ' : ''}@${f}`); t.focus(); msg.textContent = `チャット欄の最後に @${f} を付けました。文を書いて送ると立ち絵が替わります`; }; return b; })); };
    faceIn.onkeydown = (e) => e.stopPropagation();
    faceIn.onchange = () => { tl.faces = faceIn.value.slice(0, 400); keep(); drawFaces(); };
    // ③ 通知
    const chk = (label, key) => { const l = el('label', 'display:flex;gap:6px;align-items:center;margin:0 0 4px'); const c = el('input', ''); c.type = 'checkbox'; c.checked = !!tl[key]; c.onchange = async () => { tl[key] = c.checked; keep(); if (key === 'notify' && c.checked && 'Notification' in window && Notification.permission === 'default') { try { await Notification.requestPermission(); } catch (e) { /* 断られてもタブの題名で知らせる */ } } watchNotify(); }; l.append(c, el('span', '', label)); return l; };
    box.append(head('① パレットを全員分から探す'), q, res, msg, el('p', 'margin:8px 0 4px;font-size:12px;color:#7a6650', '共有キャラシのうち、この部屋にいるキャラは自動で入ります。ほかのキャラ（NPC など）は、駒のチャットパレットの文を貼って足してください。'), palBox, pn, pt, pAdd,
      head('② 表情（差分）'), el('p', 'margin:0 0 6px;font-size:12px;color:#7a6650', '押すとチャット欄の最後に「@差分名」が付きます。駒にその名前の差分（立ち絵）があれば、送ったときに立ち絵が替わります。'), faceRow, faceIn,
      head('③ 新しい発言の通知'), chk('タブを見ていないとき、新しい発言を知らせる', 'notify'), chk('自分の名前（発言者の名前）が出たときだけ', 'mention'), el('p', 'margin:0;font-size:12px;color:#7a6650', 'ブラウザの通知を断った場合は、タブの題名に（新着）と出ます。'));
    body.replaceChildren(box);
    drawPals(); drawFaces(); rebuild(); setTimeout(() => q.focus(), 50);
  };
  // 通知の見張り（一度だけ付ける）。チャットの一番下に新しく出た行だけを見る
  const watchNotify = () => {
    if (window.__sttNotify) return; window.__sttNotify = 1;
    const opened = Date.now(); const title0 = document.title; let unread = 0; let last = 0;
    addEventListener('visibilitychange', () => { if (!document.hidden) { unread = 0; document.title = title0; } });
    new MutationObserver((recs) => {
      const tl = (load().rooms?.[room] || {}).tools || {};
      if (!tl.notify || !document.hidden || Date.now() - opened < 1500) return;
      for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || n.closest('#stt-sheet')) continue;
        const text = (n.textContent || '').trim(); if (!text || text.length > 600) continue;
        setTimeout(() => {
          if (!n.isConnected || !isNewestRow(n)) return;
          const me = ((document.querySelector('input[name=name]') || {}).value || '').trim();
          if (tl.mention && !(me && text.includes(me))) return;
          if (Date.now() - last < 1500) return; last = Date.now();
          unread++; document.title = `（新着${unread}）${title0}`;
          try { if ('Notification' in window && Notification.permission === 'granted') new Notification('ココフォリア：新しい発言', { body: text.slice(0, 120), tag: 'stt-ccfolia', renotify: true }); } catch (e) { /* 通知が使えなくても題名で知らせる */ }
        }, 400);
      }
    }).observe(document.body, { childList: true, subtree: true });
  };
  // チャットの行：スクロールする入れ物の中で、いちばん下（次の兄弟が無い）の行
  const isNewestRow = (e) => { let row = e; while (row.parentElement && row.parentElement.childElementCount < 3) row = row.parentElement; if (row.nextElementSibling) return false; for (let x = row.parentElement; x && x !== document.body; x = x.parentElement) { if (/auto|scroll/.test(getComputedStyle(x).overflowY)) return true; } return false; }; // まだ行が少なくスクロールしていない入れ物でも、スクロールできる作りなら行の一覧とみる
  if (((st.rooms[room] || {}).tools || {}).notify) watchNotify();

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
  // 駒のステータスが変わったら（チャットに「[ 連 ] 体術 : 1 → 0」と出る）、窓のキャラシにも伝える。
  // パレット・駒の編集・ほかの人の操作など、窓の外で変わっても窓の生命力・スペシャル・ファンブルが食い違わないようにする。
  // チャットの一番下に新しく出た行だけを見る（上にさかのぼって表示し直した古い行では動かない）
  if (!window.__sttWatch) {
    window.__sttWatch = 1;
    const opened = Date.now();
    const RE = /^\[ (.+?) \] (.+?) : (-?\d+) → (-?\d+)$/;
    const atBottom = (e) => { for (let x = e; x && x !== document.body; x = x.parentElement) { if (x.scrollHeight > x.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(x).overflowY)) return x.scrollTop + x.clientHeight >= x.scrollHeight - 80; } return true; };
    const isNewest = (e) => { let row = e; while (row.parentElement && row.parentElement.childElementCount < 3) row = row.parentElement; return !row.nextElementSibling; };
    new MutationObserver((recs) => {
      if (Date.now() - opened < 1500) return;
      const cur = load().rooms?.[room]; const panel = document.getElementById('stt-sheet'); const f = panel && panel.querySelector('iframe');
      if (!cur || !cur.name || !f) return;
      for (const r of recs) for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || n.closest('#stt-sheet')) continue;
        for (const p of [n, ...n.querySelectorAll('p,span,div')]) {
          if (p.childElementCount) continue;
          const m = RE.exec((p.textContent || '').trim());
          if (!m || m[1] !== cur.name) continue;
          // 出た直後はまだ下までスクロールしていないので、少し待ってから「一番下の新しい行か」を確かめる
          setTimeout(() => { if (p.isConnected && isNewest(p) && atBottom(p)) f.contentWindow.postMessage({ type: 'stt-status', label: m[2], value: Number(m[4]) }, ORIGIN); }, 500);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }
  open();
})();
