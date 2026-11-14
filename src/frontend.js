import { CONTRACT, EXPLORER, formatNear, parseNear, getBank, getBalance, getBet, getBetPage, getProof, isTestnetAccount, parseBetId } from './near.ts'
import { connectWallet as connectNearWallet, disconnectWallet, watchWalletAccount } from './wallet.ts'
import { transact, readIntent, recoverTransaction, clearIntent, lastBet, openBetUrl } from './game.ts'

/* Live contract state. Numeric values here are for presentation only. */
const S = {
  state: 'idle', bankroll: 0, bank: null, wallet: null, bet: 0.001,
  pick: 'heads', last: null, active: null, proof: null, busy: false, bankError: '',
};
const $ = (id) => document.getElementById(id);
const num = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 6 });
const fmt = (n) => `${num(n)} NEAR`;
const amountOf = (value) => Number(formatNear(value));
const minBet = () => amountOf(S.bank?.min_bet ?? '1000000000000000000000');
function maxStake() {
  if (!S.bank) return 0n;
  const cap = BigInt(S.bank.max_bet);
  const spendable = S.wallet ? BigInt(S.wallet.amount) - 10n ** 22n : cap;
  return spendable < 0n ? 0n : spendable < cap ? spendable : cap;
}
const maxBet = () => amountOf(maxStake());
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const message = (text = '') => { $('message').textContent = text; };
const explain = (error) => error instanceof Error ? error.message : 'Could not complete this action. Try again.';

/* Balances. `shown` is what is on screen, which lags the real value while a change animates. */
const shown = { bank: S.bankroll, wallet: 0 };
const sides = {
  bank:   { box: 'bank',   amt: 'bankroll',      sub: 'cap',      rest: () => S.bank ? `Max bid: ${formatNear(S.bank.max_bet)} NEAR` : 'Loading bank…', token: 0, busy: false },
  wallet: { box: 'wallet', amt: 'walletBalance', sub: 'walletId', rest: () => (S.wallet ? S.wallet.id : ''),                        token: 0, busy: false },
};

// Count a balance from one value to another; while it moves it is green (up) or red (down)
// and the line beneath it shows the change and the reason.
function changeBalance(name, from, to, why) {
  const side = sides[name], d = to - from, token = ++side.token;
  const box = $(side.box);
  box.classList.remove('up', 'down');
  void box.offsetWidth;                                   // restart the bump if one is still running
  box.classList.add(d > 0 ? 'up' : 'down');
  side.busy = true;
  $(side.sub).textContent = `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))} ${why}`;
  tween(750, (e) => {
    if (token !== side.token) return;
    shown[name] = from + d * e;
    $(side.amt).textContent = fmt(shown[name]);
  }, easeOut).then(() => { if (token === side.token) shown[name] = to; });
  setTimeout(() => {
    if (token !== side.token) return;                     // a newer change has taken over
    box.classList.remove('up', 'down');
    side.busy = false;
    $(side.sub).textContent = side.rest();
  }, 2600);
}

function focusPrimary() {
  // Keep focus on the one primary control so Enter/Space walks the whole flow.
  const focus = { idle: 'start', connect: 'connect', bet: 'amount', spinning: 'reveal', result: 'again' }[S.state];
  if (focus) { $(focus).focus(); if (focus === 'amount') $(focus).select(); }
}

function setState(next) {
  S.state = next;
  render();
  focusPrimary();
  if (next === 'bet') showFace(S.pick);
}

function render() {
  document.querySelectorAll('[data-show]').forEach((el) => {
    el.hidden = !el.dataset.show.split(' ').includes(S.state);
  });

  $('bankroll').textContent = fmt(shown.bank);
  if (!sides.bank.busy) $('cap').textContent = sides.bank.rest();

  $('wallet').hidden = !S.wallet;
  if (S.wallet) {
    if (!sides.wallet.busy) $('walletId').textContent = sides.wallet.rest();
    $('walletBalance').textContent = fmt(shown.wallet);
    $('disconnect').disabled = S.busy;
  }
  const canPledge = !S.busy;
  $('pledge').disabled = !canPledge;
  $('pledgeConnect').hidden = !!S.wallet;
  $('pledgeForm').hidden = !S.wallet;
  $('stage').classList.toggle('play', canPlay());
  $('start').disabled = S.state === 'igniting' || S.busy;
  $('connect').disabled = S.busy;
  $('again').disabled = S.busy || !!readIntent();
  sideBtns.forEach(button => {
    const selected = button.dataset.side === S.pick;
    button.setAttribute('aria-checked', String(selected));
    button.tabIndex = selected ? 0 : -1;
    button.disabled = S.busy || !!readIntent();
  });
  const bet = S.active;
  const expired = bet && Date.now() >= Number(bet.expires_at) * 1000;
  const revealing = S.state === 'revealing';
  $('reveal').disabled = S.busy || !!readIntent() || (!expired && !S.proof);
  $('reveal').textContent = S.busy ? 'Check your wallet…' : expired ? 'Refund stake' : S.wallet ? 'Reveal result' : 'Connect to reveal';
  $('lockPanel').classList.toggle('revealing', revealing);
  $('lockTitle').textContent = revealing ? 'Revealing' : expired ? 'Refund available' : S.proof ? 'Ready to reveal' : 'In the air';
  $('locked').textContent = bet ? `${formatNear(bet.stake)} NEAR on ${bet.side}. ${expired ? 'The proof window expired.' : S.proof ? 'Reveal and any winnings go straight to the bettor.' : 'Waiting for the committed drand round.'}` : '';
  $('retryClaim').hidden = !bet || bet.claim !== 'available' || bet.player !== S.wallet?.id;
  $('retryClaim').disabled = S.busy || !!readIntent();
  $('verify').hidden = !bet?.signature;
  $('receiptLink').hidden = !bet;
  if (bet) $('receiptLink').href = `?receipt=${bet.bet_id}`;
  $('recovery').hidden = !readIntent();
  sizeAmount();
  validate();

  if (S.last) {
    const bet = S.active;
    $('outcome').textContent = bet.outcome === 'refunded' ? 'Refunded' : S.last.win ? 'Doubled' : 'Zero';
    $('outcome').classList.toggle('win', S.last.win);
    const landed = bet.result === 'heads' ? 'Heads' : 'Tails';
    $('outcomeNote').textContent = bet.outcome === 'refunded'
      ? `${formatNear(bet.payout)} NEAR available to claim.`
      : bet.outcome === 'lost' ? `${landed}. Your ${formatNear(bet.stake)} NEAR joined the bank.`
      : `${landed}. ${formatNear(bet.payout)} NEAR ${bet.claim === 'paid' ? 'paid to the bettor’s wallet.' : bet.claim === 'in_flight' ? 'is being sent.' : 'is available to claim.'}`;
  }
}

function readBet() {
  const value = parseNear($('amount').value.trim());
  return value === null ? NaN : amountOf(value);
}

function sizeAmount() {
  // At least three characters wide (every 0.5 step fits), so the row — and the stepper beside it — stays put while you step.
  $('amount').style.width = `${Math.max(3, $('amount').value.length) * 1.02 + 0.2}ch`;
}

function validate() {
  const stake = parseNear($('amount').value.trim());
  let error = '';
  if (S.bankError) error = S.bankError;
  else if (!S.bank) error = 'Loading the live bank…';
  else if (S.bank.paused) error = 'New flips are paused.';
  else if (stake === null) error = 'Enter a NEAR amount.';
  else if (stake < BigInt(S.bank.min_bet)) error = `Minimum bid is ${formatNear(S.bank.min_bet)} NEAR.`;
  else if (stake > maxStake()) error = `Your current max bid is ${formatNear(maxStake())} NEAR, with a little NEAR left for gas.`;
  $('hint').classList.toggle('error', !!error);
  $('hint').textContent = error || `Lands ${S.pick} and ${formatNear(stake * 2n)} NEAR comes back.`;
  $('flip').disabled = !!error || !S.wallet || S.busy || !!readIntent();
  $('flip').textContent = S.busy ? 'Check your wallet…' : 'Flip';
  $('stepUp').disabled = S.busy || !(readBet() < maxBet());
  $('stepDown').disabled = S.busy || !(readBet() > minBet());
  $('max').disabled = S.busy || !S.bank;
  $('amount').disabled = S.busy;
  return !error;
}

function tween(ms, fn, ease = (p) => p) {
  if (reducedMotion.matches) { fn(1, 1); return Promise.resolve(); }
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      fn(ease(p), p);
      p < 1 ? requestAnimationFrame(step) : resolve();
    };
    requestAnimationFrame(step);
  });
}
const easeOut = (p) => 1 - Math.pow(1 - p, 3);
const easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/* ───────────── Sound ─────────────
   Everything is synthesized with the Web Audio API — no audio files.
   The vocabulary is small on purpose: pitch-swept sine "pops" and "boings" for anything pressed or thrown,
   short inharmonic "clinks" for coins, filtered noise for air, and a few plain notes for outcomes. */

const sfx = (() => {
  let ctx = null, out = null, unlocked = false, muted = false;
  try { muted = localStorage.getItem('nflip.muted') === '1'; } catch {}

  // Browsers only allow audio after a user gesture; hovers before the first click stay silent.
  const unlock = () => {
    unlocked = true;
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = ctx.createDynamicsCompressor();   // keeps stacked sounds (a win) from clipping
      out = ctx.createGain();
      out.gain.value = 0.55;
      out.connect(comp).connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  };
  addEventListener('pointerdown', unlock, true);
  addEventListener('keydown', unlock, true);

  const rnd = (a, b) => a + Math.random() * (b - a);

  // One enveloped oscillator, optionally sweeping from f to f2.
  const tone = ({ f, f2 = f, type = 'sine', at = 0, d = 0.15, g = 0.2, a = 0.004 }) => {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator(), v = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, t + d);
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(g, t + a);
    v.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(v).connect(out);
    o.start(t); o.stop(t + d + 0.02);
  };

  // A burst of filtered noise, optionally sweeping the filter.
  let noiseBuf = null;
  const noise = ({ f = 2000, f2 = f, q = 0.8, type = 'bandpass', at = 0, d = 0.2, g = 0.1, a = 0.01 }) => {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const ch = noiseBuf.getChannelData(0);
      for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource(), flt = ctx.createBiquadFilter(), v = ctx.createGain();
    src.buffer = noiseBuf; src.loop = true;
    flt.type = type; flt.Q.value = q;
    flt.frequency.setValueAtTime(f, t);
    if (f2 !== f) flt.frequency.exponentialRampToValueAtTime(f2, t + d);
    v.gain.setValueAtTime(0.0001, t);
    v.gain.exponentialRampToValueAtTime(g, t + Math.min(a, d / 2));
    v.gain.exponentialRampToValueAtTime(0.0001, t + d);
    src.connect(flt).connect(v).connect(out);
    src.start(t, rnd(0, 0.5)); src.stop(t + d + 0.02);
  };

  // Building blocks
  const clink = (at = 0, g = 0.12, pitch = 1) => {       // a coin touching metal or glass
    const p = pitch * rnd(0.94, 1.06);
    tone({ f: 2637 * p, at, d: rnd(0.16, 0.3), g });
    tone({ f: 3951 * p, at, d: rnd(0.1, 0.2), g: g * 0.55 });
    tone({ f: 5274 * p, at, d: 0.08, g: g * 0.3 });
    noise({ f: 7000, type: 'highpass', at, d: 0.02, g: g * 0.5, a: 0.001 });
  };
  const pop = (at = 0, g = 0.24, f = 520) => tone({ f, f2: f * 0.34, at, d: 0.09, g });   // soft button pop
  const thunk = (at = 0, g = 0.32) => {                  // something landing
    tone({ f: 170, f2: 62, at, d: 0.2, g });
    noise({ f: 900, type: 'lowpass', at, d: 0.05, g: g * 0.4, a: 0.001 });
  };
  const note = (f, at, d = 0.28, g = 0.11) => {          // a plain bell-ish note
    tone({ f, type: 'triangle', at, d, g });
    tone({ f: f * 2, at, d: d * 0.6, g: g * 0.35 });
  };
  const C5 = 523.25, E5 = 659.25, G5 = 783.99, C6 = 1046.5, E6 = 1318.5, G6 = 1568;

  const sounds = {
    hover() { tone({ f: 1500, f2: 1900, d: 0.04, g: 0.035 }); },
    press() { pop(); noise({ f: 5000, type: 'highpass', d: 0.015, g: 0.05, a: 0.001 }); },
    tick() { tone({ f: rnd(820, 980), f2: 640, d: 0.035, g: 0.07 }); },
    blipUp() { tone({ f: 480, f2: 1040, d: 0.11, g: 0.16 }); clink(0.07, 0.05); },
    deny() { tone({ f: 190, f2: 150, type: 'triangle', d: 0.09, g: 0.16 }); tone({ f: 170, f2: 130, type: 'triangle', at: 0.11, d: 0.12, g: 0.16 }); },

    // Start: air rushing past as the coin turns over, a rising run of notes, then it lands.
    start() {
      noise({ f: 300, f2: 3200, at: 0.05, d: 0.95, g: 0.1, a: 0.3 });
      tone({ f: 190, f2: 620, at: 0, d: 0.32, g: 0.2 });
      [C5, E5, G5, C6].forEach((f, i) => note(f, 0.28 + i * 0.1, 0.3));
      thunk(1.22, 0.3); clink(1.24, 0.08);
    },

    connect() { thunk(0, 0.22); note(G5, 0.05, 0.22); note(C6, 0.15, 0.38); clink(0.2, 0.09); clink(0.31, 0.07, 1.12); },
    disconnect() { note(C6, 0, 0.16, 0.09); note(G5, 0.09, 0.16, 0.09); note(E5, 0.18, 0.3, 0.09); },

    // Flip: a springy boing as it leaves the thumb, plus air.
    flip() {
      clink(0, 0.14);
      tone({ f: 210, f2: 760, d: 0.3, g: 0.26 });
      tone({ f: 420, f2: 1520, d: 0.3, g: 0.07 });
      noise({ f: 500, f2: 4200, d: 0.4, g: 0.09, a: 0.08 });
    },
    // Each time a face swings past while unrevealed: barely-there air, so the wait has a pulse.
    swish() { noise({ f: 700, f2: 1700, q: 1.4, d: 0.26, g: 0.03, a: 0.1 }); },

    // Reveal: an accelerating roll of ticks under a rising tone — about as long as the final turn.
    reveal() {
      tone({ f: 200, f2: 900, d: 1.42, g: 0.07, a: 0.5 });
      noise({ f: 400, f2: 5000, d: 1.42, g: 0.07, a: 0.9 });
      let t = 0, gap = 0.2;
      for (let i = 0; t < 1.4; i++) {
        tone({ f: 620 + i * 55, f2: 420 + i * 40, at: t, d: 0.05, g: 0.1 });
        t += gap; gap = Math.max(0.045, gap * 0.84);
      }
    },
    win() {
      thunk(0, 0.3);
      [C5, E5, G5, C6, E6].forEach((f, i) => note(f, 0.04 + i * 0.075, i === 4 ? 0.7 : 0.26, 0.13));
      note(G6, 0.42, 0.8, 0.07);
      for (let i = 0; i < 9; i++) clink(rnd(0.15, 1.0), rnd(0.05, 0.11), rnd(0.9, 1.25));   // coins raining in
    },
    lose() {
      thunk(0, 0.34);
      tone({ f: 330, f2: 110, at: 0.05, d: 0.5, g: 0.18 });
      tone({ f: 247, f2: 82, type: 'triangle', at: 0.05, d: 0.55, g: 0.12 });
      clink(0.3, 0.05, 0.7);
    },

    coins(n = 4) { for (let i = 0; i < n; i++) clink(0.05 + i * rnd(0.05, 0.09), rnd(0.05, 0.09), rnd(0.95, 1.2)); },
    jar() {                                              // glass ringing, coins settling
      tone({ f: 2093, d: 0.6, g: 0.05 }); tone({ f: 3136, d: 0.4, g: 0.03 });
      for (let i = 0; i < 6; i++) clink(rnd(0, 0.45), rnd(0.03, 0.08), rnd(0.85, 1.15));
    },
    // The sound switch itself: a mechanical click, higher going on than going off.
    toggle(on) { noise({ f: 3500, type: 'highpass', d: 0.02, g: 0.2, a: 0.001 }); tone({ f: on ? 1250 : 720, f2: on ? 900 : 480, d: 0.06, g: 0.2 }); thunk(0.012, 0.12); },
    wallet() { tone({ f: 150, f2: 80, d: 0.12, g: 0.2 }); clink(0.06, 0.07); clink(0.15, 0.05, 1.15); },
  };

  // Public: every sound is a no-op until audio is unlocked, and while muted.
  const api = {};
  for (const [name, play] of Object.entries(sounds)) {
    api[name] = (...args) => { if (unlocked && !muted && ctx) { try { play(...args); } catch (e) { console.warn('sfx', name, e); } } };
  }
  api.muted = () => muted;
  api.setMuted = (m) => { muted = m; try { localStorage.setItem('nflip.muted', m ? '1' : '0'); } catch {} };
  return api;
})();

// Generic feedback for every button and chip: a tick on hover, a pop on press.
document.addEventListener('pointerover', (e) => {
  const b = e.target.closest('.btn, .chip, .iconbtn, .linkbtn');
  if (b && !b.disabled && !b.contains(e.relatedTarget)) sfx.hover();
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('.btn, .chip, .linkbtn');
  if (b && !b.disabled) sfx.press();
}, true);
$('jar').addEventListener('pointerenter', () => sfx.jar());
$('jar').addEventListener('click', () => sfx.jar());
$('walletArt').addEventListener('pointerenter', () => sfx.wallet());
$('walletArt').addEventListener('click', () => sfx.wallet());

const renderSound = () => { $('soundLabel').textContent = sfx.muted() ? 'Sound off' : 'Sound on'; $('sound').setAttribute('aria-pressed', !sfx.muted()); };
$('sound').onclick = () => {
  // The click is heard both ways: before the sound goes off, after it comes on.
  if (sfx.muted()) { sfx.setMuted(false); sfx.toggle(true); } else { sfx.toggle(false); sfx.setMuted(true); }
  soundIcon.press();
  renderSound();
};

// Share: the system share sheet where there is one, otherwise copy the link.
let shareReset = 0;
$('share').onclick = async () => {
  shareIcon.press();
  sfx.blipUp();
  const say = (text) => {
    $('shareLabel').textContent = text;
    clearTimeout(shareReset);
    shareReset = setTimeout(() => { $('shareLabel').textContent = 'Share'; }, 2000);
  };
  const data = { title: 'Flip Fun', text: 'Fair 2x or zero on NEAR.', url: location.href };
  try {
    if (navigator.share && /^https?:/.test(location.href)) { await navigator.share(data); say('Shared'); }
    else { await navigator.clipboard.writeText(location.href); say('Link copied'); }
  } catch (e) {
    if (e.name !== 'AbortError') say("Couldn't share");     // AbortError = the person closed the share sheet
  }
};
renderSound();

/* ───────────── Flow ───────────── */

$('start').onclick = async () => {
  setState('igniting');
  sfx.start();
  await ignite();
  setState(S.wallet ? 'bet' : 'connect');
};

async function connectWallet() {
  try {
    S.busy = true; render(); message();
    await connectNearWallet();
  } catch (error) { message(explain(error)); }
  finally { S.busy = false; render(); }
}
$('connect').onclick = connectWallet;
$('disconnect').onclick = async () => {
  if (S.busy) return;
  try { await disconnectWallet(); sfx.disconnect(); }
  catch (error) { message(explain(error)); }
};

$('max').onclick = () => { $('amount').value = maxBet(); sizeAmount(); validate(); $('amount').focus(); sfx.blipUp(); };
$('amount').oninput = () => { sizeAmount(); validate(); sfx.tick(); };

// Stepping the stake: snaps to the next 0.5 NEAR mark in that direction, clamped to the allowed range.
const STEP = 0.001;
function stepBet(dir) {
  const cur = readBet();
  const base = Number.isFinite(cur) ? cur : minBet();
  let next = dir > 0 ? (Math.floor(base / STEP + 1e-9) + 1) * STEP : (Math.ceil(base / STEP - 1e-9) - 1) * STEP;
  next = Math.round(Math.min(maxBet(), Math.max(minBet(), next)) * 1000) / 1000;
  if (next === cur) return false;
  $('amount').value = next;
  sizeAmount(); validate();
  dir > 0 ? sfx.blipUp() : sfx.tick();
  return true;
}
// Press and hold to keep stepping; a plain click or the keyboard steps once.
for (const [id, dir] of [['stepUp', 1], ['stepDown', -1]]) {
  const b = $(id);
  let hold = 0;
  const stop = () => { clearTimeout(hold); clearInterval(hold); hold = 0; };
  b.addEventListener('pointerdown', (e) => {
    if (b.disabled || e.button !== 0) return;
    e.preventDefault();                                     // keep focus (and the selection) out of the way
    stepBet(dir);
    hold = setTimeout(() => { hold = setInterval(() => { if (!stepBet(dir)) stop(); }, 90); }, 380);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
  b.addEventListener('click', (e) => { if (e.detail === 0) stepBet(dir); });   // keyboard activation only
}
// Arrow keys in the amount field step too.
$('amount').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); stepBet(e.key === 'ArrowUp' ? 1 : -1); }
});

// Heads / Tails: a radio group. Clicking or arrowing picks a side, and the coin turns over to show it.
const sideBtns = [...document.querySelectorAll('.side')];
function pickSide(side, focus) {
  if (S.state !== 'bet' || S.busy || readIntent() || side === S.pick) return;
  S.pick = side;
  sideBtns.forEach((b) => {
    const on = b.dataset.side === side;
    b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  sfx.tick();
  showFace(side);
  validate();
}
sideBtns.forEach((b) => {
  b.addEventListener('click', () => pickSide(b.dataset.side));
  b.addEventListener('keydown', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      pickSide(S.pick === 'heads' ? 'tails' : 'heads', true);
    }
  });
});

// About: a modal dialog; Escape, Close or a click outside the panel closes it.
$('aboutBtn').onclick = () => { $('about').showModal(); $('aboutClose').focus(); };
$('aboutClose').onclick = () => $('about').close();
$('about').addEventListener('click', (e) => { if (e.target === $('about')) $('about').close(); });   // a click on the backdrop lands on the dialog itself

// A wallet approval places the bet; the next approval reveals and pays it.
let launching = Promise.resolve();
let openingBet = false;
async function displayBet(bet, animate = true) {
  S.active = bet;
  S.bet = amountOf(bet.stake);
  S.pick = bet.side;
  if (S.proof?.round !== bet.round) S.proof = null;
  openBetUrl(bet.bet_id);
  if (bet.outcome === 'pending') {
    if (!['spinning', 'revealing'].includes(S.state)) {
      setState('spinning');
      sfx.flip();
      launching = launch();
    }
    render();
    return;
  }
  const changed = !S.last || S.last.id !== bet.bet_id || S.state !== 'result';
  if (changed && bet.result) {
    setState('revealing');
    await launching;
    await settle(bet.result);
    if (animate) { coinFx.land(bet.outcome === 'won'); bet.outcome === 'won' ? sfx.win() : sfx.lose(); }
  }
  S.last = { id: bet.bet_id, win: bet.outcome === 'won' };
  setState('result');
}

async function send(method, args = {}, deposit = '0') {
  if (S.busy) return;
  if (!S.wallet) { await connectWallet(); return; }
  S.busy = true; render(); message();
  try {
    const bet = await transact(S.wallet.id, method, args, deposit);
    if (bet) await displayBet(bet);
    await refreshBalances();
    return true;
  } catch (error) { message(explain(error)); return false; }
  finally { S.busy = false; render(); }
}

$('betForm').onsubmit = async event => {
  event.preventDefault();
  if (S.state !== 'bet' || S.busy || !validate()) return;
  const stake = parseNear($('amount').value.trim());
  await send('place_bet', { side: S.pick }, stake.toString());
};
$('reveal').onclick = async () => {
  const bet = S.active;
  if (!bet || S.busy || bet.outcome !== 'pending') return;
  if (!S.wallet) { await connectWallet(); return; }
  if (Date.now() >= Number(bet.expires_at) * 1000) {
    await send('refund_expired_bet', { bet_id: bet.bet_id });
  } else if (S.proof?.round === bet.round) {
    sfx.reveal();
    await send('settle_bet', { bet_id: bet.bet_id, signature: S.proof.signature });
  }
};
$('retryClaim').onclick = () => S.active && send('claim', { bet_id: S.active.bet_id });

function validatePledge() {
  const value = parseNear($('pledgeAmt').value.trim());
  let error = '';
  if (value === null || value <= 0n) error = 'Enter a positive NEAR amount.';
  else if (!S.wallet || value + 10n ** 22n >= BigInt(S.wallet.amount)) error = 'Leave some NEAR in your wallet for gas.';
  $('pledgeHint').textContent = error || 'A contribution to the house bankroll. No shares or redemption rights.';
  $('pledgeHint').classList.toggle('error', !!error);
  $('pledgeGo').disabled = !!error || S.busy || !!readIntent();
  return error ? null : value;
}
function openPledge(open) {
  $('pledgeBox').hidden = !open;
  if (!open) return;
  $('pledgeConnect').hidden = !!S.wallet;
  $('pledgeForm').hidden = !S.wallet;
  if (!S.wallet) { $('pledgeConnectBtn').focus(); return; }
  $('pledgeAmt').value = '0.1';
  validatePledge();
  $('pledgeAmt').focus();
}
$('pledgeConnectBtn').onclick = async () => { await connectWallet(); openPledge(true); };
$('pledge').onclick = () => openPledge($('pledgeBox').hidden);
$('pledgeCancel').onclick = () => openPledge(false);
$('pledgeBox').addEventListener('keydown', event => { if (event.key === 'Escape') openPledge(false); });
$('pledgeAmt').oninput = validatePledge;
$('pledgeBox').onsubmit = async event => {
  event.preventDefault();
  const value = validatePledge();
  if (value && await send('fund_bank', {}, value.toString())) { openPledge(false); sfx.coins(7); }
};
$('again').onclick = () => {
  S.active = null; S.last = null; S.proof = null; openBetUrl(null); message();
  $('amount').value = String(Math.max(minBet(), Math.min(S.bet, maxBet())));
  setState(S.wallet ? 'bet' : 'connect');
};

async function refreshBalances() {
  const account = S.wallet?.id;
  const [bank, wallet] = await Promise.allSettled([getBank(), account ? getBalance(account) : Promise.resolve(null)]);
  if (bank.status === 'fulfilled') {
    const first = !S.bank;
    S.bank = bank.value; S.bankError = ''; S.bankroll = amountOf(bank.value.free);
    if (!first && !sides.bank.busy && shown.bank !== S.bankroll) changeBalance('bank', shown.bank, S.bankroll, 'bank update');
    else if (first) shown.bank = S.bankroll;
    jar.setFill(S.bankroll);
  } else { S.bankError = 'Live bank unavailable. Trying again shortly.'; }
  if (wallet.status === 'fulfilled' && account && S.wallet?.id === account && wallet.value !== null) {
    const first = S.wallet.amount === '0';
    S.wallet.amount = wallet.value; S.wallet.balance = amountOf(wallet.value);
    if (!first && !sides.wallet.busy && shown.wallet !== S.wallet.balance) changeBalance('wallet', shown.wallet, S.wallet.balance, 'wallet update');
    else if (first) shown.wallet = S.wallet.balance;
  }
  render();
}

async function openBet(id) {
  if (S.busy || openingBet) return;
  openingBet = true;
  try {
    const bet = await getBet(id);
    if (!bet) throw new Error('No bet found.');
    S.last = null;
    await displayBet(bet, false);
  } catch (error) { message(explain(error)); }
  finally { openingBet = false; }
}

async function updatePending() {
  const id = S.active?.bet_id;
  if (!id || S.busy || openingBet) return;
  try {
    const bet = await getBet(id);
    if (!bet || id !== S.active?.bet_id || S.busy) return;
    if (bet.outcome !== 'pending') {
      if (S.active.outcome !== bet.outcome || S.active.claim !== bet.claim) await displayBet(bet);
      return;
    }
    S.active = bet;
    if (!S.proof && Date.now() >= Number(bet.round_at) * 1000 && Date.now() < Number(bet.expires_at) * 1000) {
      const signature = await getProof(bet.round, new AbortController().signal);
      if (signature && id === S.active?.bet_id) S.proof = { round: bet.round, signature };
    }
    render();
  } catch (error) { message(explain(error)); }
}

$('recoverCheck').onclick = async () => {
  if (S.busy) return;
  S.busy = true; render();
  try {
    const bet = await recoverTransaction($('recoverHash').value);
    if (bet) await displayBet(bet);
    message('Transaction confirmed.');
    await refreshBalances();
  } catch (error) { message(explain(error)); }
  finally { S.busy = false; render(); }
};
$('recoverClear').onclick = () => {
  if (S.busy || !confirm('Check your wallet first. Clearing this action does not cancel a submitted bet.')) return;
  clearIntent(); render(); message();
};

let historyCursor = null;
let historyBets = [];
let historyFilter = 'all';
let historyBusy = false;
function renderHistory() {
  const list = $('historyList'); list.replaceChildren();
  const bets = historyFilter === 'mine' ? historyBets.filter(bet => bet.player === S.wallet?.id) : historyBets;
  for (const bet of bets) {
    const row = document.createElement('button'); row.className = 'historyRow'; row.type = 'button';
    const claim = bet.claim === 'paid' ? ' · Paid' : bet.claim === 'available' ? ' · Claimable' : bet.claim === 'in_flight' ? ' · Sending' : '';
    row.textContent = `#${bet.bet_id} · ${bet.side} · ${formatNear(bet.stake)} NEAR · ${bet.outcome}${claim}`;
    const player = document.createElement('small'); player.textContent = bet.player; row.append(player);
    row.onclick = async () => { $('historyDialog').close(); await openBet(bet.bet_id); };
    list.append(row);
  }
  if (!bets.length) list.textContent = historyFilter === 'mine' && !S.wallet ? 'Connect a wallet to see your bets.' : historyCursor ? 'No matching bets on the pages loaded. Load older bets.' : 'No bets found.';
  $('historyMore').hidden = historyCursor === null;
  $('historyMine').setAttribute('aria-pressed', String(historyFilter === 'mine'));
  $('historyAll').setAttribute('aria-pressed', String(historyFilter === 'all'));
}
async function loadHistory(older = false) {
  if (historyBusy) return;
  historyBusy = true; $('historyMore').disabled = true; $('historyRefresh').disabled = true;
  try {
    const page = await getBetPage(older ? historyCursor : null, new AbortController().signal);
    historyBets = older ? [...historyBets, ...page.bets] : page.bets;
    historyCursor = page.next; renderHistory(); $('historyError').textContent = '';
  } catch (error) { $('historyError').textContent = explain(error); }
  finally { historyBusy = false; $('historyMore').disabled = false; $('historyRefresh').disabled = false; }
}
$('historyBtn').onclick = () => { $('historyDialog').showModal(); void loadHistory(); };
$('historyClose').onclick = () => $('historyDialog').close();
$('historyMore').onclick = () => loadHistory(true);
$('historyRefresh').onclick = () => loadHistory();
$('historyMine').onclick = () => { historyFilter = 'mine'; renderHistory(); };
$('historyAll').onclick = () => { historyFilter = 'all'; renderHistory(); };
$('verify').onclick = async () => {
  if (!S.active?.signature) return;
  $('verify').disabled = true;
  try { const { verifyBet } = await import('./proof.ts'); message(`Proof verified · ${await verifyBet(S.active)}`); }
  catch (error) { message(explain(error)); }
  finally { $('verify').disabled = false; }
};

async function boot() {
  $('amount').value = '0.001';
  $('contractLink').href = `${EXPLORER}/address/${CONTRACT}`;
  $('recoverHash').value = readIntent()?.hash ?? '';
  watchWalletAccount(async id => {
    if (id && !isTestnetAccount(id)) { message('Switch your wallet to NEAR testnet.'); return; }
    S.wallet = id ? { id, amount: '0', balance: 0 } : null;
    shown.wallet = 0;
    if (S.state === 'connect' && id) { walletArt.pop(); sfx.connect(); setState('bet'); }
    if (S.state === 'bet' && !id) setState('connect');
    await refreshBalances(); renderHistory();
    if (id && !S.active && !new URL(location.href).searchParams.has('bet') && !new URL(location.href).searchParams.has('receipt') && !readIntent()) {
      const saved = lastBet(id); if (saved) await openBet(saved);
    }
  });
  await refreshBalances();
  if (readIntent()) {
    try { const bet = await recoverTransaction(); if (bet) await displayBet(bet); }
    catch (error) { message(explain(error)); }
  }
  const params = new URL(location.href).searchParams;
  const id = parseBetId(params.get('bet') ?? params.get('receipt'));
  if (id !== null && !S.active) await openBet(id);
  let bankTick = 0;
  async function poll() {
    await updatePending();
    if (++bankTick % 4 === 0 && !S.busy) await refreshBalances();
    setTimeout(poll, 1500);
  }
  void poll();
}

/* ───────────── Coin motion ─────────────
   One abstract coin.
   theta: turn about the horizontal axis (0 = heads to the viewer, π = tails).
   yaw:   turn about the vertical axis — a little drift while the coin is in the air.
   lift:  0…1 height.
   zoom:  extra scale on top of 1. */

const TAU = Math.PI * 2;
const REST = 0.32;               // start-screen pose: leaning back a little, as in the reference
const coin = { theta: REST, yaw: 0, lift: 0, zoom: 0 };   // zoom: extra scale, used to present the result
let motion = 'idle';             // idle | hover | float | tween
let faceTheta = 0;
const TUMBLE = 1.7;              // rad/s — the unrevealed coin turns over in slow motion, once every ~3.7 s
const HANG = 0.42;               // how high it hangs while unrevealed

// Entry animation: one full turn showing both faces, ending square to the viewer.
function ignite() {
  motion = 'tween';
  const from = coin.theta, to = TAU;
  return tween(1300, (e, p) => {
    coin.theta = from + (to - from) * e;
    coin.lift = Math.sin(p * Math.PI) * 0.3;
  }, easeInOut).then(() => { coin.theta = faceTheta = 0; coin.lift = 0; motion = 'hover'; });
}

// Calling a side: the resting coin flips over, with a little hop, to show that face.
let faceToken = 0, faceUntil = 0;
const faceBusy = () => performance.now() < faceUntil;
function showFace(side) {
  const target = side === 'heads' ? 0 : Math.PI;
  const d = ((target - faceTheta) % TAU + TAU) % TAU;     // how far round, forward, to that face
  if (motion !== 'hover' || d < 0.01) return;
  const from = faceTheta, token = ++faceToken;
  faceUntil = performance.now() + 520;
  tween(520, (e, p) => {
    if (token !== faceToken || motion !== 'hover') return;
    faceTheta = from + d * e;
    coin.lift = Math.sin(p * Math.PI) * 0.16;
  }, easeInOut).then(() => { if (token === faceToken && motion === 'hover') faceTheta = from + d; });
  sfx.swish();
}

// Bid placed: the coin is tossed — two quick turns on the way up — and then hangs there, still turning
// over in slow motion above the spot where it will land. It reads as a flip frozen mid-air:
// nothing has been decided, and it is slow enough to watch without strain.
const easeOutBack = (p) => 1 + 2.4 * Math.pow(p - 1, 3) + 1.4 * Math.pow(p - 1, 2);
function launch() {
  faceToken++; faceUntil = 0;
  motion = 'tween';
  const from = faceTheta, zoom0 = coin.zoom, T = 0.9;
  return tween(T * 1000, (e, p) => {
    coin.zoom = zoom0 * (1 - p);
    coin.theta = from + TAU * 2 * e + TUMBLE * T * p;   // the fast turns die away into the slow tumble
    coin.lift = HANG * easeOutBack(p);
  }, easeOut).then(() => { motion = 'float'; });
}

// Reveal: the coin hangs a beat longer, then comes down — turning twice as it falls — and lands
// flat-on showing the result. The landing bounce and effects are in the coin scene (coinFx).
const easeOutQuart = (p) => 1 - Math.pow(1 - p, 4);
function settle(side) {
  motion = 'tween';
  const theta0 = coin.theta, yaw0 = coin.yaw, lift0 = coin.lift;
  const target = side === 'heads' ? 0 : Math.PI;
  const WIND = 0.3, RISE = 0.07;
  const to = Math.ceil((theta0 - target) / TAU) * TAU + target + TAU * 2;
  return tween(200, (e) => {
    coin.theta = theta0 - WIND * e;
    coin.lift = lift0 + RISE * e;
    coin.zoom = -0.05 * e;
  }, easeOut).then(() => tween(1250, (e, p) => {
    coin.theta = (theta0 - WIND) + (to - (theta0 - WIND)) * e;
    coin.yaw = yaw0 * (1 - e);
    coin.lift = (lift0 + RISE) * (1 - p * p);          // falls faster and faster, like something dropped
    coin.zoom = -0.05 + 0.17 * e;
  }, easeOutQuart)).then(() => {
    coin.yaw = 0; coin.theta = faceTheta = target; coin.lift = 0; motion = 'hover';
  });
}

/* ───────────── three.js ─────────────
   One WebGL context for everything: a fixed full-window canvas, and each 3D object (coin, jar, wallet)
   is drawn into the rectangle of its placeholder element. One environment map, shared materials,
   instanced coins, no downloaded models or image textures. */

const NEAR_GREEN = 0x00ec97;
const NEAR_MARK = 'M72.2,4.6L53.4,32.5c-1.3,1.9,1.2,4.2,3,2.6L74.9,19c0.5-0.4,1.2-0.1,1.2,0.6v50.3c0,0.7-0.9,1-1.3,0.5l-56-67C17,1.2,14.4,0,11.5,0h-2C4.3,0,0,4.3,0,9.6v70.8C0,85.700,4.3,90,9.6,90c3.3,0,6.4-1.7,8.2-4.6l18.8-27.900c1.3-1.9-1.2-4.2-3-2.6l-18.500,16c-0.5,0.4-1.2,0.1-1.2-0.6V20.100c0-0.7,0.9-1,1.3-0.5l56,67c1.8,2.200,4.500,3.400,7.300,3.400h2c5.3,0,9.6-4.300,9.600-9.600V9.600C90,4.300,85.700,0,80.400,0C77,0,73.900,1.700,72.200,4.600z';

// Until three.js has loaded these are no-ops, so the flow still works.
let jar = { kick() {}, setFill() {} };
let walletArt = { kick() {}, pop() {} };
let coinFx = { land() {} };
let shareIcon = { press() {} };
let soundIcon = { press() {} };
let renderFrame = null;

Promise.all([
  import('three'),
  import('three/addons/loaders/SVGLoader.js'),
  import('three/addons/environments/RoomEnvironment.js'),
  import('three/addons/geometries/RoundedBoxGeometry.js'),
  document.fonts.load('64px "BBH Bartle"').catch(() => {}),
  document.fonts.load('800 72px Geist').catch(() => {}),   // the coin's lettering is drawn into a texture once, so the font must be ready first
]).then(([THREE, { SVGLoader }, { RoomEnvironment }, { RoundedBoxGeometry }]) => {

  const renderer = new THREE.WebGLRenderer({ canvas: $('gl'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));   // never render above 2× — invisible, and 2–4× the pixels
  renderer.setClearColor(0x000000, 1);
  renderer.autoClear = false;
  const fit = () => renderer.setSize(innerWidth, innerHeight, false);
  fit();
  addEventListener('resize', fit);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  // A photo-studio environment for the hero coin: a near-black room lit only by a few large softboxes
  // and strips, like a product shoot in Blender. Metal is mostly reflection, so these long, clean
  // highlights are what make it read as real metal rather than plastic.
  const studioEnv = (() => {
    const s = new THREE.Scene();
    s.add(new THREE.Mesh(new THREE.BoxGeometry(24, 24, 24), new THREE.MeshBasicMaterial({ color: 0x080808, side: THREE.BackSide })));
    const box = (w, h, x, y, z, power, color = 0xffffff) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(power), side: THREE.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 0, 0); s.add(m);
    };
    box(7, 2.6, -5, 4.5, 6, 9);                 // key softbox, high left
    box(8, 5, 0, 0.5, 11, 1.4);                 // big soft front fill, so the face never goes dark
    box(1.3, 9, 7, 0.5, 3, 5);                  // tall strip, right
    box(10, 1.1, 0, 8, 1, 3.5);                 // overhead strip
    box(4, 4, -2, 2, -8, 3.2);                  // back light, for the rims
    box(9, 1, 0, -6, 4, 1.6, 0xc8ffea);         // low bounce card, faintly mint
    const g = new THREE.PMREMGenerator(renderer);
    const t = g.fromScene(s, 0.01).texture;
    g.dispose();
    return t;
  })();
  pmrem.dispose();

  /* ── Shared building blocks ── */

  const lathe = (pts, seg) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  const mirror = (half) => [...half, ...half.slice().reverse().map(([r, z]) => [r, -z])];

  // Fine ridges as a height map (coin edge, lid knurling).
  const ridges = (repeat) => {
    const c = document.createElement('canvas');
    c.width = 8; c.height = 2;
    const g = c.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, 8, 2);
    g.fillStyle = '#fff'; g.fillRect(0, 0, 4, 2);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.set(repeat, 1);
    return t;
  };

  const markShapes = SVGLoader.createShapes(
    new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90 90"><path d="${NEAR_MARK}"/></svg>`).paths[0],
  );

  const greenPolished = new THREE.MeshPhysicalMaterial({ color: NEAR_GREEN, metalness: 1, roughness: 0.16, clearcoat: 0.6, clearcoatRoughness: 0.15 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xd9dde0, metalness: 1, roughness: 0.32 });

  // Small coin for the jar and wallet: a rimmed disc, light enough to instance by the dozen.
  const smallCoin = lathe(mirror([[0, 0.07], [0.78, 0.07], [0.83, 0.1], [0.96, 0.1], [1, 0.06]]), 16).rotateX(Math.PI / 2);

  // A view = a scene drawn into the on-screen rectangle of a placeholder element.
  const views = [];
  // `bleed` lets a view draw that many pixels beyond its element on every side, without changing its scale.
  const addView = (el, camera, update, lights, bleed = 0) => {
    const scene = new THREE.Scene();
    scene.environment = env;
    lights.forEach((l) => scene.add(l));
    views.push({ el, scene, camera, update, bleed, tanHalf: Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) });
    return scene;
  };
  const sun = (intensity, x, y, z, color = 0xffffff) => {
    const l = new THREE.DirectionalLight(color, intensity);
    l.position.set(x, y, z);
    return l;
  };

  // Pointer tilt shared by the jar and the wallet.
  const hoverTilt = (el, onEnter) => {
    const s = { x: 0, y: 0, toX: 0, toY: 0 };
    el.addEventListener('pointerenter', onEnter);
    el.addEventListener('click', onEnter);
    el.addEventListener('pointermove', (e) => {
      const b = el.getBoundingClientRect();
      s.toY = ((e.clientX - b.left) / b.width - 0.5) * 0.9;
      s.toX = ((e.clientY - b.top) / b.height - 0.5) * 0.5;
    });
    el.addEventListener('pointerleave', () => { s.toX = s.toY = 0; });
    s.step = () => { s.x += (s.toX - s.x) * 0.1; s.y += (s.toY - s.y) * 0.1; };
    return s;
  };

  /* ═════════ Hero coin ═════════ */
  {
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    const mesh = new THREE.Group();
    let sway = -0.55;

    // Lighting: a strong key, a cool back light for the rim, and a slow orbiting glint so the metal
    // keeps catching the light even when the coin is still.
    const key = sun(3.0, -3, 4, 5);
    const back = sun(1.7, 4, -2, -3, 0xcffff0);
    const glint = sun(1.3, 0, 2, 4);

    /* Landing effects, triggered by settle(): a springy squash, a flash, a shockwave ring,
       and on a win a burst of small coins. */
    let landT = -1, landWin = false;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.03, 1.1, 64),
      new THREE.MeshBasicMaterial({ color: NEAR_GREEN, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    ring.position.z = -0.2;
    const BURST = 28;
    const burst = new THREE.InstancedMesh(smallCoin, greenPolished, BURST);
    burst.count = 0;
    burst.frustumCulled = false;
    const bits = Array.from({ length: BURST }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), spin: new THREE.Vector3(), s: 0 }));
    const bm = new THREE.Matrix4(), bq = new THREE.Quaternion(), be = new THREE.Euler(), bs = new THREE.Vector3();
    coinFx = {
      land(win) {
        landT = 0; landWin = win;
        ring.material.color.set(win ? NEAR_GREEN : 0x8a8a8a);
        if (!win) return;
        for (const b of bits) {
          const a = Math.random() * TAU, sp = 2.2 + Math.random() * 3.2;
          b.p.set(Math.cos(a) * 0.5, Math.sin(a) * 0.5, -0.3);
          b.v.set(Math.cos(a) * sp, Math.sin(a) * sp + 1.6, (Math.random() - 0.5) * 2);
          b.spin.set(Math.random() * 12, Math.random() * 12, Math.random() * 12);
          b.s = 0.07 + Math.random() * 0.06;
        }
      },
    };

    const scene = addView($('stage'), camera, (t, dt, aspect) => {
      camera.position.z = 6.1 * Math.max(1, 0.9 / aspect);   // keep the whole coin in view on narrow stages
      const lift = Math.min(1, coin.lift);
      // Turn about the vertical axis: a set-back three-quarter view at rest, a gentle sway once in play.
      const swayTo = motion === 'idle' ? -0.55 + Math.sin(t * 0.7) * 0.22
        : motion === 'hover' ? Math.sin(t * 1.1) * 0.36 : 0;
      sway += (swayTo - sway) * 0.08;

      // Landing: spring back from a squash; a loss also gets a small shake of the head.
      let squash = 0, shake = 0, flash = 0;
      if (landT >= 0) {
        landT += dt;
        squash = 0.13 * Math.exp(-6 * landT) * Math.cos(19 * landT);
        flash = Math.exp(-7 * landT);
        if (!landWin) shake = Math.sin(landT * 34) * 0.16 * Math.exp(-5 * landT);
        const k = Math.min(1, landT / 0.6);
        ring.scale.setScalar(1 + easeOut(k) * 1.5);
        ring.material.opacity = (1 - k) * (landWin ? 0.9 : 0.45);

        if (landWin && landT < 1.4) {
          burst.count = BURST;
          bits.forEach((b, i) => {
            b.v.y -= 9 * dt;
            b.p.addScaledVector(b.v, dt);
            const s = b.s * Math.max(0, 1 - landT / 1.4);
            be.set(b.spin.x * landT, b.spin.y * landT, b.spin.z * landT);
            burst.setMatrixAt(i, bm.compose(b.p, bq.setFromEuler(be), bs.setScalar(s)));
          });
          burst.instanceMatrix.needsUpdate = true;
        } else burst.count = 0;
        if (landT > 1.6) { landT = -1; ring.material.opacity = 0; }
      }

      mesh.rotation.set(-coin.theta + hand.pitch + hand.leanX, sway + coin.yaw + shake + hand.yaw + hand.leanY, 0);
      mesh.position.set(0, coin.lift * 1.2, -1.6 * lift);
      mesh.scale.setScalar(1 + coin.zoom + squash);

      key.intensity = 3.0 + flash * 4;
      glint.position.set(Math.cos(t * 0.55) * 4, 2 + Math.sin(t * 0.4), 3 + Math.sin(t * 0.55) * 3);
    }, [key, back, glint, new THREE.AmbientLight(0xffffff, 0.15)], 600);   // the landing ring and coin burst spill well past the stage
    scene.add(ring, burst);
    scene.environment = studioEnv;

    /* Quality: the full coin is ~230k triangles. Phones, touch devices and machines with ≤4 cores or ≤4 GB
       get a lite build (~35k) that looks nearly the same at their screen size — the lettering becomes a
       shading map instead of real geometry, and curves use fewer segments. ?quality=lite|full overrides. */
    const QUALITY = new URLSearchParams(location.search).get('quality');
    const LITE = QUALITY === 'lite' || (QUALITY !== 'full' && (
      matchMedia('(max-width: 640px), (pointer: coarse)').matches
      || (navigator.deviceMemory && navigator.deviceMemory <= 4)
      || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)));
    const Q = LITE
      ? { edge: 360, bevel: 6, bead: [360, 6], rim: [14, 128], mark: [7, 12], zero: [7, 40], field: 96 }
      : { edge: 720, bevel: 12, bead: [720, 10], rim: [24, 256], mark: [12, 24], zero: [12, 96], field: 192 };
    window.__nflipQuality = LITE ? 'lite' : 'full';

    /* The coin, after the struck-medal reference: one soft, polished metal throughout; a scalloped,
       rolled edge; a wide band with bold raised lettering; a fat rolled rim around a calm centre; and an
       inflated, rounded mark. Shape comes from rounded relief catching the light, not from patterns. */
    const metal = new THREE.MeshPhysicalMaterial({ color: NEAR_GREEN, metalness: 1, roughness: 0.26, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 1.35 });

    // Body: a scalloped disc — 22 soft waves round the edge — extruded with a deep rounded bevel,
    // so the whole rim rolls over like a bottle cap.
    const WAVES = 22, R0 = 0.96, AMP = 0.016, D = 0.07, BEVEL = 0.045;
    const scallop = (r0, amp) => Array.from({ length: Q.edge }, (_, i) => {
      const a = (i / Q.edge) * TAU, r = r0 + amp * Math.cos(WAVES * a);
      return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
    });
    mesh.add(new THREE.Mesh(
      new THREE.ExtrudeGeometry(new THREE.Shape(scallop(R0, AMP)), {
        depth: D, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: 0.04, bevelSegments: Q.bevel, steps: 1,
      }).translate(0, 0, -D / 2),
      metal,
    ));
    const TOP = D / 2 + BEVEL;             // height of each face

    // A thin raised bead following the scallop, just inside the rolled edge.
    const beadPath = new THREE.CatmullRomCurve3(scallop(R0 - 0.07, AMP * 0.8).filter((_, i) => i % 2 === 0).map((v) => new THREE.Vector3(v.x, v.y, 0)), true);
    const beadGeo = new THREE.TubeGeometry(beadPath, Q.bead[0], 0.012, Q.bead[1], true);

    // Bold raised lettering round the band — as real geometry. The text is painted into a soft height
    // map, and a finely divided ring is pushed up by it, so each letter has true depth, a silhouette and
    // its own lighting. A cavity map baked from the same heights darkens the crevices around the
    // letters, the way ambient occlusion does in a Blender render.
    const R_IN = 0.655, R_OUT = 0.86, LETTER = 0.032;
    const bandMesh = (text) => {
      const S = 1024;
      const hc = document.createElement('canvas');
      hc.width = hc.height = S;
      const g = hc.getContext('2d', { willReadFrequently: true });
      g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
      g.fillStyle = '#fff';
      g.filter = 'blur(3px)';
      g.font = '800 72px Geist, system-ui, sans-serif';   // Geist, heavy, as big as fits ~41 characters round the band
      g.textAlign = 'center'; g.textBaseline = 'middle';
      const radius = (S / 2) * ((R_OUT + R_IN) / 2 / R_OUT);
      const chars = [...text];
      chars.forEach((ch, i) => {
        g.save(); g.translate(S / 2, S / 2); g.rotate((i / chars.length) * TAU); g.fillText(ch, 0, -radius); g.restore();
      });
      const H = g.getImageData(0, 0, S, S).data;
      const at = (px, py) => {                           // bilinear height lookup, 0…1
        const x0 = Math.max(0, Math.min(S - 2, Math.floor(px))), y0 = Math.max(0, Math.min(S - 2, Math.floor(py)));
        const fx = px - x0, fy = py - y0, v = (x, y) => H[(y * S + x) * 4] / 255;
        return (v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx) * (1 - fy) + (v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx) * fy;
      };

      // Full: a ring 720 steps round and 36 across (about 3 vertices across every letter stroke), pushed up
      // by the heights. Lite: a flat ring, with the same heights used as a shading (bump) map instead.
      const geo = LITE ? new THREE.RingGeometry(R_IN, R_OUT, 256, 1) : new THREE.RingGeometry(R_IN, R_OUT, 720, 36);
      if (!LITE) {
        const pos = geo.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i);
          pos.setZ(i, at((x / R_OUT * 0.5 + 0.5) * S, (0.5 - y / R_OUT * 0.5) * S) * LETTER);
        }
        geo.computeVertexNormals();
      }

      // Cavity: where the surroundings stand higher than a point, it sits in a crevice and gets less light.
      const bc = document.createElement('canvas');
      bc.width = bc.height = S;
      const bg = bc.getContext('2d', { willReadFrequently: true });
      bg.filter = 'blur(10px)'; bg.drawImage(hc, 0, 0);
      const B = bg.getImageData(0, 0, S, S).data;
      const out = bg.createImageData(S, S);
      for (let i = 0; i < S * S; i++) {
        const v = Math.round(255 * Math.max(0.38, Math.min(1, 1 - (B[i * 4] - H[i * 4]) / 255 * 2.4)));
        out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v; out.data[i * 4 + 3] = 255;
      }
      bg.filter = 'none'; bg.putImageData(out, 0, 0);
      const ao = new THREE.CanvasTexture(bc);
      ao.anisotropy = 8;
      // Roughness: letter tops polished (they catch the softboxes as crisp highlights), the band between satin.
      const rc = document.createElement('canvas');
      rc.width = rc.height = S;
      const rg = rc.getContext('2d');
      const rough = rg.createImageData(S, S);
      for (let i = 0; i < S * S; i++) {
        const v = Math.round(255 * (0.42 - 0.26 * (H[i * 4] / 255)));
        rough.data[i * 4] = rough.data[i * 4 + 1] = rough.data[i * 4 + 2] = v; rough.data[i * 4 + 3] = 255;
      }
      rg.putImageData(rough, 0, 0);
      const roughMap = new THREE.CanvasTexture(rc);
      roughMap.anisotropy = 8;
      const mat = new THREE.MeshPhysicalMaterial({
        color: NEAR_GREEN, metalness: 1, roughness: 1, roughnessMap: roughMap, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 1.35,
        aoMap: ao, aoMapIntensity: 1,
      });
      if (LITE) { const bump = new THREE.CanvasTexture(hc); bump.anisotropy = 8; mat.bumpMap = bump; mat.bumpScale = 10; }
      return new THREE.Mesh(geo, mat);
    };
    // Two small raised words either side of the mark, like the reference's ESTD / 2020; nothing else in the field.
    const fieldText = (left, right) => {
      const c = document.createElement('canvas');
      c.width = c.height = 512;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, 512, 512);
      g.fillStyle = '#fff';
      g.filter = 'blur(1.2px)';
      g.font = '700 24px Geist, system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(left, 92, 258); g.fillText(right, 420, 258);
      const t = new THREE.CanvasTexture(c);
      t.anisotropy = 8;
      return new THREE.MeshPhysicalMaterial({ color: 0x00dc8c, metalness: 1, roughness: 0.4, envMapIntensity: 1.3, bumpMap: t, bumpScale: 4 });
    };

    const fieldGeo = new THREE.CircleGeometry(R_IN - 0.03, Q.field);
    const rimGeo = new THREE.TorusGeometry(R_IN - 0.012, 0.03, Q.rim[0], Q.rim[1]);     // the fat rolled rim between band and centre

    // Each side is built facing +Z; the zero side is then turned over on X so it reads upright after a flip.
    const side = (text, left, right, relief) => {
      const g = new THREE.Group();
      const band = bandMesh(text);
      band.position.z = TOP + 0.001;
      const field = new THREE.Mesh(fieldGeo, fieldText(left, right));
      field.position.z = TOP + 0.001;
      const rim = new THREE.Mesh(rimGeo, metal);
      rim.position.z = TOP + 0.006;
      const bead = new THREE.Mesh(beadGeo, metal);
      bead.position.z = TOP;
      relief.position.z = TOP;
      g.add(band, field, rim, bead, relief);
      return g;
    };

    // NEAR side: the mark, inflated — a deep, generously rounded bevel so it reads soft and puffy.
    const mark = new THREE.Mesh(
      new THREE.ExtrudeGeometry(markShapes, {
        depth: 2.5, bevelEnabled: true, bevelThickness: 4.2, bevelSize: 2.4, bevelSegments: Q.mark[0], curveSegments: Q.mark[1],
      }).translate(-45, -45, 0),
      metal,
    );
    const k = 0.56 / 90;
    mark.scale.set(k, -k, k);            // SVG y points down

    // Zero side: an inflated 0. The band text repeats twice so the face looks the same after a half-turn.
    // Tails: a four-pointed sparkle, inflated like the mark. (The old "0" meant losing; now either face can win.)
    const zeroShape = new THREE.Shape();
    { const R = 0.34, k = 0.07;
      zeroShape.moveTo(0, R); zeroShape.quadraticCurveTo(k, k, R, 0); zeroShape.quadraticCurveTo(k, -k, 0, -R);
      zeroShape.quadraticCurveTo(-k, -k, -R, 0); zeroShape.quadraticCurveTo(-k, k, 0, R); }
    const zero = new THREE.Mesh(new THREE.ExtrudeGeometry(zeroShape, {
      depth: 0.012, bevelEnabled: true, bevelThickness: 0.034, bevelSize: 0.022, bevelSegments: Q.zero[0], curveSegments: Q.zero[1],
    }), metal);

    const nearSide = side('HEADS • 2X • NEAR • HEADS • 2X • NEAR • ', 'FAIR', '50/50', mark);
    const zeroSide = side('TAILS • 2X • NEAR • TAILS • 2X • NEAR • ', 'FAIR', '50/50', zero);
    zeroSide.rotation.x = Math.PI;
    mesh.add(nearSide, zeroSide);
    scene.add(mesh);
  }

  /* ═════════ Bank jar ═════════ */
  jar = (() => {
    const el = $('jar');
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 0.95, 5.2);
    camera.lookAt(0, 0.06, 0);
    const group = new THREE.Group();

    /* Glass: one turned profile running down the outside and back up the inside, so the wall,
       the heavy base and the rolled lip all have real thickness. */
    // Clear glass has no colour of its own: it only adds reflections on top of whatever is behind it.
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x050807,   // the faintest trace of body so the walls read on black
      metalness: 0, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.1,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const outer = [   // bottom → top
      [0, -0.93], [0.48, -0.93], [0.6, -0.915], [0.69, -0.86], [0.735, -0.76],
      [0.74, -0.68], [0.756, -0.65], [0.756, -0.62], [0.74, -0.59],           // bead above the base
      [0.74, 0.24], [0.756, 0.27], [0.756, 0.3], [0.74, 0.33],                // bead below the shoulder
      [0.715, 0.46], [0.65, 0.58], [0.56, 0.67], [0.515, 0.71],               // shoulder
      [0.505, 0.74], [0.505, 0.9], [0.53, 0.915], [0.535, 0.94], [0.52, 0.958],  // neck and rolled lip
    ];
    const inner = [   // top → bottom
      [0.47, 0.958], [0.465, 0.74], [0.52, 0.665], [0.61, 0.575], [0.675, 0.455], [0.7, 0.32],
      [0.7, -0.74], [0.66, -0.82], [0.56, -0.855], [0.2, -0.845], [0, -0.83],    // thick base with a shallow punt
    ];
    group.add(new THREE.Mesh(lathe([...outer, ...inner], 64), glass));

    // Edge glow: glass is brightest where you look along its surface. This is what draws the silhouette.
    const edgeGlow = new THREE.ShaderMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { tint: { value: new THREE.Color(0xdcfff2) } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 tint; varying vec3 vN; varying vec3 vV;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.2);
          gl_FragColor = vec4(tint * f * 0.5, 1.0);
          #include <colorspace_fragment>
        }`,
    });
    group.add(new THREE.Mesh(lathe(outer, 64), edgeGlow));

    // Screw threads moulded into the neck, just visible under the lid's skirt.
    const thread = new THREE.TorusGeometry(0.512, 0.012, 6, 64);
    for (const y of [0.775, 0.815]) {
      const ring = new THREE.Mesh(thread, glass);
      ring.rotation.set(Math.PI / 2 + 0.035, 0, 0);
      ring.position.y = y;
      group.add(ring);
    }

    // NEAR mark moulded in relief on the front of the glass, wrapped to the jar's curve.
    {
      const R = 0.742, s = 0.5 / 90;
      const geo = new THREE.ExtrudeGeometry(markShapes, { depth: 3, bevelEnabled: true, bevelThickness: 1, bevelSize: 0.8, bevelSegments: 2, curveSegments: 8 })
        .translate(-45, -45, 0).scale(s, -s, s);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const a = pos.getX(i) / R, r = R + pos.getZ(i);
        pos.setXYZ(i, Math.sin(a) * r, pos.getY(i) - 0.18, Math.cos(a) * r);
      }
      geo.computeVertexNormals();
      const moulded = glass.clone();
      moulded.envMapIntensity = 5;
      group.add(new THREE.Mesh(geo, moulded));
    }

    /* Lid: knurled steel skirt, rolled lower edge, stamped rings on top, a framed coin slot. */
    const knurled = new THREE.MeshStandardMaterial({ color: 0xd9dde0, metalness: 1, roughness: 0.36, bumpMap: ridges(64), bumpScale: 3 });
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.575, 0.575, 0.2, 64, 1, true), knurled);
    skirt.position.y = 0.955;
    const cap = new THREE.Mesh(lathe([
      [0.58, 0.845], [0.597, 0.852], [0.597, 0.868], [0.578, 0.876],          // rolled lower edge
      [0.578, 1.04], [0.566, 1.064], [0.535, 1.076],                          // shoulder
      [0.46, 1.076], [0.445, 1.064], [0.36, 1.064], [0.345, 1.076],           // stamped ring
      [0.3, 1.076], [0.3, 1.07], [0, 1.07],
    ], 64), steel);
    const slotFrame = new THREE.Mesh(new RoundedBoxGeometry(0.6, 0.03, 0.15, 2, 0.015), steel);
    slotFrame.position.y = 1.076;
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.012, 0.062), new THREE.MeshBasicMaterial({ color: 0x000000 }));
    slot.position.y = 1.089;
    group.add(skirt, cap, slotFrame, slot);

    /* Coins settled in the bottom of the jar. */
    const coinMat = new THREE.MeshPhysicalMaterial({ color: NEAR_GREEN, metalness: 1, roughness: 0.24 });
    const CR = 0.2;                                 // coin radius inside the jar
    const MAX_COINS = 72;
    const pile = new THREE.InstancedMesh(smallCoin, coinMat, MAX_COINS);
    const rnd = (() => { let s = 11; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();   // fixed seed: same pile every load
    // Seven to a layer (one in the middle, six round it), each layer twisted against the last;
    // mostly lying flat, a few leaning on their neighbours.
    const base = Array.from({ length: MAX_COINS }, (_, i) => {
      const layer = Math.floor(i / 7), slotN = i % 7;
      const a = (slotN / 6) * TAU + layer * 0.9;
      const r = slotN === 6 ? rnd() * 0.06 : 0.41 + rnd() * 0.07;
      const leaning = rnd() < 0.18;
      return {
        pos: new THREE.Vector3(Math.cos(a) * r, -0.795 + layer * 0.058 + rnd() * 0.02, Math.sin(a) * r),
        // smallCoin faces +Z, so −90° on X lays it flat
        rot: new THREE.Euler(-Math.PI / 2 + (rnd() - 0.5) * (leaning ? 1.3 : 0.28), 0, rnd() * TAU, 'YXZ'),
        tiltY: rnd() * TAU,
        amp: 0.04 + rnd() * 0.1, freq: 9 + rnd() * 7, phase: rnd() * TAU,
      };
    });
    group.add(pile);

    /* Hang tag: a card with real thickness, a steel eyelet, and twine looped round the neck. */
    const tagW = 0.86, tagH = 0.42, eyeX = 0.1;
    const card = new THREE.Shape();
    {
      const r = 0.07, w = tagW, h = tagH / 2;
      card.moveTo(0.12, -h); card.lineTo(w - r, -h); card.quadraticCurveTo(w, -h, w, -h + r);
      card.lineTo(w, h - r); card.quadraticCurveTo(w, h, w - r, h); card.lineTo(0.12, h);
      card.lineTo(0, 0.09); card.lineTo(0, -0.09); card.closePath();                       // clipped corners at the eyelet end
      card.holes.push(new THREE.Path().absarc(eyeX, 0, 0.035, 0, TAU));
    }
    const tagPivot = new THREE.Group();             // pivots at the eyelet so the tag can swing
    tagPivot.position.set(0.47, 0.72, 0.4);
    const tagBody = new THREE.Mesh(
      new THREE.ExtrudeGeometry(card, { depth: 0.014, bevelEnabled: false, curveSegments: 6 }).translate(-eyeX, 0, -0.007),
      new THREE.MeshStandardMaterial({ color: NEAR_GREEN, roughness: 0.6 }),
    );
    const label = (() => {
      const c = document.createElement('canvas');
      c.width = 512; c.height = 256;
      const g = c.getContext('2d');
      g.fillStyle = '#000';
      g.font = '120px "BBH Bartle", Geist, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('BANK', 256, 136, 470);
      const t = new THREE.CanvasTexture(c);
      t.anisotropy = 8;
      return new THREE.Mesh(
        new THREE.PlaneGeometry(0.62, 0.31),
        new THREE.MeshBasicMaterial({ map: t, transparent: true, side: THREE.DoubleSide }),
      );
    })();
    label.position.set(0.44 - eyeX + 0.07, 0, 0.009);
    const eyelet = new THREE.Mesh(new THREE.TorusGeometry(0.04, 0.011, 6, 20), steel);
    tagPivot.add(tagBody, label, eyelet);

    const twineMat = new THREE.MeshStandardMaterial({ color: 0xe9e2d0, roughness: 0.9 });
    const neckLoop = new THREE.Mesh(new THREE.TorusGeometry(0.515, 0.009, 5, 48), twineMat);
    neckLoop.rotation.x = Math.PI / 2 + 0.06; neckLoop.position.y = 0.735;
    const twine = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.33, 0.74, 0.395), new THREE.Vector3(0.4, 0.75, 0.43), new THREE.Vector3(0.47, 0.72, 0.4),
    ]), 8, 0.009, 5), twineMat);
    group.add(tagPivot, neckLoop, twine);

    /* Finer detail */
    // Green rubber seal squeezed between lid and glass.
    const seal = new THREE.Mesh(new THREE.TorusGeometry(0.536, 0.022, 8, 64), new THREE.MeshStandardMaterial({ color: NEAR_GREEN, roughness: 0.5 }));
    seal.rotation.x = Math.PI / 2; seal.position.y = 0.842;
    // Crimps pressed into the lid's lower edge.
    const crimps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.02, 8, 6), steel, 16);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * TAU;
      crimps.setMatrixAt(i, new THREE.Matrix4().makeTranslation(Math.cos(a) * 0.59, 0.905, Math.sin(a) * 0.59));
    }
    // Two mould seams running up the glass, and graduation marks moulded into one side.
    const raised = glass.clone();
    raised.envMapIntensity = 3;
    const seamGeo = new THREE.CylinderGeometry(0.007, 0.007, 0.92, 5);
    for (const a of [0.9, 0.9 + Math.PI]) {
      const seam = new THREE.Mesh(seamGeo, raised);
      seam.position.set(Math.sin(a) * 0.742, -0.17, Math.cos(a) * 0.742);
      group.add(seam);
    }
    for (let i = 0; i < 6; i++) {
      const tick = new THREE.Mesh(new THREE.TorusGeometry(0.744, 0.007, 4, 8, i % 2 ? 0.16 : 0.28), raised);
      tick.rotation.set(Math.PI / 2, 0, -1.25);        // lies flat, arc starting round the right-hand side
      tick.position.y = -0.5 + i * 0.13;
      group.add(tick);
    }
    // Light from the coins pooling on the jar floor.
    const floorGlow = new THREE.Mesh(
      new THREE.CircleGeometry(0.68, 32),
      new THREE.MeshBasicMaterial({
        transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        map: (() => {
          const c = document.createElement('canvas');
          c.width = c.height = 128;
          const g = c.getContext('2d');
          const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
          grad.addColorStop(0, 'rgba(0,236,151,.9)'); grad.addColorStop(1, 'rgba(0,236,151,0)');
          g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
          const t = new THREE.CanvasTexture(c);
          t.colorSpace = THREE.SRGBColorSpace;
          return t;
        })(),
      }),
    );
    floorGlow.rotation.x = -Math.PI / 2; floorGlow.position.y = -0.842;
    group.add(seal, crimps, floorGlow);

    /* Reflections on the glass: soft bright shapes, as if from studio lights and a window.
       They belong to the room, not the jar, so they stay put while the jar turns beneath them. */
    const reflections = new THREE.Group();
    {
      // A soft-edged white patch; `panes` cuts it into a window grid.
      const patch = (panes = 0) => {
        const c = document.createElement('canvas');
        c.width = 64; c.height = 256;
        const g = c.getContext('2d');
        const across = g.createLinearGradient(0, 0, 64, 0);
        across.addColorStop(0, 'rgba(255,255,255,0)'); across.addColorStop(0.5, 'rgba(255,255,255,1)'); across.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = across; g.fillRect(0, 0, 64, 256);
        g.globalCompositeOperation = 'destination-in';
        const along = g.createLinearGradient(0, 0, 0, 256);
        along.addColorStop(0, 'rgba(0,0,0,0)'); along.addColorStop(0.18, 'rgba(0,0,0,1)'); along.addColorStop(0.82, 'rgba(0,0,0,1)'); along.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = along; g.fillRect(0, 0, 64, 256);
        if (panes) {
          g.globalCompositeOperation = 'destination-out';
          g.fillStyle = '#000';
          g.fillRect(29, 0, 6, 256);                                       // glazing bars
          for (let i = 1; i < panes; i++) g.fillRect(0, (256 / panes) * i - 3, 64, 6);
        }
        const t = new THREE.CanvasTexture(c);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      };
      const soft = patch(), windowTex = patch(2);
      // A patch wrapped round part of the jar wall. Angles are measured from the front (0), left negative.
      const on = (map, a0, a1, y0, y1, opacity, r = 0.749) => {
        const m = new THREE.Mesh(
          new THREE.CylinderGeometry(r, r, y1 - y0, 20, 1, true, a0, a1 - a0),
          new THREE.MeshBasicMaterial({ map, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        m.position.y = (y0 + y1) / 2;
        reflections.add(m);
      };
      on(soft, -1.12, -0.74, -0.6, 0.24, 0.4);          // tall key-light strip down the left
      on(soft, -0.68, -0.6, -0.56, 0.2, 0.26);            // its thin companion
      on(windowTex, 0.42, 0.86, -0.12, 0.26, 0.26);       // a window, upper right
      on(soft, 0.98, 1.16, -0.62, 0.1, 0.18);            // fill light catching the right edge
      on(soft, -0.5, 0.2, 0.5, 0.6, 0.22, 0.69);          // a glint across the shoulder
    }

    /* Motion: hover tilts the jar toward the pointer, rattles the coins, and swings the tag. */
    let kick = 0, fill = 0, dirty = true;
    const kickIt = () => { kick = 1; };
    const tilt = hoverTilt(el, kickIt);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), e = new THREE.Euler(0, 0, 0, 'YXZ'), sc = new THREE.Vector3(CR, CR, CR);
    const setFill = (bankroll) => { fill = Math.max(7, Math.min(MAX_COINS, Math.round((bankroll / 100) * 54))); pile.count = fill; dirty = true; };
    setFill(S.bankroll);

    const scene = addView(el, camera, (t, dt) => {
      kick *= Math.pow(0.04, dt);                    // rattle dies away in about a second
      tilt.step();
      group.rotation.set(tilt.x, tilt.y + Math.sin(t * 0.6) * 0.2, 0.08 + Math.sin(t * 22) * 0.05 * kick);
      group.position.y = Math.abs(Math.sin(t * 11)) * 0.05 * kick;
      reflections.rotation.set(tilt.x, tilt.y * 0.35, group.rotation.z);   // follows the tilt, ignores the turn
      reflections.position.y = group.position.y;

      // Only rewrite the instance matrices while the coins are actually moving.
      if (dirty || kick > 0.004) {
        for (let i = 0; i < fill; i++) {
          const c = base[i];
          const hop = Math.abs(Math.sin(t * c.freq + c.phase)) * c.amp * kick;
          p.copy(c.pos); p.y += hop;
          e.set(c.rot.x + hop * 2.5, c.tiltY, c.rot.z);
          pile.setMatrixAt(i, m.compose(p, q.setFromEuler(e), sc));
        }
        pile.instanceMatrix.needsUpdate = true;
        dirty = false;
      }

      tagPivot.rotation.z = -1.02 + Math.sin(t * 1.3) * 0.04 + Math.sin(t * 14) * 0.22 * kick;
    }, [sun(2.2, -2, 4, 4), sun(1.1, 3, 1, -3, 0xbfffe8)]);
    scene.add(group, reflections);

    return { kick: kickIt, setFill };
  })();

  /* ═════════ Icons: share, sound and wallet ═════════
     Soft, inflated shapes in matte black, after the reference: flat outlines with rounded corners,
     extruded with a deep rounded bevel so every edge rolls over like a cushion. */
  {
    // Clear glass, after the capsule reference. Glass on black has almost no colour of its own: it is the
    // reflections on its front and back surfaces, plus a bright rim where you look along the surface.
    // So: a reflection-only surface added on top of the page (seen from both sides), and a fresnel rim.
    const rubber = new THREE.MeshPhysicalMaterial({
      color: 0x05080c, metalness: 0, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.7,
      iridescence: 0.4, iridescenceIOR: 1.5, iridescenceThicknessRange: [250, 550],   // the blue-amber sheen in the reference
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    const rimGlow = new THREE.ShaderMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
      uniforms: { tint: { value: new THREE.Color(0xd6ecff) } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 tint; varying vec3 vN; varying vec3 vV;
        void main() {
          float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.4);
          gl_FragColor = vec4(tint * f * 0.95, 1.0);
          #include <colorspace_fragment>
        }`,
    });

    // A closed outline through `pts` with every corner rounded to radius r (or less, where edges are short).
    const rounded = (pts, r, s = new THREE.Shape()) => {   // pass a THREE.Path as `s` to draw a hole
      const v = pts.map(([x, y]) => new THREE.Vector2(x, y));
      v.forEach((cur, i) => {
        const prev = v[(i + v.length - 1) % v.length], next = v[(i + 1) % v.length];
        const d = Math.min(r, cur.distanceTo(prev) / 2, cur.distanceTo(next) / 2);
        const a = cur.clone().add(prev.clone().sub(cur).setLength(d));
        const b = cur.clone().add(next.clone().sub(cur).setLength(d));
        i === 0 ? s.moveTo(a.x, a.y) : s.lineTo(a.x, a.y);
        s.quadraticCurveTo(cur.x, cur.y, b.x, b.y);
      });
      s.closePath();
      return s;
    };
    // A curved band: part of a ring centred on (cx, 0), spanning ±a.
    const band = (cx, r, w, a) => {
      const s = new THREE.Shape();
      s.absarc(cx, 0, r + w / 2, -a, a, false);
      s.absarc(cx, 0, r - w / 2, a, -a, true);
      s.closePath();
      return s;
    };
    const puff = (shape) => {
      // extra smoothness: a mirror finish shows every facet
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.24, bevelEnabled: true, bevelThickness: 0.13, bevelSize: 0.085, bevelSegments: 8, curveSegments: 16 }).translate(0, 0, -0.12);
      const g = new THREE.Group();
      g.add(new THREE.Mesh(geo, rubber), new THREE.Mesh(geo, rimGlow));
      return g;
    };

    // One icon = a group in its own small view that leans toward the pointer and squashes when pressed.
    const icon = (el, parts, each = () => {}, onEnter = () => {}) => {
      const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
      camera.position.set(0, 0, 6.3);
      const group = new THREE.Group();
      group.add(...parts);
      let pressT = 9, appear = 1;
      const tilt = hoverTilt(el, onEnter);
      const scene = addView(el, camera, (t, dt) => {
        pressT += dt;
        tilt.step();
        each(t, dt);
        group.rotation.set(-0.22 + tilt.x, 0.42 + tilt.y * 0.7 + Math.sin(t * 0.8) * 0.06, 0.05);
        appear += (1 - appear) * Math.min(1, dt * 9);
        group.scale.setScalar(appear * (1 - 0.22 * Math.exp(-7 * pressT) * Math.cos(19 * pressT)));   // squash, then spring back
      }, [sun(2.6, -3, 4, 5), sun(3.2, 4, 2, -2, 0xbfd8ff), sun(1.6, 0, -4, 2, 0xffd2a0), new THREE.AmbientLight(0xffffff, 0.1)]);   // cool rim, warm under-light
      scene.add(group);
      return { press() { pressT = 0; }, pop() { appear = 0; pressT = 0; } };
    };

    /* Share: an arrow lifting out of a tray. */
    const arrow = puff(rounded([[0, 1.0], [-0.6, 0.3], [-0.22, 0.3], [-0.22, -0.42], [0.22, -0.42], [0.22, 0.3], [0.6, 0.3]], 0.1));
    arrow.position.set(0, 0.1, 0.06);
    const tray = puff(rounded([[-0.98, -0.1], [-0.98, -0.95], [0.98, -0.95], [0.98, -0.1], [0.72, -0.1], [0.72, -0.69], [-0.72, -0.69], [-0.72, -0.1]], 0.13));
    let lift = 0;
    shareIcon = icon($('shareArt'), [arrow, tray], (t, dt) => {
      lift = Math.max(0, lift - dt * 1.6);
      arrow.position.y = 0.1 + Math.sin(lift * Math.PI) * 0.35;     // the arrow hops when you share
    });
    const sharePress = shareIcon.press;
    shareIcon.press = () => { sharePress(); lift = 1; };

    /* Sound: a speaker, with waves when on and a cross when off. */
    const speaker = puff(rounded([[-0.98, -0.27], [-0.58, -0.27], [-0.1, -0.7], [-0.1, 0.7], [-0.58, 0.27], [-0.98, 0.27]], 0.1));
    const waves = [puff(band(-0.1, 0.42, 0.13, 0.85)), puff(band(-0.1, 0.8, 0.13, 0.85))];
    const cross = new THREE.Group();
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const bar = puff(rounded([[-0.44, -0.05], [0.44, -0.05], [0.44, 0.05], [-0.44, 0.05]], 0.05));
      bar.rotation.z = a;
      cross.add(bar);
    }
    cross.position.set(0.56, 0, 0);
    let on = sfx.muted() ? 0 : 1;
    soundIcon = icon($('soundArt'), [speaker, ...waves, cross], (t, dt) => {
      on += ((sfx.muted() ? 0 : 1) - on) * Math.min(1, dt * 12);
      waves.forEach((w, i) => {
        w.scale.setScalar(Math.max(0.001, on) * (1 + Math.sin(t * 5 - i * 0.9) * 0.035 * on));   // the waves breathe while sound is on
        w.visible = on > 0.02;
      });
      cross.scale.setScalar(Math.max(0.001, 1 - on));
      cross.visible = on < 0.98;
    });

    /* Wallet: a billfold seen from the front — the back panel showing above the body, and a clasp
       with a single green stud, the one spot of colour. */
    const backPanel = puff(rounded([[-0.9, 0.1], [-0.9, 0.8], [0.72, 0.8], [0.72, 0.1]], 0.2));
    backPanel.position.z = -0.24;
    const body = puff(rounded([[-1, -0.78], [1, -0.78], [1, 0.5], [-1, 0.5]], 0.22));
    const clasp = puff(rounded([[0.36, -0.4], [1.14, -0.4], [1.14, 0.12], [0.36, 0.12]], 0.2));
    clasp.position.z = 0.26;
    const stud = new THREE.Mesh(
      new THREE.SphereGeometry(0.105, 20, 14),
      new THREE.MeshPhysicalMaterial({ color: NEAR_GREEN, metalness: 1, roughness: 0.22 }),
    );
    stud.position.set(0.66, -0.14, 0.5);
    // A few small coins inside the glass, the same as in the jar, settled in the bottom of the body.
    const coinMat = new THREE.MeshPhysicalMaterial({ color: NEAR_GREEN, metalness: 1, roughness: 0.24 });
    const loose = [
      [-0.62, -0.5, -0.06, 0.5, 0.2], [-0.24, -0.56, 0.05, -0.35, -0.3], [0.14, -0.52, -0.08, 0.25, 0.4],
      [-0.42, -0.24, 0.1, -0.6, 0.15], [-0.02, -0.28, -0.12, 0.7, -0.2], [0.34, -0.3, 0.08, -0.2, 0.55],
    ].map(([x, y, z, rx, ry], i) => {
      const c = new THREE.Mesh(smallCoin, coinMat);
      c.scale.setScalar(0.22);
      c.position.set(x, y, z);
      c.rotation.set(rx, ry, i * 1.3);
      c.userData = { y, rx, phase: i * 1.9, freq: 10 + i };
      return c;
    });
    let rattle = 0;
    const wallet = icon($('walletArt'), [backPanel, body, clasp, stud, ...loose], (t, dt) => {
      rattle *= Math.pow(0.04, dt);              // the coins jump about inside, then settle
      loose.forEach((c) => {
        const hop = Math.abs(Math.sin(t * c.userData.freq + c.userData.phase)) * rattle;
        c.position.y = c.userData.y + hop * 0.22;
        c.rotation.x = c.userData.rx + hop * 1.2;
      });
    }, () => { wallet.press(); rattle = 1; });
    walletArt = { kick() { wallet.press(); rattle = 1; }, pop() { wallet.pop(); rattle = 1; } };
  }

  /* ── Draw every visible view into its element's rectangle ── */
  renderFrame = (t, dt) => {
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    const H = innerHeight, W = innerWidth;
    for (const v of views) {
      const b = v.el.getBoundingClientRect();
      if (!b.width || !b.height || b.bottom < 0 || b.top > H || b.right < 0 || b.left > W) continue;   // hidden or scrolled away: skip
      v.update(t, dt, b.width / b.height);
      // Grow the drawing rectangle by the bleed and widen the field of view to match,
      // so the subject stays the same size and in the same place — it just isn't cropped at the element's edge.
      const m = v.bleed, w = b.width + m * 2, h = b.height + m * 2;
      const fov = THREE.MathUtils.radToDeg(2 * Math.atan(v.tanHalf * (h / b.height)));
      if (v.camera.aspect !== w / h || v.camera.fov !== fov) { v.camera.aspect = w / h; v.camera.fov = fov; v.camera.updateProjectionMatrix(); }
      renderer.setViewport(b.left - m, H - b.bottom - m, w, h);
      renderer.setScissor(b.left - m, H - b.bottom - m, w, h);
      renderer.clearDepth();               // views can overlap now; each starts with a clean depth buffer
      renderer.render(v.scene, v.camera);
    }
  };
  window.__nflip = { renderer, views };   // for inspecting draw calls / triangle counts from the console
}).catch((err) => {
  $('stage').classList.add('poster');
  const cover = document.createElement('div');
  cover.id = 'cover';
  const lift = () => { cover.remove(); removeEventListener('keydown', lift); focusPrimary(); };
  cover.addEventListener('click', lift);
  addEventListener('keydown', lift);
  document.body.append(cover);   // no WebGL or no network (link-preview thumbnails, old devices): show a still of the coin instead
  console.error(err);
});

/* ───────────── Loop ───────────── */

/* ───────────── Coin in the hand ─────────────
   While the coin is at rest (start screen, connect, picking a stake) it can be played with:
   it leans toward the cursor, a drag turns it — sideways to spin, up/down to flip — and a flick
   sends it round before it springs back to face the viewer. All of this is extra rotation on top
   of the coin's own motion, so the game's animations are untouched and simply take over when it starts. */

const hand = { pitch: 0, yaw: 0, vPitch: 0, vYaw: 0, toPitch: 0, toYaw: 0, leanX: 0, leanY: 0, leanToX: 0, leanToY: 0, drag: null };
const canPlay = () => !S.busy && !readIntent() && ['idle', 'connect', 'bet'].includes(S.state);
{
  const el = $('stage');
  const PER_PX = 0.011;                       // radians of turn per pixel dragged
  const MAX_V = 30;                           // rad/s — caps how hard a flick can throw it
  const clamp = (v, m) => Math.max(-m, Math.min(m, v));

  const drop = () => {
    if (!hand.drag) return;
    hand.drag = null;
    el.classList.remove('grabbing');
    // Carry the flick forward a moment, then come to rest on the nearest whole turn — same face as before.
    hand.toPitch = Math.round((hand.pitch + hand.vPitch * 0.35) / TAU) * TAU;
    hand.toYaw = Math.round((hand.yaw + hand.vYaw * 0.35) / TAU) * TAU;
    if (Math.abs(hand.vPitch) + Math.abs(hand.vYaw) > 6) sfx.swish();
  };
  hand.drop = drop;

  el.addEventListener('pointerdown', (e) => {
    if (!canPlay() || e.button !== 0) return;
    e.preventDefault();                       // no text selection, and focus stays on the primary button
    try { el.setPointerCapture(e.pointerId); } catch {}
    hand.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    hand.vPitch = hand.vYaw = 0;
    el.classList.add('grabbing');
    sfx.tick();
  });
  addEventListener('pointermove', (e) => {
    // Lean toward the cursor wherever it is on the page.
    const b = el.getBoundingClientRect();
    hand.leanToY = clamp((e.clientX - (b.left + b.width / 2)) / (innerWidth / 2), 1) * 0.42;
    hand.leanToX = clamp((e.clientY - (b.top + b.height / 2)) / (innerHeight / 2), 1) * 0.32;

    const d = hand.drag;
    if (!d || e.pointerId !== d.id) return;
    const now = performance.now(), dt = Math.max(0.004, (now - d.t) / 1000);
    // Sideways turns the coin about its own upright axis; once it is flipped over, that axis points the other way.
    const flipped = Math.cos(-coin.theta + hand.pitch) < 0 ? -1 : 1;
    const dYaw = (e.clientX - d.x) * PER_PX * flipped, dPitch = (e.clientY - d.y) * PER_PX;
    hand.yaw += dYaw; hand.pitch += dPitch;
    hand.vYaw = clamp(hand.vYaw * 0.5 + (dYaw / dt) * 0.5, MAX_V);
    hand.vPitch = clamp(hand.vPitch * 0.5 + (dPitch / dt) * 0.5, MAX_V);
    d.x = e.clientX; d.y = e.clientY; d.t = now;
  });
  const release = (e) => {
    if (hand.drag && e.pointerId === hand.drag.id) {
      if (performance.now() - hand.drag.t > 80) hand.vPitch = hand.vYaw = 0;   // held still before letting go: no throw
      drop();
    }
    if (e.pointerType !== 'mouse') hand.leanToX = hand.leanToY = 0;            // a finger has left; nothing to lean toward
  };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);
  document.addEventListener('pointerleave', () => { hand.leanToX = hand.leanToY = 0; });

  hand.step = (dt) => {
    const play = canPlay() && !reducedMotion.matches;
    if (!play && hand.drag) { hand.vPitch = hand.vYaw = 0; drop(); }
    if (!hand.drag) {
      // A spring back to rest: a little bounce while playing, quick and firm once the game takes over.
      const k = play ? 42 : 150, c = play ? 8.5 : 24;
      hand.vPitch += ((hand.toPitch - hand.pitch) * k - hand.vPitch * c) * dt;
      hand.vYaw += ((hand.toYaw - hand.yaw) * k - hand.vYaw * c) * dt;
      hand.pitch += hand.vPitch * dt; hand.yaw += hand.vYaw * dt;
      for (const [p, v, to] of [['pitch', 'vPitch', 'toPitch'], ['yaw', 'vYaw', 'toYaw']]) {
        if (Math.abs(hand[to] - hand[p]) < 0.001 && Math.abs(hand[v]) < 0.01) hand[p] = hand[to] = hand[v] = 0;   // settled: whole turns are the same as none
      }
    }
    const lean = play && !hand.drag ? 1 : 0, ease = Math.min(1, dt * 6);
    hand.leanX += (hand.leanToX * lean - hand.leanX) * ease;
    hand.leanY += (hand.leanToY * lean - hand.leanY) * ease;
  };
}

let lastMs = 0;
function frame(ms) {
  const t = ms / 1000;
  const dt = Math.min(0.05, (ms - lastMs) / 1000);
  lastMs = ms;
  hand.step(dt);
  if (reducedMotion.matches) { coin.theta = S.active?.outcome === 'pending' ? Math.PI / 2 : faceTheta; coin.lift = 0; coin.yaw = 0; }
  else if (motion === 'float') {
    const before = Math.floor(coin.theta / Math.PI + 0.5);
    coin.theta += TUMBLE * dt;
    coin.yaw += (Math.sin(t * 0.6) * 0.3 - coin.yaw) * Math.min(1, dt * 2);
    coin.lift = HANG + Math.sin(t * 1.3) * 0.05;
    if (Math.floor(coin.theta / Math.PI + 0.5) !== before) sfx.swish();   // a face has just swung past
  }
  else if (motion === 'idle') { coin.theta = REST + Math.sin(t * 0.9) * 0.08; coin.lift = 0.02 + Math.sin(t * 1.4) * 0.02; }
  else if (motion === 'hover') { coin.theta = faceTheta; if (!faceBusy()) coin.lift = 0.035 + Math.sin(t * 2) * 0.035; coin.zoom += (0.06 * (S.state === 'result') - coin.zoom) * Math.min(1, dt * 2); }
  if (renderFrame) renderFrame(t, dt);
  requestAnimationFrame(frame);
}

setState('idle');
requestAnimationFrame(frame);
void boot().catch(error => message(explain(error)));
