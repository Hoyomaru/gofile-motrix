// ==UserScript==
// @name         GoFile → Motrix
// @namespace    gofile-motrix
// @version      0.2.1
// @description  GoFile のページにツールバーを追加し、フォルダ構造を保ったままファイルを Motrix (aria2 RPC) へ送る。gofile-dl の取得処理と gofile-enhanced の UI を土台にしたもの。
// @author       Hoyomaru
// @license      MIT
// @homepageURL  https://github.com/Hoyomaru/gofile-motrix
// @supportURL   https://github.com/Hoyomaru/gofile-motrix/issues
// @downloadURL  https://raw.githubusercontent.com/Hoyomaru/gofile-motrix/main/gofile-motrix.user.js
// @updateURL    https://raw.githubusercontent.com/Hoyomaru/gofile-motrix/main/gofile-motrix.user.js
// @match        https://gofile.io/*
// @icon         https://gofile.io/assets/img/favicon32.png
// @run-at       document-start
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const LOG = '[GoFile→Motrix]';
  const BAR_ID = 'gm-motrix-bar';
  const BANNER_ID = 'gm-motrix-banner';
  const FORM_ID = 'gm-motrix-settings';
  const PAGE_SIZE = 1000;
  const DAY = 86400000;

  // ---------------------------------------------------------------------------
  // FileManager の捕捉（gofile-enhanced と同じ手法）
  // FileManager のコンストラクタが `this.loadSeq = 0` を代入した瞬間に拾う。
  // ページのスクリプトより先に仕掛ける必要があるので document-start で同期的に行う。
  // ---------------------------------------------------------------------------
  let fm = null;
  const pageObject = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window).Object;
  pageObject.defineProperty(pageObject.prototype, 'loadSeq', {
    set(val) {
      pageObject.defineProperty(this, 'loadSeq', { value: val, writable: true, configurable: true, enumerable: true });
      if (this && this.state && this.root && 'selection' in this.state) fm = this;
    },
    get() {
      return undefined;
    },
    configurable: true,
  });

  // ---------------------------------------------------------------------------
  // 仕様変更などの警告バナー（GoFile 側の UI モジュールが使えなくても出せるよう素の DOM で作る）
  // ---------------------------------------------------------------------------
  function showBanner(message, detail) {
    const render = () => {
      document.getElementById(BANNER_ID)?.remove();
      const box = document.createElement('div');
      box.id = BANNER_ID;
      box.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:420px;padding:12px 14px;' +
        'border-radius:12px;background:#2a1215;border:1px solid #f87171;color:#fecaca;' +
        'font:13px/1.6 system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)';
      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;margin-bottom:4px;padding-right:20px';
      title.textContent = `GoFile → Motrix: ${message}`;
      const body = document.createElement('div');
      body.style.cssText = 'color:#fca5a5;word-break:break-all';
      body.textContent = detail || '';
      const close = document.createElement('button');
      close.textContent = '×';
      close.title = '閉じる';
      close.style.cssText = 'position:absolute;top:6px;right:10px;background:none;border:0;color:#fecaca;font-size:18px;cursor:pointer';
      close.onclick = () => box.remove();
      box.append(title, body, close);
      document.body.appendChild(box);
    };
    console.error(LOG, message, detail || '');
    document.body ? render() : document.addEventListener('DOMContentLoaded', render, { once: true });
  }

  // ---------------------------------------------------------------------------
  // 設定
  // ---------------------------------------------------------------------------
  const SETTINGS = {
    rpcUrl: { label: 'RPC アドレス', def: 'http://localhost:16800/jsonrpc', hint: 'Motrix の初期値は http://localhost:16800/jsonrpc' },
    rpcSecret: { label: 'RPC シークレット', def: '', hint: 'Motrix の「詳細設定 → RPC シークレット」', secret: true },
    baseDir: { label: '基準フォルダ', def: '', hint: '空欄なら Motrix の既定の保存先を使う（例: D:/Downloads/GoFile）' },
    includeRoot: { label: '共有フォルダ名のフォルダを作る', def: true },
    autoStart: { label: 'すぐにダウンロードを開始する', def: true },
    stripPrefix: { label: 'フォルダ名の接頭辞を除去（⭐NEW FILES in など）', def: true },
    customPrefixes: { label: '追加で除去する接頭辞（| 区切り）', def: '', hint: '例: [UPDATE] |【新着】' },
    stripEmoji: { label: '絵文字を除去', def: false },
    retentionDays: { label: '送信済み記録の保持日数（0 で無期限）', def: '7', hint: 'これより古い記録は自動で消える' },
  };

  const cfg = {
    get(key) {
      const v = GM_getValue(`cfg.${key}`);
      return v === undefined ? SETTINGS[key].def : v;
    },
    set(key, v) {
      GM_setValue(`cfg.${key}`, v);
    },
  };

  // ---------------------------------------------------------------------------
  // 送信済み記録（gofile-dl の DownloadTracker 相当）
  //   保存形式: { [ファイルID]: [送信時刻, Motrix の GID（確認済みなら 0）, 完了=1/未確認=0] }
  //   ・読み込みは操作ごとに 1 回だけ（reload）。以降はメモリ上の値を使う。
  //   ・保持日数を過ぎた記録は reload 時に削除する。
  // ---------------------------------------------------------------------------
  const history = {
    _c: null,
    reload() {
      let data = GM_getValue('sent2');
      if (!data) {
        // v0.1 形式（{ id: { n, t } }）からの移行
        const old = GM_getValue('sent', {});
        data = {};
        for (const [id, v] of Object.entries(old)) data[id] = [v.t || Date.now(), 0, 0];
        if (Object.keys(old).length) GM_setValue('sent', {});
      }
      const days = Number(cfg.get('retentionDays')) || 0;
      let pruned = 0;
      if (days > 0) {
        const limit = Date.now() - days * DAY;
        for (const [id, e] of Object.entries(data)) if (e[0] < limit) (delete data[id], pruned++);
      }
      this._c = data;
      if (pruned) this.save();
      return this;
    },
    data() {
      return this._c ?? this.reload()._c;
    },
    get(id) {
      return this.data()[id];
    },
    add(items) {
      const d = this.data();
      const t = Date.now();
      for (const it of items) d[it.id] = [t, it.gid || 0, 0];
      this.save();
    },
    remove(ids) {
      const d = this.data();
      for (const id of ids) delete d[id];
      this.save();
    },
    save() {
      GM_setValue('sent2', this._c);
    },
    count() {
      return Object.keys(this.data()).length;
    },
    clear() {
      this._c = {};
      this.save();
    },
  };

  // ---------------------------------------------------------------------------
  // 名前の整形（gofile-dl の sanitize_filename / normalize_folder_name / strip_emojis を移植）
  // ---------------------------------------------------------------------------
  const DEFAULT_PREFIXES = [/^⭐\s*NEW FILES in\s+/i, /^NEW FILES in\s+/i, /^⭐\s*/, /^\*+\s*NEW FILES in\s+/i, /^\*+\s*/];
  const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function sanitize(name, fallback) {
    let s = String(name ?? '');
    if (cfg.get('stripEmoji')) s = s.replace(EMOJI_RE, '').replace(/\s+/g, ' ');
    s = s
      .replace(/[\u0000-\u001f]/g, '')
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/[. ]+$/, '')
      .trim();
    if (RESERVED.test(s)) s = `_${s}`;
    if (s.length > 200) {
      const ext = s.match(/\.[^.]{1,10}$/)?.[0] ?? '';
      s = s.slice(0, 200 - ext.length) + ext;
    }
    return s || fallback;
  }

  function normalizeFolderName(name) {
    let s = String(name ?? '');
    if (cfg.get('stripPrefix')) {
      const custom = String(cfg.get('customPrefixes') || '')
        .split('|')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => new RegExp(`^${escapeRe(p).replace(/\\? /g, '\\s*')}\\s*`, 'i'));
      for (const re of [...custom, ...DEFAULT_PREFIXES]) s = s.replace(re, '');
    }
    return s.trim();
  }

  const folderSeg = (folder) => sanitize(normalizeFolderName(folder.name), `folder_${String(folder.code || folder.id).slice(0, 8)}`);
  const fileName = (file) => sanitize(file.name, `file_${String(file.id).slice(0, 8)}`);

  // 同じ保存先フォルダ内で名前が重なるファイルに " (2)", " (3)" … を付ける。
  // Windows は大文字小文字を区別しないので小文字で比較する。
  function dedupeNames(files) {
    const used = new Map(); // dir -> Set(lowercased names)
    for (const f of files) {
      const dir = f.segs.join('/').toLowerCase();
      if (!used.has(dir)) used.set(dir, new Set());
      const taken = used.get(dir);
      let name = f.name;
      if (taken.has(name.toLowerCase())) {
        const m = name.match(/^(.*?)(\.[^.]{1,10})?$/);
        const stem = m[1] || name;
        const ext = m[2] || '';
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})${ext}`;
        f.renamed = true;
      }
      f.name = name;
      taken.add(name.toLowerCase());
    }
    return files;
  }

  // gofile-dl の parse_content_id 相当。テキストから GoFile のコンテンツ ID を取り出す。
  function parseContentIds(text) {
    const ids = [];
    for (const line of String(text).split(/\r?\n/)) {
      const urls = [...line.matchAll(/gofile\.io\/d\/([^/?#\s]+)/gi)].map((m) => m[1]);
      if (urls.length) ids.push(...urls);
      else if (/^\s*[A-Za-z0-9-]+\s*$/.test(line)) ids.push(line.trim());
    }
    return [...new Set(ids)];
  }

  const escapeHtml = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function formatSize(bytes) {
    if (!bytes) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < u.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  // ---------------------------------------------------------------------------
  // Motrix (aria2 RPC) との通信
  // ---------------------------------------------------------------------------
  function gmPost(url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        timeout: 15000,
        onload: (r) => {
          let json = null;
          try {
            json = JSON.parse(r.responseText);
          } catch {
            /* not json */
          }
          resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json });
        },
        onerror: () => reject(new Error('接続できません（Motrix は起動していますか？）')),
        ontimeout: () => reject(new Error('タイムアウト')),
      });
    });
  }

  async function aria2(method, params = [], { url, secret } = {}) {
    const rpcUrl = url ?? cfg.get('rpcUrl');
    const token = secret ?? cfg.get('rpcSecret');
    const res = await gmPost(rpcUrl, { jsonrpc: '2.0', id: Date.now(), method, params: [`token:${token}`, ...params] });
    if (res.json?.error) throw new Error(`${res.json.error.code}: ${res.json.error.message}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json.result;
  }

  // 送信済み記録を Motrix の実際の状態と突き合わせる（機能 1）。
  // 戻り値: Map<ファイルID, 'complete' | 'active' | 'failed' | 'sent'>
  //   complete … ダウンロード完了
  //   active   … Motrix で待機中・ダウンロード中・一時停止中
  //   failed   … Motrix で失敗した／完了前に削除された（記録から外す）
  //   sent     … 送信済みだが Motrix 側に情報が残っていない（再起動などで消えた）
  async function syncHistory(ids) {
    const result = new Map();
    const check = [];
    for (const id of ids) {
      const e = history.get(id);
      if (!e) continue;
      if (e[2]) result.set(id, 'complete');
      else if (e[1]) check.push([id, e[1]]);
      else result.set(id, 'sent');
    }
    if (!check.length) return result;

    const calls = check.map(([, gid]) => ({
      methodName: 'aria2.tellStatus',
      params: [`token:${cfg.get('rpcSecret')}`, gid, ['status', 'completedLength', 'totalLength']],
    }));
    let replies;
    try {
      // system.multicall 自体はトークンを取らない（各呼び出しの params に入れる）
      const res = await gmPost(cfg.get('rpcUrl'), { jsonrpc: '2.0', id: 'gm-sync', method: 'system.multicall', params: [calls] });
      if (res.json?.error) throw new Error(res.json.error.message);
      if (!res.ok || !Array.isArray(res.json?.result)) throw new Error(`HTTP ${res.status}`);
      replies = res.json.result;
    } catch (e) {
      console.warn(LOG, 'sync skipped', e);
      for (const [id] of check) result.set(id, 'sent');
      return result;
    }

    const d = history.data();
    const failed = [];
    check.forEach(([id], i) => {
      const r = replies[i];
      const st = Array.isArray(r) ? r[0] : null; // 成功は [結果]、失敗は {code, message}
      if (!st) {
        d[id][1] = 0; // GID が消えている。以後は確認しない
        result.set(id, 'sent');
      } else if (st.status === 'complete') {
        d[id] = [d[id][0], 0, 1];
        result.set(id, 'complete');
      } else if (st.status === 'error' || (st.status === 'removed' && st.completedLength !== st.totalLength)) {
        failed.push(id);
        result.set(id, 'failed');
      } else if (st.status === 'removed') {
        d[id] = [d[id][0], 0, 1];
        result.set(id, 'complete');
      } else {
        result.set(id, 'active');
      }
    });
    for (const id of failed) delete d[id];
    history.save();
    return result;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // メイン処理（ページの UI モジュールを読み込んでから動く）
  // ---------------------------------------------------------------------------
  async function start() {
    const mod = (p) =>
      import(new URL(p, location.origin).href).catch((e) => {
        throw new Error(`${p} を読み込めません (${e.message})`);
      });
    const [{ sha256Hex }, { getFolder }, { openMenu }, { popup }, { toast }, pw] = await Promise.all([
      mod('/js/core/sha256.js'),
      mod('/js/services/contents.js'),
      mod('/js/ui/menu.js'),
      mod('/js/ui/popup.js'),
      mod('/js/ui/toast.js'),
      mod('/js/files/passwordStore.js').catch(() => ({})),
    ]);
    const missing = Object.entries({ sha256Hex, getFolder, openMenu, toast, 'popup.open': popup?.open, 'toast.busy': toast?.busy })
      .filter(([, f]) => typeof f !== 'function')
      .map(([k]) => k);
    if (missing.length) throw new Error(`見つからない関数: ${missing.join(', ')}`);

    const getFolderPassword = pw.getFolderPassword ?? (() => undefined);
    const rememberFolderPassword = pw.rememberFolderPassword ?? (() => {});

    const cookieToken = () => document.cookie.match(/(?:^|;\s*)accountToken=([^;]+)/)?.[1];
    const token = () => fm?.state?.account?.token ?? cookieToken();

    // ---- GoFile API（ページの getFolder を使うので wt トークンはページ側が計算する）----

    const childrenOf = (data) => {
      const c = data?.children ?? data?.contents ?? {};
      return Array.isArray(c) ? c : Object.values(c);
    };

    async function getFolderRetry(id, opts) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await getFolder(token(), id, opts);
        } catch (e) {
          // gofile-dl と同様、レート制限・一時エラーは待って再試行
          const retryable = e?.kind === 'rateLimit' || e?.kind === 'transient';
          if (!retryable || attempt >= 3) throw e;
          await sleep(3000 * (attempt + 1));
        }
      }
    }

    // ページングを全部たどって子要素をまとめる
    async function listFolder(id, password) {
      const children = [];
      let data;
      for (let page = 1; ; page++) {
        const res = await getFolderRetry(id, { page, pageSize: PAGE_SIZE, sortField: 'name', sortDirection: 1, password });
        data = res.data;
        if (!data || typeof data !== 'object') throw new Error('GoFile の応答形式が想定と違います');
        if (data.canAccess === false) return { data, locked: true };
        children.push(...childrenOf(data));
        const total = res.metadata?.totalPages;
        if (!total || page >= total) break;
      }
      return { data, children, locked: false };
    }

    function askPassword(folderName, retry) {
      return new Promise((resolve) => {
        popup.open({
          title: `パスワード: ${escapeHtml(folderName)}`,
          size: 'md',
          content: `
            <div class="space-y-3">
              <p class="text-sm text-slate-300">${retry ? 'パスワードが違います。もう一度入力してください。' : 'このフォルダはパスワードで保護されています。'}</p>
              <input type="password" id="gm-pwd" class="input" autocomplete="off" placeholder="パスワード">
            </div>`,
          actions: [
            { label: 'スキップ', variant: 'ghost', onClick: (h) => (h.close(), resolve(null)) },
            { label: 'OK', variant: 'primary', onClick: (h) => { const v = document.getElementById('gm-pwd')?.value ?? ''; h.close(); resolve(v); } },
          ],
        });
        setTimeout(() => document.getElementById('gm-pwd')?.focus(), 50);
      });
    }

    // パスワード付きフォルダを開く。パスワードなし → 保存済み → 親/入力済み → 入力 の順に試す。
    async function openFolder(folder, parentHash, ui) {
      const known = [getFolderPassword(folder.id), getFolderPassword(folder.code), parentHash].filter(Boolean);
      for (const hash of [undefined, ...new Set(known)]) {
        if (hash === undefined && folder.password) continue;
        const r = await listFolder(folder.id, hash);
        if (!r.locked) return { ...r, hash };
      }
      for (let retry = false; ; retry = true) {
        ui.pause();
        const raw = await askPassword(folder.name, retry);
        ui.resume();
        if (raw === null) return null;
        const hash = await sha256Hex(raw);
        const r = await listFolder(folder.id, hash);
        if (!r.locked) {
          rememberFolderPassword([folder.id, folder.code, r.data?.id, r.data?.code].filter(Boolean), hash);
          return { ...r, hash };
        }
      }
    }

    // gofile-dl の execute() の再帰部分に相当。ファイルの一覧（相対パス付き）を作る。
    // fn には { walk, ui, skipped } が渡されるので、起点の決め方だけ呼び出し側で書く。
    async function collect(fn) {
      const files = [];
      const skipped = [];
      let busy = toast.busy({ title: 'ファイル一覧を取得中…' });
      const ui = {
        pause: () => busy.dismiss(),
        resume: () => (busy = toast.busy({ title: 'ファイル一覧を取得中…' })),
        update: (title) => busy.update?.({ title }),
      };

      async function walk(item, segs, parentHash) {
        if (item.type === 'file') {
          if (!item.link) {
            skipped.push(`${[...segs, item.name].join('/')}（リンクなし）`);
            return;
          }
          files.push({ id: item.id, name: fileName(item), rawName: item.name, size: item.size, link: item.link, segs });
          return;
        }
        if (item.type !== 'folder') return;
        const subSegs = [...segs, folderSeg(item)];
        ui.update(`取得中: ${subSegs.join(' / ')}`);
        if (item.childrenCount === 0) return;
        let opened;
        try {
          opened = await openFolder(item, parentHash, ui);
        } catch (e) {
          console.error(LOG, e);
          skipped.push(`${subSegs.join('/')}（取得失敗: ${e.message || e}）`);
          return;
        }
        if (!opened) {
          skipped.push(`${subSegs.join('/')}（パスワード未入力）`);
          return;
        }
        for (const child of opened.children) await walk(child, subSegs, opened.hash);
      }

      try {
        await fn({ walk, ui, skipped });
      } finally {
        busy.dismiss();
      }
      return { files: dedupeNames(files), skipped };
    }

    // ---- 送信 ----

    async function resolveBaseDir() {
      const base = String(cfg.get('baseDir') || '').trim();
      if (base) return base.replace(/[\\/]+$/, '');
      const opt = await aria2('aria2.getGlobalOption');
      return String(opt.dir || '').replace(/[\\/]+$/, '');
    }

    async function sendToMotrix(files, baseDir) {
      const cookie = `accountToken=${token()}`;
      const options = (f) => ({
        dir: [baseDir, ...f.segs].join('/'),
        out: f.name,
        header: [`Cookie: ${cookie}`, 'Referer: https://gofile.io/'],
        'user-agent': navigator.userAgent,
        // 保存先に同名ファイルが既にあれば aria2 側で file.1.ext のように別名にする
        'auto-file-renaming': 'true',
        'allow-overwrite': 'false',
        pause: cfg.get('autoStart') ? 'false' : 'true',
      });
      // JSON-RPC のバッチで一括送信
      const batch = files.map((f, i) => ({
        jsonrpc: '2.0',
        id: `gm${i}`,
        method: 'aria2.addUri',
        params: [`token:${cfg.get('rpcSecret')}`, [f.link], options(f)],
      }));
      const res = await gmPost(cfg.get('rpcUrl'), batch);
      if (!res.ok || !Array.isArray(res.json)) {
        const msg = res.json?.error?.message ?? `HTTP ${res.status}`;
        throw new Error(msg);
      }
      const byId = new Map(res.json.map((r) => [r.id, r]));
      const ok = [];
      const ng = [];
      files.forEach((f, i) => {
        const r = byId.get(`gm${i}`);
        if (r && !r.error) ok.push({ ...f, gid: r.result });
        else ng.push({ f, err: r?.error?.message ?? '応答なし' });
      });
      history.add(ok);
      return { ok, ng };
    }

    // ---- 確認ダイアログ ----

    const BADGE = {
      complete: ['完了', 'text-emerald-300 ring-emerald-500/40', false],
      active: ['Motrix で処理中', 'text-sky-300 ring-sky-500/40', false],
      failed: ['前回失敗', 'text-red-300 ring-red-500/40', true],
      sent: ['送信済み', 'text-amber-300 ring-amber-500/40', false],
    };
    const badge = (text, cls, title = '') =>
      `<span class="shrink-0 rounded-md px-1.5 py-0.5 text-xs ring-1 ${cls}"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</span>`;

    function confirmList(files, skipped, baseDir, states) {
      const sorted = files.slice().sort((a, b) => [...a.segs, a.name].join('/').localeCompare([...b.segs, b.name].join('/'), 'ja'));
      const counts = {};
      const rows = sorted
        .map((f, i) => {
          const st = states.get(f.id);
          if (st) counts[st] = (counts[st] || 0) + 1;
          const checked = !st || BADGE[st][2];
          const path = [...f.segs, f.name].map(escapeHtml).join('<span class="text-slate-500"> / </span>');
          return `
            <label class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-800/30">
              <input type="checkbox" data-gm-file="${i}" ${checked ? 'checked' : ''} class="size-4 shrink-0">
              <span class="min-w-0 flex-1 break-all text-sm text-slate-300">${path}</span>
              ${f.renamed ? badge('名前変更', 'text-sky-300 ring-sky-500/40', `元の名前: ${f.rawName}`) : ''}
              ${st ? badge(BADGE[st][0], BADGE[st][1]) : ''}
              <span class="shrink-0 font-mono text-xs text-slate-500">${formatSize(f.size)}</span>
            </label>`;
        })
        .join('');
      const notes = [
        counts.complete && `ダウンロード完了 ${counts.complete} 件`,
        counts.active && `Motrix で処理中 ${counts.active} 件`,
        counts.sent && `送信済み ${counts.sent} 件`,
      ].filter(Boolean);
      const skippedHtml = skipped.length
        ? `<details class="mb-3 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-slate-300">
             <summary class="cursor-pointer">取得できなかった項目 ${skipped.length} 件</summary>
             <ul class="mt-2 list-disc pl-5">${skipped.map((s) => `<li class="break-all">${escapeHtml(s)}</li>`).join('')}</ul>
           </details>`
        : '';

      return new Promise((resolve) => {
        popup.open({
          title: `Motrix へ送信 (${files.length} 件)`,
          size: '2xl',
          content: `
            <div class="mb-3 rounded-xl border border-sky-500/20 bg-sky-500/10 p-3 text-sm text-slate-300">
              保存先: <span class="break-all font-mono text-sky-300">${escapeHtml(baseDir)}/…</span>
              ${notes.length ? `<div class="mt-1 text-amber-300">${notes.join('、')} はチェックを外しています。</div>` : ''}
              ${counts.failed ? `<div class="mt-1 text-red-300">前回 Motrix で失敗した ${counts.failed} 件は再送信の対象にしています。</div>` : ''}
            </div>
            ${skippedHtml}
            <div class="mb-1.5 flex items-center justify-between rounded-xl bg-slate-900/40 px-2 py-2 text-sm text-slate-300">
              <label class="flex cursor-pointer items-center gap-2"><input type="checkbox" data-gm-all class="size-4"> すべて選択</label>
              <span data-gm-summary class="font-mono text-xs text-slate-400"></span>
            </div>
            <div class="max-h-[55vh] space-y-0.5 overflow-y-auto">${rows}</div>`,
          actions: [
            { label: 'キャンセル', variant: 'ghost', onClick: (h) => (h.close(), resolve(null)) },
            {
              label: '送信',
              variant: 'primary',
              onClick: (h) => {
                const picked = [...document.querySelectorAll('[data-gm-file]:checked')].map((c) => sorted[Number(c.dataset.gmFile)]);
                if (!picked.length) return toast('ファイルが選択されていません', { type: 'warning' });
                h.close();
                resolve(picked);
              },
            },
          ],
        });

        queueMicrotask(() => {
          const all = document.querySelector('[data-gm-all]');
          const boxes = [...document.querySelectorAll('[data-gm-file]')];
          const summary = document.querySelector('[data-gm-summary]');
          const sync = () => {
            const checked = boxes.filter((b) => b.checked);
            const size = checked.reduce((s, b) => s + (sorted[Number(b.dataset.gmFile)].size || 0), 0);
            if (all) all.checked = checked.length === boxes.length;
            if (summary) summary.textContent = `${checked.length} / ${boxes.length} 件 ・ ${formatSize(size) || '0 B'}`;
          };
          all?.addEventListener('change', () => {
            boxes.forEach((b) => (b.checked = all.checked));
            sync();
          });
          boxes.forEach((b) => b.addEventListener('change', sync));
          sync();
        });
      });
    }

    // ---- 共通の流れ：保存先の確認 → 一覧取得 → Motrix と同期 → 確認 → 送信 ----

    async function deliver(gather) {
      if (!token()) return toast('GoFile のアカウント情報を取得できません。ページを再読み込みしてください。', { type: 'error' });

      let baseDir;
      try {
        baseDir = await resolveBaseDir();
      } catch (e) {
        toast(`Motrix に接続できません: ${e.message}`, { type: 'error' });
        return openSettings();
      }
      if (!baseDir) {
        toast('保存先が決まりません。設定で基準フォルダを入力してください。', { type: 'error' });
        return openSettings();
      }

      const { files, skipped } = await collect(gather);
      if (!files.length) {
        return toast(skipped.length ? `取得できたファイルがありません（失敗 ${skipped.length} 件）` : 'ファイルがありません', { type: 'warning' });
      }

      history.reload(); // 別タブでの送信も反映させるため、操作のたびに 1 回だけ読み直す
      const states = await syncHistory(files.map((f) => f.id));

      const picked = await confirmList(files, skipped, baseDir, states);
      if (!picked) return;

      try {
        const { ok, ng } = await sendToMotrix(picked, baseDir);
        if (ok.length) toast(`${ok.length} 件を Motrix へ送信しました`, { type: 'success' });
        for (const { f, err } of ng.slice(0, 5)) toast(`送信失敗: ${f.name} (${err})`, { type: 'error' });
        if (ng.length > 5) toast(`ほか ${ng.length - 5} 件が失敗`, { type: 'error' });
        if (ng.length) console.error(LOG, 'failed', ng);
      } catch (e) {
        console.error(LOG, e);
        toast(`Motrix への送信に失敗しました: ${e.message}`, { type: 'error' });
      }
    }

    // ---- 操作：表示中のフォルダから ----

    function currentChildren() {
      const folder = fm?.state?.folder;
      const list = childrenOf(folder);
      return list.length ? list : fm?.state?.items ?? [];
    }

    async function runCurrent(mode) {
      if (!fm?.state?.folder) return toast('フォルダ情報を読み込めていません。ページを再読み込みしてください。', { type: 'error' });
      const st = fm.state;
      const root = st.folder;
      const rootSegs = st.fileView || !cfg.get('includeRoot') ? [] : [folderSeg(root)];
      const rootHash = getFolderPassword(root.id) ?? getFolderPassword(root.code) ?? getFolderPassword(fm.params?.contentId);

      let entries;
      if (st.fileView) {
        entries = [root];
      } else if (mode === 'selected') {
        const ids = new Set(st.selection || []);
        entries = currentChildren().filter((c) => ids.has(c.id));
        if (!entries.length) return toast('項目が選択されていません', { type: 'warning' });
      }

      await deliver(async ({ walk, skipped }) => {
        if (!entries) {
          // フォルダ全体：表示中のページだけでなく全ページを取り直す
          const r = await listFolder(root.id, rootHash);
          if (r.locked) return skipped.push(`${root.name}（このフォルダのパスワードを先に入力してください）`);
          entries = r.children;
        }
        for (const e of entries) await walk(e, rootSegs, rootHash);
      });
    }

    // ---- 操作：URL を指定して（機能 4）----

    function askUrls() {
      return new Promise((resolve) => {
        popup.open({
          title: 'URL を指定して Motrix へ送る',
          size: '2xl',
          content: `
            <div class="space-y-4">
              <div>
                <label for="gm-urls" class="mb-1.5 block text-xs font-medium text-slate-400">GoFile の URL（1 行に 1 つ。ID だけでも可）</label>
                <textarea id="gm-urls" rows="8" class="input font-mono text-sm" style="height:auto"
                          placeholder="https://gofile.io/d/xxxxxx&#10;https://gofile.io/d/yyyyyy"></textarea>
              </div>
              <div>
                <label for="gm-urls-pwd" class="mb-1.5 block text-xs font-medium text-slate-400">共通のパスワード（任意）</label>
                <input id="gm-urls-pwd" type="password" class="input" autocomplete="off" placeholder="違う場合は個別に聞かれます">
              </div>
            </div>`,
          actions: [
            { label: 'キャンセル', variant: 'ghost', onClick: (h) => (h.close(), resolve(null)) },
            {
              label: '一覧を取得',
              variant: 'primary',
              onClick: (h) => {
                const ids = parseContentIds(document.getElementById('gm-urls')?.value ?? '');
                if (!ids.length) return toast('GoFile の URL が見つかりません', { type: 'warning' });
                const pwd = document.getElementById('gm-urls-pwd')?.value ?? '';
                h.close();
                resolve({ ids, pwd });
              },
            },
          ],
        });
        setTimeout(() => document.getElementById('gm-urls')?.focus(), 50);
      });
    }

    async function runUrls() {
      const input = await askUrls();
      if (!input) return;
      const commonHash = input.pwd ? await sha256Hex(input.pwd) : undefined;

      await deliver(async ({ walk, ui, skipped }) => {
        for (const id of input.ids) {
          ui.update(`取得中: ${id}`);
          try {
            const opened = await openFolder({ id, code: id, name: id }, commonHash, ui);
            if (!opened) {
              skipped.push(`${id}（パスワード未入力）`);
              continue;
            }
            const d = opened.data;
            if (d.type === 'file') {
              await walk(d, [], undefined);
            } else {
              const segs = cfg.get('includeRoot') ? [folderSeg(d)] : [];
              for (const c of opened.children) await walk(c, segs, opened.hash);
            }
          } catch (e) {
            console.error(LOG, id, e);
            skipped.push(`${id}（取得失敗: ${e.message || e}）`);
          }
        }
      });
    }

    // ---- 設定画面 ----

    function settingsHtml() {
      const fields = Object.entries(SETTINGS)
        .map(([key, s]) => {
          const v = cfg.get(key);
          if (typeof s.def === 'boolean') {
            return `
              <label class="flex cursor-pointer items-center gap-2.5 text-sm text-slate-300">
                <input type="checkbox" name="${key}" ${v ? 'checked' : ''} class="size-4"> ${escapeHtml(s.label)}
              </label>`;
          }
          return `
            <div>
              <label for="gm-${key}" class="mb-1.5 block text-xs font-medium text-slate-400">${escapeHtml(s.label)}</label>
              <input id="gm-${key}" name="${key}" type="${s.secret ? 'password' : 'text'}" class="input" autocomplete="off"
                     value="${escapeHtml(v)}" placeholder="${escapeHtml(s.hint ?? '')}">
              ${s.hint ? `<p class="mt-1 text-xs text-slate-500">${escapeHtml(s.hint)}</p>` : ''}
            </div>`;
        })
        .join('');
      const n = history.reload().count();
      const kb = Math.ceil(JSON.stringify(history.data()).length / 1024);
      return `
        <form id="${FORM_ID}" class="space-y-4" onsubmit="return false">
          ${fields}
          <div class="flex gap-2">
            <button type="button" data-gm-act="test" class="flex-1 rounded-lg border border-sky-500 px-3 py-2 text-sky-400 hover:bg-sky-500/10">接続テスト</button>
            <button type="button" data-gm-act="clear" class="flex-1 rounded-lg border border-amber-500 px-3 py-2 text-amber-400 hover:bg-amber-500/10">送信済み記録を消去 (${n} 件・約 ${kb} KB)</button>
          </div>
        </form>`;
    }

    function readForm(form) {
      const out = {};
      for (const [key, s] of Object.entries(SETTINGS)) {
        const el = form.elements[key];
        out[key] = typeof s.def === 'boolean' ? el.checked : el.value.trim();
      }
      return out;
    }

    function openSettings() {
      popup.open({
        title: 'GoFile → Motrix 設定',
        size: '2xl',
        content: settingsHtml(),
        actions: [
          { label: 'キャンセル', variant: 'ghost' },
          {
            label: '保存',
            variant: 'primary',
            onClick: (h) => {
              const v = readForm(document.forms[FORM_ID]);
              if (!/^\d+$/.test(v.retentionDays)) return toast('保持日数は 0 以上の整数で入力してください', { type: 'warning' });
              Object.entries(v).forEach(([k, val]) => cfg.set(k, val));
              history.reload(); // 保持日数の変更をすぐ反映
              toast('設定を保存しました', { type: 'success' });
              h.close();
            },
          },
        ],
      });
      queueMicrotask(() => {
        const form = document.forms[FORM_ID];
        form?.querySelector('[data-gm-act="test"]')?.addEventListener('click', async () => {
          const v = readForm(form);
          try {
            const ver = await aria2('aria2.getVersion', [], { url: v.rpcUrl, secret: v.rpcSecret });
            const opt = await aria2('aria2.getGlobalOption', [], { url: v.rpcUrl, secret: v.rpcSecret });
            toast(`接続成功: aria2 ${ver.version}／Motrix の保存先 ${opt.dir}`, { type: 'success' });
          } catch (e) {
            toast(`接続失敗: ${e.message}`, { type: 'error' });
          }
        });
        form?.querySelector('[data-gm-act="clear"]')?.addEventListener('click', (ev) => {
          history.clear();
          ev.currentTarget.textContent = '送信済み記録を消去 (0 件)';
          toast('送信済み記録を消去しました', { type: 'success' });
        });
      });
    }

    // ---- ツールバー ----

    const ICON = {
      send: '<svg xmlns="http://www.w3.org/2000/svg" class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17V3"/><path d="m6 11 6 6 6-6"/><path d="M19 21H5"/></svg>',
      gear: '<svg xmlns="http://www.w3.org/2000/svg" class="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><circle cx="12" cy="12" r="4"/></svg>',
    };

    function iconButton(icon, label, onClick, withText) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = withText ? 'btn-secondary flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm' : 'icon-btn';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.innerHTML = withText ? `${icon}<span>${escapeHtml(label)}</span>` : icon;
      b.addEventListener('click', onClick);
      return b;
    }

    function buildBar(fileView) {
      const bar = document.createElement('div');
      bar.id = BAR_ID;
      bar.className = 'panel mb-3 px-2 py-1.5 shadow-lg shadow-black/20';
      if (fileView) bar.classList.add('mx-auto', 'max-w-3xl');
      const row = document.createElement('div');
      row.className = 'flex items-center gap-1.5';

      const title = document.createElement('span');
      title.className = 'px-1 text-sm text-slate-400';
      title.textContent = 'GoFile → Motrix';
      const spacer = document.createElement('span');
      spacer.className = 'flex-1';

      const send = iconButton(ICON.send, 'Motrix へ送る', (ev) => {
        const sel = fm?.state?.selection?.size ?? 0;
        openMenu({
          anchor: ev.currentTarget,
          placement: 'bottom-end',
          items: () => [
            { type: 'label', label: 'Motrix へ送る' },
            ...(fileView
              ? [{ label: 'このファイル', icon: 'file', onClick: () => runCurrent('all') }]
              : [
                  { label: `選択した項目${sel ? `（${sel}）` : ''}`, icon: 'list-checks', disabled: !sel, onClick: () => runCurrent('selected') },
                  { label: 'このフォルダ全体', icon: 'folder-tree', onClick: () => runCurrent('all') },
                ]),
            { label: 'URL を指定して…', icon: 'link', onClick: runUrls },
          ],
        });
      }, true);

      row.append(title, spacer, send, iconButton(ICON.gear, '設定', openSettings));
      bar.appendChild(row);
      return bar;
    }

    // FileManager を捕まえられないまま一定時間たったら警告する（機能 2）
    let hookTimer = null;
    let hookWarned = false;
    function watchHook() {
      if (fm || hookWarned || hookTimer || !document.querySelector('#fm-root')) return;
      hookTimer = setTimeout(() => {
        hookTimer = null;
        if (!fm && document.querySelector('#fm-root')) {
          hookWarned = true;
          showBanner(
            'ページのファイル管理部分を取得できません',
            'GoFile の仕様が変わった可能性があります。「URL を指定して送る」（Tampermonkey のメニュー）は使える場合があります。'
          );
        }
      }, 10000);
    }

    function mountBar() {
      watchHook();
      const existing = document.getElementById(BAR_ID);
      const ready = fm && !fm.destroyed && fm.state?.status === 'ready' && fm.root?.isConnected;
      if (!ready) {
        existing?.remove();
        return;
      }
      const fileView = !!fm.state.fileView;
      if (existing && existing.dataset.view === String(fileView)) return;
      existing?.remove();
      const target = fileView ? document.querySelector('#fm-root') : document.querySelector('#fm-toolbar');
      if (!target) return;
      const bar = buildBar(fileView);
      bar.dataset.view = String(fileView);
      fileView ? target.prepend(bar) : target.insertAdjacentElement('beforebegin', bar);
    }

    // Tampermonkey のメニューからも呼べるようにする（フォルダページ以外でも使える）
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('URL を指定して Motrix へ送る', runUrls);
      GM_registerMenuCommand('設定', openSettings);
    }

    new MutationObserver(mountBar).observe(document.documentElement, { childList: true, subtree: true });
    mountBar();
  }

  const boot = () =>
    start().catch((e) =>
      showBanner('起動できませんでした', `GoFile の仕様が変わった可能性があります。詳細: ${e?.message || e}`)
    );
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
