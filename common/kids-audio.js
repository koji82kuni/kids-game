/*
 * こどもゲーム共通：タブレット（iPad・Androidタブレット）で音が出ないのを防ぐ
 *
 * 1. iPad/iPhone：消音スイッチ（マナーモード）でも効果音・BGMが鳴るよう、音の種類を「再生」にする
 * 2. 最初のタップ（touchend / click）で、ゲームが作った AudioContext をすべて起こす
 *    ※ iPad は touchstart では音の許可にならないので touchend と click で行う
 * 3. 読み上げ（SpeechSynthesis）を確実にする KidsAudio.speak()
 *    - 最初のタップの中で一度読み上げを鳴らして「許可」を取る（iPadは最初の1回がタップの中でないと鳴らない）
 *    - 言語に合う声を自分で選ぶ（lang だけだと声が決まらず無音になる端末がある）
 *    - 止まったままの読み上げを再開／しゃべっていない時に cancel() しない（直後の speak を落とす端末がある）
 *    - 1.5秒たっても話し始めなければ1回だけ言い直す
 *
 * 使い方：<script src="../common/kids-audio.js"></script> をゲーム本体より前に読み込む
 *         KidsAudio.speak('こんにちは', { lang: 'ja-JP', rate: 0.85, onstart, onend })
 */
(function () {
  'use strict';
  var KA = window.KidsAudio = window.KidsAudio || {};

  // ── 1. iPad/iPhone の消音スイッチ対策（Safari 16.4 以降）
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}

  // ── 2. ゲームが作った AudioContext を覚えておき、タップで起こす
  var contexts = [];
  ['AudioContext', 'webkitAudioContext'].forEach(function (name) {
    var Orig = window[name];
    if (typeof Orig !== 'function' || Orig.__kidsTracked) return;
    var Tracked = function () {
      var ctx = new (Function.prototype.bind.apply(Orig, [null].concat([].slice.call(arguments))))();
      contexts.push(ctx);
      return ctx;
    };
    Tracked.prototype = Orig.prototype;
    Tracked.__kidsTracked = true;
    window[name] = Tracked;
  });

  var synth = window.speechSynthesis || null;
  var voices = [];
  function loadVoices() { try { voices = synth ? synth.getVoices() : []; } catch (e) { voices = []; } }
  if (synth) {
    loadVoices();
    try { synth.addEventListener('voiceschanged', loadVoices); } catch (e) { synth.onvoiceschanged = loadVoices; }
  }

  var unlocked = false;
  function unlock() {
    contexts.forEach(function (c) { try { if (c.state !== 'running') c.resume(); } catch (e) {} });
    if (unlocked) return;
    unlocked = true;
    if (synth) {
      try {
        loadVoices();
        // 空文字はiPadで「鳴った」と見なされないことがあるので、聞こえない音量で短い文字を読む
        var u = new SpeechSynthesisUtterance('。');
        u.volume = 0; u.lang = 'ja-JP';
        synth.speak(u);
      } catch (e) {}
    }
  }
  ['touchend', 'click', 'keydown'].forEach(function (t) {
    document.addEventListener(t, unlock, { capture: true, passive: true });
  });
  // 画面に戻ってきたとき、止まった音を起こし直す（ゲーム側のBGM再開とは別に、器だけ起こす）
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && unlocked) {
      contexts.forEach(function (c) { try { if (c.state === 'suspended') c.resume(); } catch (e) {} });
    }
  });

  // ── 3. 読み上げ
  function pickVoice(lang) {
    if (!voices.length) loadVoices();
    var want = (lang || 'ja-JP').toLowerCase().replace('_', '-');
    var base = want.split('-')[0];
    var norm = function (v) { return (v.lang || '').toLowerCase().replace('_', '-'); };
    var exact = voices.filter(function (v) { return norm(v) === want; });
    var same = exact.length ? exact : voices.filter(function (v) { return norm(v).split('-')[0] === base; });
    if (!same.length) return null;
    // 端末にしまってある声（通信なしで読める）を優先
    return same.filter(function (v) { return v.localService; })[0] || same[0];
  }

  var current = null; // 読み上げ中の発話（途中で消されて無音になるのを防ぐため持っておく）
  KA.speak = function (text, opt) {
    opt = opt || {};
    if (!synth || !text) return false;
    var make = function () {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = opt.lang || 'ja-JP';
      var v = pickVoice(u.lang);
      if (v) u.voice = v;
      u.rate = typeof opt.rate === 'number' ? opt.rate : 0.85;
      if (typeof opt.pitch === 'number') u.pitch = opt.pitch;
      u.volume = 1;
      return u;
    };
    try {
      if (synth.speaking || synth.pending) synth.cancel();
      if (synth.paused) synth.resume();
      var started = false;
      var u = make();
      u.onstart = function () { started = true; if (opt.onstart) opt.onstart(); };
      u.onend = function () { if (current === u) current = null; if (opt.onend) opt.onend(); };
      u.onerror = function (e) {
        if (current === u) current = null;
        if (opt.onend) opt.onend();
        KA.lastError = e && e.error;
      };
      current = u;
      synth.speak(u);
      // 話し始めないとき（最初の1回が落ちる端末がある）は1回だけ言い直す
      setTimeout(function () {
        if (started || current !== u || synth.speaking) return;
        try {
          var r = make();
          r.onstart = u.onstart; r.onend = u.onend; r.onerror = u.onerror;
          current = r;
          synth.cancel(); // 待ち行列に詰まったままの発話を消してから言い直す（二重に読まないため）
          if (synth.paused) synth.resume();
          synth.speak(r);
        } catch (e) {}
      }, 1500);
      return true;
    } catch (e) { return false; }
  };
  KA.cancel = function () { current = null; try { if (synth) synth.cancel(); } catch (e) {} };
  KA.voices = function () { loadVoices(); return voices.slice(); };
  KA.hasVoice = function (lang) { return !!pickVoice(lang); };
  KA.contexts = contexts;
})();
