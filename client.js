/**
 * dsh-event-chime — Client half.
 *
 * 事件来自 ctx.uiSession.sessionStatus（running / pendingInteraction / completionUnread
 * 三个事实的合并快照）。每个事件一个音频池：池里有用户导入的音频就洗牌轮换着播，
 * 池空就播内置的 Web Audio 合成音——所以还没录任何音频时，事件层就能先验证。
 *
 * 音频文件存在 IndexedDB（blob），设置存在 localStorage。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-event-chime',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var react = require('react');
    var h = react.createElement;

    var name = '@local/dsh-event-chime';
    // 只订阅确实存在的服务：注入不存在的服务会永久 pending，让整个 dsh web 启动审计失败。
    var inject = [];

    /* ───────────────────────── 事件表 ───────────────────────── */

    var EVENTS = [
      { id: 'completed',    label: '回合完成',     hint: '当前对话的一轮回答结束' },
      { id: 'completed-bg', label: '后台会话完成', hint: '你切走的会话跑完了' },
      { id: 'approval',     label: '需要授权',     hint: '等你批准一个工具调用' },
      { id: 'question',     label: '需要回答',     hint: 'Agent 向你提问' },
      { id: 'plan-review',  label: '计划评审',     hint: '等你审阅计划' },
      { id: 'stalled',      label: '卡住',         hint: '运行超时没有输出' }
    ];

    /* ───────────────────── 内置兜底音（Web Audio） ───────────────────── */

    var PATTERNS = {
      'completed':    { wave: 'sine',     notes: [[880, 0.09], [1320, 0.16]], gain: 0.42 },
      'completed-bg': { wave: 'sine',     notes: [[740, 0.09], [988, 0.16]],  gain: 0.42 },
      'approval':     { wave: 'triangle', notes: [[520, 0.12], [520, 0.12], [440, 0.20]], gain: 0.38 },
      'question':     { wave: 'sine',     notes: [[660, 0.10], [880, 0.10], [1100, 0.18]], gain: 0.40 },
      'plan-review':  { wave: 'sine',     notes: [[600, 0.10], [900, 0.10], [1200, 0.22]], gain: 0.40 },
      'stalled':      { wave: 'square',   notes: [[300, 0.10], [300, 0.10]], gain: 0.26 }
    };

    /* ───────────────────────── 设置 ───────────────────────── */

    var STORE_KEY = 'dsh-event-chime.v1';

    function defaultPools() {
      var o = {};
      for (var i = 0; i < EVENTS.length; i++) o[EVENTS[i].id] = { enabled: EVENTS[i].id !== 'stalled' };
      return o;
    }

    var DEFAULTS = {
      enabled: true,
      volume: 0.7,
      mode: 'shuffle',
      stallMs: 0,
      dndEnabled: false,
      dndStart: 23,
      dndEnd: 7,
      includeBuiltin: true,
      pools: defaultPools()
    };

    function mergeSettings(base, over) {
      var out = {};
      var k;
      for (k in base) {
        var b = base[k];
        var o = over ? over[k] : undefined;
        if (b && typeof b === 'object' && !Array.isArray(b)) out[k] = mergeSettings(b, o || {});
        else out[k] = (o === undefined ? b : o);
      }
      if (over) for (k in over) if (!(k in out)) out[k] = over[k];
      return out;
    }

    var settings = mergeSettings(DEFAULTS, null);
    try {
      var rawSettings = localStorage.getItem(STORE_KEY);
      if (rawSettings) settings = mergeSettings(DEFAULTS, JSON.parse(rawSettings));
    } catch (e) {}

    var settingsVersion = 0;
    var settingsListeners = new Set();

    function subscribeSettings(fn) {
      settingsListeners.add(fn);
      return function () { settingsListeners.delete(fn); };
    }
    function getSettingsVersion() { return settingsVersion; }
    function notifySettings() {
      settingsVersion += 1;
      settingsListeners.forEach(function (fn) { try { fn(); } catch (e) {} });
    }
    function persistSettings() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) {}
      notifySettings();
    }
    function updateSettings(patch) {
      settings = mergeSettings(settings, patch);
      persistSettings();
    }
    function updatePool(id, patch) {
      var wrap = { pools: {} };
      wrap.pools[id] = patch;
      updateSettings(wrap);
    }

    /* ─────────────────── 音频条目（IndexedDB） ─────────────────── */

    var DB_NAME = 'dsh-event-chime';
    var DB_VERSION = 1;
    var entries = [];
    /** 随插件分发的音频包：event -> [{ id:'b:event/file', name, url, builtin:true }] */
    var builtin = new Map();

    function openDB() {
      return new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' });
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    }

    function loadEntries() {
      return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('audio', 'readonly');
          var req = tx.objectStore('audio').getAll();
          req.onsuccess = function () {
            entries = (req.result || []).sort(function (a, b) { return (a.added || 0) - (b.added || 0); });
            db.close();
            resolve(entries);
          };
          req.onerror = function () { db.close(); reject(req.error); };
        });
      }).catch(function () {});
    }

    function putEntry(rec) {
      return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('audio', 'readwrite');
          tx.objectStore('audio').put(rec);
          tx.oncomplete = function () { db.close(); resolve(); };
          tx.onerror = function () { db.close(); reject(tx.error); };
        });
      });
    }

    function deleteEntry(id) {
      return openDB().then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction('audio', 'readwrite');
          tx.objectStore('audio').delete(id);
          tx.oncomplete = function () { db.close(); resolve(); };
          tx.onerror = function () { db.close(); reject(tx.error); };
        });
      });
    }

    function userEntriesOf(event) {
      return entries.filter(function (e) { return e.event === event && !e.builtin; });
    }

    function entriesOf(event) {
      var list = userEntriesOf(event);
      if (settings.includeBuiltin === false) return list;
      var pack = builtin.get(event);
      return pack && pack.length ? pack.concat(list) : list;
    }

    /** 内置包来自 Host 的 /dsh-event-chime/audio.json；没有包就静默退回合成音。 */
    function loadBuiltin() {
      return fetch('/dsh-event-chime/audio.json', { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          var next = new Map();
          var events = (data && data.events) || {};
          Object.keys(events).forEach(function (ev) {
            var files = events[ev] || [];
            if (!files.length) return;
            next.set(ev, files.map(function (file) {
              return {
                id: 'b:' + ev + '/' + file,
                event: ev,
                name: file,
                size: 0,
                url: '/dsh-event-chime/audio/' + encodeURIComponent(ev) + '/' + encodeURIComponent(file),
                builtin: true
              };
            }));
          });
          builtin = next;
          notifySettings();
        })
        .catch(function () {});
    }

    /* ───────────────────────── 播放 ───────────────────────── */

    var audioCtx = null;

    function getCtx() {
      if (audioCtx) return audioCtx;
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { audioCtx = new C(); } catch (e) { audioCtx = null; }
      return audioCtx;
    }

    var queue = [];
    var playing = false;

    function enqueue(task) {
      queue.push(task);
      if (queue.length > 6) queue.splice(0, queue.length - 6);
      pump();
    }

    function pump() {
      if (playing) return;
      var task = queue.shift();
      if (!task) return;
      playing = true;
      var released = false;
      var watchdog = setTimeout(function () { release(); }, 15000);
      function release() {
        if (released) return;
        released = true;
        clearTimeout(watchdog);
        playing = false;
        setTimeout(pump, 60);
      }
      try { task(release); } catch (e) { release(); }
    }

    function playPattern(pattern, release) {
      var ctx = getCtx();
      if (!ctx || !pattern) { release(); return; }
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      var t = ctx.currentTime + 0.02;
      var total = 0;
      for (var i = 0; i < pattern.notes.length; i++) {
        var note = pattern.notes[i];
        var osc = ctx.createOscillator();
        var g = ctx.createGain();
        osc.type = pattern.wave || 'sine';
        osc.frequency.value = note[0];
        var dur = note[1];
        var peak = (pattern.gain === undefined ? 0.4 : pattern.gain) * Math.max(0.05, settings.volume);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g);
        g.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.03);
        t += dur;
        total += dur;
      }
      setTimeout(release, (total + 0.15) * 1000);
    }

    function playUrl(url, release, revoke) {
      var el;
      try { el = new Audio(url); } catch (e) { if (revoke) { try { URL.revokeObjectURL(url); } catch (e2) {} } release(); return; }
      el.volume = Math.min(1, Math.max(0, settings.volume));
      var settled = false;
      function finish() {
        if (settled) return;
        settled = true;
        if (revoke) { try { URL.revokeObjectURL(url); } catch (e) {} }
        release();
      }
      el.onended = finish;
      el.onerror = finish;
      try { el.play().catch(finish); } catch (e) { finish(); }
    }

    function playEntry(entry, release) {
      if (entry && entry.builtin) { playUrl(entry.url, release, false); return; }
      var url;
      try { url = URL.createObjectURL(entry.blob); } catch (e) { release(); return; }
      playUrl(url, release, true);
    }

    /* ───────────────────── 导出（store-only zip） ───────────────────── */

    function saveBlob(blob, name) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { try { a.remove(); } catch (e) {} URL.revokeObjectURL(url); }, 60000);
    }

    function stamp() {
      var d = new Date();
      function p(n) { return (n < 10 ? '0' : '') + n; }
      return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }

    function safeFile(name) {
      var s = String(name || 'clip');
      var BS = String.fromCharCode(92);
      if (s.indexOf(BS) >= 0) s = s.split(BS).join('_');
      return s.replace(/[\/:*?"<>|]+/g, '_').slice(0, 80) || 'clip';
    }

    var CRC_TABLE = null;
    function crc32(buf) {
      if (!CRC_TABLE) {
        CRC_TABLE = new Int32Array(256);
        for (var n = 0; n < 256; n++) {
          var c = n;
          for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
          CRC_TABLE[n] = c;
        }
      }
      var crc = -1;
      for (var i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
      return (crc ^ -1) >>> 0;
    }

    /** files: [{ name, data: Uint8Array }] → Blob，目录结构写在 name 里。 */
    function buildZip(files) {
      var enc = new TextEncoder();
      var d = new Date();
      var dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
      var dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
      var chunks = [];
      var central = [];
      var offset = 0;

      files.forEach(function (item) {
        var name = enc.encode(item.name);
        var data = item.data;
        var crc = crc32(data);

        var head = new Uint8Array(30 + name.length);
        var hv = new DataView(head.buffer);
        hv.setUint32(0, 0x04034b50, true);
        hv.setUint16(4, 20, true);
        hv.setUint16(6, 0x0800, true);
        hv.setUint16(8, 0, true);
        hv.setUint16(10, dosTime, true);
        hv.setUint16(12, dosDate, true);
        hv.setUint32(14, crc, true);
        hv.setUint32(18, data.length, true);
        hv.setUint32(22, data.length, true);
        hv.setUint16(26, name.length, true);
        hv.setUint16(28, 0, true);
        head.set(name, 30);
        chunks.push(head, data);

        var cd = new Uint8Array(46 + name.length);
        var cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, dosTime, true);
        cv.setUint16(14, dosDate, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        cd.set(name, 46);
        central.push(cd);

        offset += head.length + data.length;
      });

      var cdSize = central.reduce(function (a, c) { return a + c.length; }, 0);
      var end = new Uint8Array(22);
      var ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, files.length, true);
      ev.setUint16(10, files.length, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, offset, true);

      return new Blob(chunks.concat(central).concat([end]), { type: 'application/zip' });
    }

    /* ───────────────────── 洗牌轮换（shuffle bag） ───────────────────── */

    var bag = {};

    function shuffleInPlace(a) {
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }

    function nextEntry(event) {
      var pool = entriesOf(event);
      if (!pool.length) return null;
      var mode = settings.mode || 'shuffle';
      var st = bag[event];
      var key = pool.map(function (e) { return e.id; }).join('|');

      if (mode === 'random') {
        var pick = pool[Math.floor(Math.random() * pool.length)];
        if (pool.length > 1 && st && st.last === pick.id) {
          var others = pool.filter(function (e) { return e.id !== st.last; });
          pick = others[Math.floor(Math.random() * others.length)];
        }
        bag[event] = { key: key, last: pick.id, order: [], pos: 0 };
        return pick;
      }

      if (mode === 'sequential') {
        if (!st || st.key !== key) st = bag[event] = { key: key, order: [], pos: 0, last: null };
        var seq = pool[st.pos % pool.length];
        st.pos = (st.pos + 1) % pool.length;
        st.last = seq.id;
        return seq;
      }

      if (!st || st.key !== key || st.pos >= st.order.length) {
        var ids = shuffleInPlace(pool.map(function (e) { return e.id; }));
        if (ids.length > 1 && st && st.last && ids[0] === st.last) {
          var k = 1;
          while (k < ids.length && ids[k] === st.last) k++;
          if (k < ids.length) { var tmp = ids[0]; ids[0] = ids[k]; ids[k] = tmp; }
        }
        st = bag[event] = { key: key, order: ids, pos: 0, last: null };
      }
      var chosen = st.order[st.pos++];
      st.last = chosen;
      for (var m = 0; m < pool.length; m++) if (pool[m].id === chosen) return pool[m];
      return null;
    }

    /* ───────────────────────── 触发 ───────────────────────── */

    var eventLog = [];

    function pushLog(event, detail) {
      eventLog.unshift({ at: Date.now(), event: event, detail: detail || '' });
      if (eventLog.length > 12) eventLog.pop();
      notifySettings();
    }

    function inDnd() {
      if (!settings.dndEnabled) return false;
      var hr = new Date().getHours();
      var s = Number(settings.dndStart);
      var e = Number(settings.dndEnd);
      if (s === e) return false;
      return s < e ? (hr >= s && hr < e) : (hr >= s || hr < e);
    }

    function fire(event, detail) {
      var cfg = settings.pools[event];
      if (!settings.enabled || !cfg || cfg.enabled === false) return;
      if (inDnd()) { pushLog(event, '免打扰'); return; }
      var entry = nextEntry(event);
      if (entry) {
        enqueue(function (r) { playEntry(entry, r); });
        pushLog(event, entry.name);
      } else {
        var pattern = PATTERNS[event];
        if (pattern) enqueue(function (r) { playPattern(pattern, r); });
        pushLog(event, '内置音');
      }
    }

    /* ─────────────────── 订阅 sessionStatus ─────────────────── */

    function startWatch(scope) {
      var ui = scope.get('uiSession');
      var sessions = scope.get('sessions');
      if (!ui || !ui.sessionStatus) return function () {};

      var status = ui.sessionStatus;
      var prev = new Map();
      var runStart = new Map();
      var stallFired = new Set();

      function isMain(id) {
        try {
          var row = sessions.list.getSnapshot().byId[id];
          return !!(row && row.retainedBy && (row.retainedBy.mainView || 0) > 0);
        } catch (e) { return false; }
      }

      function tick() {
        var snap;
        try { snap = status.getSnapshot(); } catch (e) { return; }
        snap.forEach(function (cur, id) {
          var before = prev.get(id) || {};

          if (before.running === true && cur.running !== true) {
            if (cur.completionUnread) fire('completed-bg', id);
            else if (isMain(id)) fire('completed', id);
          }

          var pi = cur.pendingInteraction;
          if (pi && pi !== before.pendingInteraction) {
            var kind = pi.kind;
            fire(kind === 'approval' ? 'approval' : (kind === 'plan-review' ? 'plan-review' : 'question'), id);
          }

          if (cur.running === true) {
            if (!runStart.has(id)) { runStart.set(id, Date.now()); stallFired.delete(id); }
          } else {
            runStart.delete(id);
            stallFired.delete(id);
          }
        });
        prev = new Map(snap);
      }

      var off = status.subscribe(tick);
      tick();

      var timer = setInterval(function () {
        var ms = Number(settings.stallMs) || 0;
        if (ms <= 0) return;
        var now = Date.now();
        runStart.forEach(function (at, id) {
          if (now - at >= ms && !stallFired.has(id)) {
            stallFired.add(id);
            fire('stalled', id);
          }
        });
      }, 10000);

      return function () {
        try { off(); } catch (e) {}
        clearInterval(timer);
      };
    }

    /* ───────────────────────── 设置面板 ───────────────────────── */

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function fmtTime(ms) {
      var d = new Date(ms);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
    }
    function fmtSize(n) {
      if (n < 1024) return n + ' B';
      if (n < 1048576) return Math.round(n / 1024) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    }

    var CSS = [
      '.ec-wrap{display:flex;flex-direction:column;gap:14px}',
      '.ec-top{display:flex;flex-wrap:wrap;gap:14px;align-items:center;font-size:12.5px}',
      '.ec-top label{display:flex;align-items:center;gap:6px}',
      '.ec-row{border:1px solid rgba(127,127,127,.25);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.ec-row-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.ec-name{display:flex;align-items:center;gap:6px;font-weight:600;font-size:13px;min-width:118px}',
      '.ec-hint{font-size:12px;opacity:.6;flex:1;min-width:150px}',
      '.ec-actions{display:flex;gap:6px}',
      '.ec-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;cursor:pointer}',
      '.ec-btn:hover{background:rgba(127,127,127,.14)}',
      '.ec-danger{color:#d9534f;border-color:rgba(217,83,79,.5)}',
      '.ec-pool{display:flex;flex-wrap:wrap;gap:6px}',
      '.ec-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:2px 6px 2px 9px;border-radius:999px;background:rgba(127,127,127,.16)}',
      '.ec-chip-name{cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:190px}',
      '.ec-chip-name:hover{text-decoration:underline}',
      '.ec-chip-x{cursor:pointer;opacity:.55;padding:0 2px}',
      '.ec-chip-x:hover{opacity:1;color:#d9534f}',
      '.ec-empty{font-size:12px;opacity:.55}',
      '.ec-chip-builtin{border:1px dashed rgba(77,107,254,.55);background:rgba(77,107,254,.08)}',
      '.ec-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:4px;border-top:1px solid rgba(127,127,127,.18)}',
      '.ec-foot-hint{font-size:11.5px;opacity:.6}',
      '.ec-log{font-size:11.5px;font-family:ui-monospace,Consolas,monospace;opacity:.75;display:flex;flex-direction:column;gap:2px;max-height:132px;overflow:auto}',
      '.ec-section{font-size:12px;font-weight:600;opacity:.75;margin-top:2px}'
    ].join('\n');

    function SettingsPanel() {
      react.useSyncExternalStore(subscribeSettings, getSettingsVersion);
      var fileRef = react.useRef(null);
      var pendingEvent = react.useRef(null);

      function pickFile(eventId) {
        pendingEvent.current = eventId;
        if (fileRef.current) fileRef.current.click();
      }

      function onFiles(ev) {
        var eventId = pendingEvent.current;
        var files = Array.prototype.slice.call(ev.target.files || []);
        ev.target.value = '';
        pendingEvent.current = null;
        if (!eventId || !files.length) return;
        var chain = Promise.resolve();
        files.forEach(function (file) {
          chain = chain.then(function () {
            var id = 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            var rec = {
              id: id, event: eventId, name: file.name, type: file.type || '',
              size: file.size, added: Date.now(), blob: file
            };
            return putEntry(rec).then(function () { entries.push(rec); });
          });
        });
        chain.then(function () {
          entries.sort(function (a, b) { return (a.added || 0) - (b.added || 0); });
          notifySettings();
        });
      }

      function removeEntry(id) {
        if (String(id).slice(0, 2) === 'b:') return;
        deleteEntry(id).then(function () {
          entries = entries.filter(function (e) { return e.id !== id; });
          notifySettings();
        });
      }

      function clearPool(eventId) {
        var victims = userEntriesOf(eventId);
        var chain = Promise.resolve();
        victims.forEach(function (v) { chain = chain.then(function () { return deleteEntry(v.id); }); });
        chain.then(function () {
          entries = entries.filter(function (e) { return e.event !== eventId; });
          notifySettings();
        });
      }

      /** 把本机导入的音频打包成 zip，内部就是 audio/<事件>/<文件名> 的仓库结构。 */
      function exportAll(btn) {
        var user = entries.slice();
        if (!user.length) {
          if (btn) btn.textContent = '本机还没有导入音频';
          return;
        }
        if (btn) { btn.disabled = true; btn.textContent = '打包中…'; }
        var jobs = user.map(function (e) {
          return e.blob.arrayBuffer().then(function (buf) {
            return { name: 'audio/' + e.event + '/' + safeFile(e.name), data: new Uint8Array(buf) };
          });
        });
        Promise.all(jobs).then(function (files) {
          saveBlob(buildZip(files), 'dsh-event-chime-audio-' + stamp() + '.zip');
          if (btn) { btn.disabled = false; btn.textContent = '导出全部音频（zip）'; }
        }).catch(function () {
          if (btn) { btn.disabled = false; btn.textContent = '导出失败，重试'; }
        });
      }

      function preview(eventId) {
        var entry = nextEntry(eventId);
        if (entry) enqueue(function (r) { playEntry(entry, r); });
        else {
          var pattern = PATTERNS[eventId];
          if (pattern) enqueue(function (r) { playPattern(pattern, r); });
        }
      }

      var rows = EVENTS.map(function (ev) {
        var cfg = settings.pools[ev.id] || { enabled: true };
        var pool = entriesOf(ev.id);
        return h('div', { className: 'ec-row', key: ev.id }, [
          h('div', { className: 'ec-row-head', key: 'head' }, [
            h('label', { className: 'ec-name', key: 'name' }, [
              h('input', {
                type: 'checkbox', checked: cfg.enabled !== false,
                onChange: function (e) { updatePool(ev.id, { enabled: e.target.checked }); }
              }),
              h('span', null, ev.label)
            ]),
            h('span', { className: 'ec-hint', key: 'hint' }, ev.hint),
            h('div', { className: 'ec-actions', key: 'act' }, [
              h('button', { className: 'ec-btn', key: 'p', onClick: function () { preview(ev.id); } }, '试听'),
              h('button', { className: 'ec-btn', key: 'i', onClick: function () { pickFile(ev.id); } }, '导入'),
              pool.length ? h('button', { className: 'ec-btn ec-danger', key: 'c', onClick: function () { clearPool(ev.id); } }, '清空') : null
            ])
          ]),
          h('div', { className: 'ec-pool', key: 'pool' },
            pool.length
              ? pool.map(function (en) {
                  var title = en.builtin ? ('内置 · ' + en.name) : (en.name + ' · ' + fmtSize(en.size));
                  return h('span', { className: 'ec-chip' + (en.builtin ? ' ec-chip-builtin' : ''), key: en.id, title: title }, [
                    h('span', { className: 'ec-chip-name', key: 'n', onClick: function () { enqueue(function (r) { playEntry(en, r); }); } }, en.name),
                    en.builtin ? null : h('span', { className: 'ec-chip-x', key: 'x', onClick: function () { removeEntry(en.id); } }, '\u00d7')
                  ]);
                })
              : h('span', { className: 'ec-empty', key: 'empty' }, '空池 → 播内置音')
          )
        ]);
      });

      var logLines = eventLog.map(function (item, i) {
        return h('div', { key: String(item.at) + i }, fmtTime(item.at) + '  ' + item.event + '  ' + item.detail);
      });

      return h('div', { className: 'ec-wrap' }, [
        h('style', { key: 'style' }, CSS),
        h('input', {
          key: 'file', type: 'file', accept: 'audio/*', multiple: true,
          style: { display: 'none' }, ref: fileRef, onChange: onFiles
        }),
        h('div', { className: 'ec-top', key: 'top' }, [
          h('label', { key: 'en' }, [
            h('input', {
              type: 'checkbox', checked: settings.enabled !== false,
              onChange: function (e) { updateSettings({ enabled: e.target.checked }); }
            }),
            h('span', null, '开启提示音')
          ]),
          h('label', { key: 'vol' }, [
            h('span', null, '音量'),
            h('input', {
              type: 'range', min: '0', max: '1', step: '0.05', value: String(settings.volume),
              onChange: function (e) { updateSettings({ volume: Number(e.target.value) }); }
            })
          ]),
          h('label', { key: 'mode' }, [
            h('span', null, '轮换'),
            h('select', {
              value: settings.mode || 'shuffle',
              onChange: function (e) { updateSettings({ mode: e.target.value }); }
            }, [
              h('option', { key: 's', value: 'shuffle' }, '洗牌轮换'),
              h('option', { key: 'r', value: 'random' }, '纯随机'),
              h('option', { key: 'q', value: 'sequential' }, '顺序')
            ])
          ]),
          h('label', { key: 'dnd' }, [
            h('input', {
              type: 'checkbox', checked: settings.dndEnabled === true,
              onChange: function (e) { updateSettings({ dndEnabled: e.target.checked }); }
            }),
            h('span', null, '免打扰'),
            h('input', {
              type: 'number', min: '0', max: '23', value: String(settings.dndStart),
              style: { width: '52px' },
              onChange: function (e) { updateSettings({ dndStart: Number(e.target.value) }); }
            }),
            h('span', null, '→'),
            h('input', {
              type: 'number', min: '0', max: '23', value: String(settings.dndEnd),
              style: { width: '52px' },
              onChange: function (e) { updateSettings({ dndEnd: Number(e.target.value) }); }
            }),
            h('span', null, '时')
          ]),
          h('label', { key: 'stall' }, [
            h('span', null, '卡住阈值'),
            h('input', {
              type: 'number', min: '0', step: '30', value: String(settings.stallMs),
              style: { width: '72px' },
              onChange: function (e) { updateSettings({ stallMs: Number(e.target.value) }); }
            }),
            h('span', null, '毫秒（0 = 关闭）')
          ]),
          h('label', { key: 'bi' }, [
            h('input', {
              type: 'checkbox', checked: settings.includeBuiltin !== false,
              onChange: function (e) { updateSettings({ includeBuiltin: e.target.checked }); }
            }),
            h('span', null, '混入内置音频包')
          ])
        ])
      ].concat(rows).concat([
        h('div', { className: 'ec-section', key: 'logtitle' }, '最近事件（用于验证事件层接得对不对）'),
        h('div', { className: 'ec-log', key: 'log' }, logLines.length ? logLines : [h('div', { key: 'none' }, '（还没有触发过）')]),
        h('div', { className: 'ec-foot', key: 'foot' }, [
          h('button', { className: 'ec-btn', key: 'exp', onClick: function () { exportAll(this); } }, '导出全部音频（zip）'),
          h('span', { className: 'ec-foot-hint', key: 'hint' }, '导出的 zip 里就是 audio/<事件>/<文件名>，解压即仓库结构。')
        ])
      ]));
    }

    /* ───────────────────────── apply ───────────────────────── */

    function apply(ctx) {
      ctx.inject(['uiSession', 'sessions'], function (scope) {
        var off = startWatch(scope);
        scope.effect(function () { return off; }, 'dsh-event-chime: session status watcher');
      });

      ctx.inject(['slots'], function (scope) {
        var slots = scope.get('slots');
        if (!slots) return;
        scope.effect(function () {
          return slots.inject('settings.section', function () {
            return slots.register(
              { name: 'settings.section', id: 'dsh-event-chime', order: 46, label: function () { return '事件提示音'; } },
              function (props) { return h(SettingsPanel, props); }
            );
          });
        }, 'dsh-event-chime: settings section');
      });

      ctx.effect(function () {
        loadBuiltin();
        return function () {};
      }, 'dsh-event-chime: builtin audio pack');

      ctx.effect(function () {
        var unlock = function () {
          var c = getCtx();
          if (c && c.state === 'suspended') { try { c.resume(); } catch (e) {} }
        };
        try {
          window.addEventListener('pointerdown', unlock);
          window.addEventListener('keydown', unlock);
        } catch (e) {}
        return function () {
          try {
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
          } catch (e) {}
        };
      }, 'dsh-event-chime: audio unlock');

      ctx.effect(function () {
        loadEntries().then(function () { notifySettings(); });
        return function () {};
      }, 'dsh-event-chime: hydrate audio pool');
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
