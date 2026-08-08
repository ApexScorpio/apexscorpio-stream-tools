// === HALLOWEEN OVERLAY — LINEAR, PEQUENO, MÁX 5, SEM FREEZE, SEM CABEÇA-PARA-BAIXO ===

// 1) EDITA AQUI com os teus ficheiros reais dentro da pasta /images
const SPRITES = [
  "images/bat.png",
  "images/witch.png",
  "images/ufo.gif",
  "images/ghost.png",
  // Ex.: "images/morcego_hd.png", "images/bruxa_real.png"
];

// 2) Configuração
const CONFIG = {
  count: 5,               // máximo de elementos simultâneos
  speed: [60, 120],       // px/s (a 1920x1080; escala com resolução)
  scale: [0.08, 0.18],    // BEM pequenos (ajusta se quiseres mais/menos)
  maxTiltDeg: 60,         // inclinação máxima (evita cabeça-para-baixo)
  spawnMargin: 100,       // margem fora do ecrã para aparecer/desaparecer
  lifetimeExtra: 1.25,    // atravessar o ecrã com folga
  fpsCap: 30              // loop fixo (evita throttling do rAF no OBS)
};

// Query params opcionais: ?density=1&speed=1&scale=1
const q = new URLSearchParams(location.search);
const density = parseFloat(q.get("density") || "1");
const speedMul = parseFloat(q.get("speed") || "1");
const scaleMul = parseFloat(q.get("scale") || "1");

// Canvas
const canvas = document.getElementById("fx");
const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });

let W = 0, H = 0, dpr = 1;
function resize() {
  dpr = window.devicePixelRatio || 1;
  W = canvas.width  = Math.max(2, Math.floor(innerWidth * dpr));
  H = canvas.height = Math.max(2, Math.floor(innerHeight * dpr));
  canvas.style.width  = innerWidth + "px";
  canvas.style.height = innerHeight + "px";
}
addEventListener("resize", resize, { passive: true });
resize();

// Helpers
const R  = (a,b) => Math.random()*(b-a)+a;
const RI = (a,b) => Math.floor(R(a, b+1));
const DEG2RAD = Math.PI / 180;

// PRELOAD (sem async no loop)
const IMAGES = []; // {src,img,w,h}
let preloaded = false;

function preloadAll(list, done) {
  let pend = list.length;
  if (pend === 0) { preloaded = true; done(); return; }
  list.forEach(src => {
    const im = new Image();
    im.onload = () => {
      IMAGES.push({
        src, img: im,
        w: im.naturalWidth || im.width,
        h: im.naturalHeight || im.height
      });
      if (--pend === 0) { preloaded = true; done(); }
    };
    im.onerror = () => {
      console.warn("Falhou imagem:", src);
      if (--pend === 0) { preloaded = true; done(); }
    };
    // buster leve para evitar cache agressiva do CEF
    im.src = src + (src.includes("?") ? "&" : "?") + "v=" + Date.now();
  });
}

// ACTOR (linear, upright)
function makeActor() {
  if (!IMAGES.length) return null;
  const it = IMAGES[RI(0, IMAGES.length - 1)];
  if (!it.w || !it.h) return null;

  const scale = R(CONFIG.scale[0], CONFIG.scale[1]) * scaleMul * (W/1920);
  const w = Math.max(1, it.w * scale);
  const h = Math.max(1, it.h * scale);

  const side = RI(0, 3); // 0 L, 1 R, 2 T, 3 B
  const m = CONFIG.spawnMargin * (W/1920);
  const maxTilt = CONFIG.maxTiltDeg * DEG2RAD;

  // vai para a esquerda?
  const goLeft = (side === 1) || (side !== 0 && Math.random() < 0.5);
  // tilt pequeno (nunca 180º) -> nunca de cabeça-para-baixo
  const tilt = R(-maxTilt, maxTilt);

  // heading para o movimento (geométrico)
  let theta = tilt;                // base: direita
  if (goLeft) theta = Math.PI - tilt; // esquerda (espelho lógico)

  // spawn coords
  let x, y;
  if (side === 0)      { x = -m;     y = R(0, H); }
  else if (side === 1) { x = W + m;  y = R(0, H); }
  else if (side === 2) { x = R(0, W); y = -m; }
  else                 { x = R(0, W); y = H + m; }

  // velocidade linear
  const sp = R(CONFIG.speed[0], CONFIG.speed[1]) * speedMul * (W/1920);
  const vx = Math.cos(theta) * sp;
  const vy = Math.sin(theta) * sp;

  // tempo de vida suficiente para atravessar o ecrã
  const travel = (Math.abs(vx) > Math.abs(vy))
    ? (W + 2*m) / Math.abs(vx)
    : (H + 2*m) / Math.abs(vy);
  const ttl = travel * CONFIG.lifetimeExtra;

  // desenho: se vai para a esquerda, espelha na horizontal e só aplica tilt (pequeno)
  const drawFlip  = goLeft;  // scale(-1,1)
  const drawAngle = tilt;    // nunca de cabeça-para-baixo

  return { it, x, y, w, h, vx, vy, t:0, ttl, drawFlip, drawAngle };
}

// Mundo
const target = Math.max(1, Math.round(CONFIG.count * density));
const actors = [];

function spawnIfNeeded() {
  if (!preloaded) return;
  while (actors.length < target) {
    const a = makeActor();
    if (!a) break;
    actors.push(a);
  }
}

// Loop fixo (evita throttling do requestAnimationFrame no Browser Source do OBS)
const frameMs = Math.max(16, Math.floor(1000 / CONFIG.fpsCap));
let timer = 0;

function step() {
  try {
    const dt = frameMs / 1000;

    ctx.clearRect(0, 0, W, H);

    for (let i = actors.length - 1; i >= 0; i--) {
      const a = actors[i];
      a.t += dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;

      // desenhar
      ctx.save();
      ctx.translate(a.x, a.y);
      if (a.drawFlip) ctx.scale(-1, 1);   // espelha para a esquerda
      ctx.rotate(a.drawAngle);            // tilt limitado (upright)
      ctx.drawImage(a.it.img, -a.w/2, -a.h/2, a.w, a.h);
      ctx.restore();

      // reciclar quando sai/expira
      if (a.t > a.ttl ||
          a.x < -a.w - 300 || a.x > W + a.w + 300 ||
          a.y < -a.h - 300 || a.y > H + a.h + 300) {
        actors.splice(i, 1);
      }
    }

    spawnIfNeeded();
  } catch (e) {
    console.error("step error:", e);
  }
}

// Iniciar
preloadAll(SPRITES, () => {
  spawnIfNeeded();
  if (timer) clearInterval(timer);
  timer = setInterval(step, frameMs);
});

// (Opcional) Reforço quando a cena fica ativa outra vez
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    if (timer) clearInterval(timer);
    timer = setInterval(step, frameMs);
  }
});
