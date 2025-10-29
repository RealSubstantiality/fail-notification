// Fail Notification v1.06 — 使用 generate_interceptor 武装一轮生成；仅在失败/无内容时蜂鸣。
// 不依赖事件总线；仅勾住 fetch / XHR；默认无日志、无 WS/DOM 兜底，尽量零误报。
// Alt+Shift+B 手动自检蜂鸣。

(() => {
  const CFG = {
    armMs: 20000,     // 每次“武装”窗口（由拦截器触发）
    debug: false,     // 需要调试时改 true（会少量打印）
  };
  const log  = (...a) => { if (CFG.debug) console.log("[fail-ding]", ...a); };
  const warn = (...a) => { if (CFG.debug) console.warn("[fail-ding]", ...a); };

  // ——— 音频 ———
// —— 用文件播放的音频实现 ——
// 确保 fail.mp3 和本文件在同一目录
const FAIL_URL = new URL('./fail.mp3', import.meta.url).href;

let audioCtx, lastBeep = 0, failBuffer = null;

function ensureAudio() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// 预加载并解码声音，降低播放延迟
async function preloadFailSound() {
  try {
    const res = await fetch(FAIL_URL);
    const arr = await res.arrayBuffer();
    ensureAudio();
    failBuffer = await audioCtx.decodeAudioData(arr);
  } catch (_) {
    // 解码失败会在播放时降级用 <audio>
  }
}

// 失败时播放：优先用解码后的 buffer，失败就降级 <audio>
function beep() {
  const now = Date.now();
  if (now - lastBeep < 400) return; // 防抖
  lastBeep = now;
  try {
    ensureAudio();
    if (failBuffer) {
      const src = audioCtx.createBufferSource();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.9; // 音量 0.0-1.0，可按需调
      src.buffer = failBuffer;
      src.connect(gain); gain.connect(audioCtx.destination);
      src.start();
    } else {
      new Audio(FAIL_URL).play().catch(() => {});
    }
  } catch (_) {}
}

// 文件加载后预加载一次（放在初始化区域调用一次）
preloadFailSound();

  const unlock = () => { // 静音解锁一次即可
    try {
      ensureAudio();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      g.gain.value = 0; o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.01);
    } catch {}
  };
  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown",  unlock, { once: true });
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.shiftKey && e.code === "KeyB") beep();
  });

  // ——— 识别“生成接口”的白名单（必要时可自行追加） ———
  const GEN_ALLOW = [
    /\/api\/openai\/chat\/completions/i,
    /\/api\/openai\/completions/i,
    /\/api\/chat\/completions/i,
    /\/api\/extra\/generate/i,
    /\/api\/textgen.*generate/i,
    /\/api\/kobold.*generate/i,
    /\/api\/ollama.*generate/i,
    /\/api\/vllm.*generate/i,
    /\/api\/claude.*(chat|complete)/i,
    /\/api\/gemini.*(chat|generate)/i,
    /\/api\/.*\/generate/i
  ];
  const GEN_DENY = [
    /\/api\/(characters|chats|history|profile|settings|quick|preset|images?|assets?)\b/i
  ];
  const isGen = (url, method) =>
    method === "POST" &&
    !GEN_DENY.some(re => re.test(url)) &&
    GEN_ALLOW.some(re => re.test(url));

  // ——— Round 状态（由 generate_interceptor 武装） ———
  let armedUntil = 0;
  let roundActive = false, gotContent = false, userAborted = false;

  function arm() { armedUntil = Date.now() + CFG.armMs; log("armed"); }
  const isArmed = () => Date.now() <= armedUntil;

  function startRound(label) {
    roundActive = true; gotContent = false; userAborted = false;
    log("round start:", label);
  }
  function markContent() { if (roundActive) gotContent = true; }
  function markAbort()   { if (roundActive) userAborted = true; }
  function endRound(ok, why) {
    if (!roundActive) return;
    const had = gotContent, aborted = userAborted;
    roundActive = false;
    log("round end:", { ok, hadContent: had, aborted, why });
    if (!aborted && (!ok || !had)) beep();
  }

  // ——— 官方 generate_interceptor：由 ST 在发送前调用（最稳的“武装”信号） ———
  // manifest.json 里已声明 "generate_interceptor": "failDingIntercept"
  globalThis.failDingIntercept = function (payload) {
    arm();                 // 武装这一轮
    return payload;        // 必须把原 payload 返回
  };

  // ——— Hook fetch ———
  if (typeof window.fetch === "function" && !window.fetch.__fd106) {
    const origFetch = window.fetch;
    window.fetch = async (...args) => {
      const [input, init] = args;
      const url = typeof input === "string" ? input : (input?.url || "");
      const method = (init?.method || "GET").toUpperCase();
      const watch = isArmed() && isGen(url, method);
      if (watch) startRound(`fetch ${method} ${url}`);

      try {
        const res = await origFetch(...args);
        if (!watch) return res;

        const ok = !!res.ok;
        // 读取克隆流判断是否“有内容”
        try {
          const clone = res.clone();
          if (clone.body && clone.body.getReader) {
            (async () => {
              let bytes = 0;
              try {
                const reader = clone.body.getReader();
                while (true) {
                  const { value, done } = await reader.read();
                  if (done) break;
                  if (value && value.length) { bytes += value.length; markContent(); }
                }
              } catch {}
              finally { endRound(ok, `fetch bytes=${bytes}`); }
            })();
          } else {
            clone.text().then(t => {
              if (t && t.trim()) markContent();
              endRound(ok, `fetch len=${(t||"").length}`);
            }).catch(() => endRound(ok, "fetch text err"));
          }
        } catch {
          endRound(ok, "fetch clone/read err");
        }
        return res;
      } catch (err) {
        // AbortError 视为用户手停：不蜂鸣
        if (watch && (err && (err.name === "AbortError" || err.code === 20))) {
          markAbort(); endRound(true, "fetch abort");
        } else if (watch) {
          endRound(false, "fetch network err");
        }
        throw err;
      }
    };
    window.fetch.__fd106 = true;
  }

  // ——— Hook XHR ———
  const XHR = window.XMLHttpRequest;
  if (XHR && !XHR.prototype.__fd106) {
    const _open = XHR.prototype.open;
    const _send = XHR.prototype.send;

    XHR.prototype.open = function (method, url, ...rest) {
      this.__fd_meta = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return _open.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      try {
        const { method, url } = this.__fd_meta || {};
        const watch = isArmed() && isGen(url, method);
        if (watch) {
          startRound(`xhr ${method} ${url}`);
          this.addEventListener("loadend", () => {
            const ok = this.status >= 200 && this.status < 400;
            const txt = this.responseText || "";
            if (txt && txt.trim()) markContent();
            endRound(ok, `xhr len=${txt.length}`);
          });
          this.addEventListener("error",   () => endRound(false, "xhr error"));
          this.addEventListener("timeout", () => endRound(false, "xhr timeout"));
          this.addEventListener("abort",   () => { markAbort(); endRound(true, "xhr abort"); });
        }
      } catch {}
      return _send.apply(this, args);
    };
    XHR.prototype.__fd106 = true;
  }
})();

