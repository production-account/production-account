/**
 * shimmer-text 窶� wavy soft-blur WebGL text reveal.
 *
 * A Shadertoy-style smoothstep + sin-layer front sweeps left 竊� right over
 * your real text (baked to a canvas at device resolution), with a soft blur
 * band and chromatic aberration on the front. Falls back to a Canvas2D strip
 * renderer when WebGL is unavailable, and to instantly-visible static text
 * when `prefers-reduced-motion` is set.
 *
 * Zero dependencies. One file. Two ways to use it:
 *
 *   1. Drop-in (auto-init):
 *        <script type="module" src="https://offbr.co/tools/shimmer-text.js"></script>
 *        <h1 data-shimmer-text>Hello</h1>
 *
 *   2. npm / ESM:
 *        import { shimmerText } from "shimmer-text";
 *        shimmerText("#hero", { duration: 5600, delay: 200 });
 *
 * Per-element overrides: data-shimmer-duration="4000" data-shimmer-delay="200"
 * data-shimmer-colors="#ff0080,#7928ca" data-shimmer-intensity="1.8".
 */

/** Soften the first frames so the front doesn't bloom as a full-word flash. */
const INTRO_RAMP = 0.08;
const DEFAULT_DURATION = 5600;
/** Line height the blur/aberration radii were tuned against (a big hero h1). */
const REF_LINE_HEIGHT = 84;
const MAX_PAD = 96;
/** Palette slots in the shader. More than this and a sweep reads as mud. */
const MAX_COLORS = 6;

/**
 * CSS colour 竊� [r,g,b] in 0..1. Resolved by the browser rather than parsed
 * here, so any CSS colour works 窶� hex, rgb(), hsl(), oklch(), named.
 */
function parseColors(input) {
  const list = typeof input === "string" ? input.split(",") : (input ?? []);
  const out = [];
  for (const raw of list) {
    const value = String(raw).trim();
    if (!value) continue;
    const probe = document.createElement("canvas").getContext("2d");
    if (!probe) break;
    // An unparseable colour leaves fillStyle at its default; comparing against
    // a sentinel is how we detect that without a colour-syntax parser.
    probe.fillStyle = "#000000";
    probe.fillStyle = value;
    const resolved = probe.fillStyle;
    if (
      resolved === "#000000" &&
      !/^(#0{3,8}|black|rgba?\(0[,\s]|transparent)/i.test(value)
    ) {
      continue;
    }
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    out.push(r / 255, g / 255, b / 255);
    if (out.length / 3 >= MAX_COLORS) break;
  }
  return out;
}

/** Canvas2D twin of the shader's paletteAt: sample the looped palette at t. */
function paletteCss(colors, t) {
  const n = colors.length / 3;
  const x = (((t % 1) + 1) % 1) * n;
  const i0 = Math.floor(x) % n;
  const i1 = (i0 + 1) % n;
  const f = x - Math.floor(x);
  const ch = (k) =>
    Math.round(
      (colors[i0 * 3 + k] + (colors[i1 * 3 + k] - colors[i0 * 3 + k]) * f) *
        255,
    );
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

/**
 * Blur is an absolute pixel radius 窶� scale it or body copy smears a whole word.
 *
 * `intensity` rides on top of that: 1 is the tuned default, above 1 is the
 * bigger, slower, more theatrical version (a hero worth staring at), below 1
 * keeps the effect out of the way of copy people actually have to read.
 */
function blurScale(lineHeight, intensity = 1) {
  const fit = Math.max(0.28, Math.min(1.6, lineHeight / REF_LINE_HEIGHT));
  return fit * Math.max(0, Math.min(4, Number(intensity) || 1));
}

/**
 * Soft bleed around the glyphs 窶� must cover the blur radius or the left edge
 * hard-clips. Scales with type: a flat 96px would quadruple the pixel count of
 * a body-copy canvas for bleed that small text never uses.
 */
function padFor(lineHeight) {
  return Math.round(Math.max(28, Math.min(MAX_PAD, lineHeight * 1.2)));
}

/* ---------- easing ---------- */

function easeOutExpo(t) {
  const x = Math.max(0, Math.min(1, t));
  return x >= 1 ? 1 : 1 - 2 ** (-12 * x);
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/* ---------- text baking ---------- */

function get2d(canvas) {
  return canvas.getContext("2d", { alpha: true });
}

/** Mirror of CSS `text-transform`, so the canvas draws what the browser shows. */
function applyTransform(text, transform) {
  if (transform === "uppercase") return text.toUpperCase();
  if (transform === "lowercase") return text.toLowerCase();
  if (transform === "capitalize") {
    return text.replace(/(^|\s)(\S)/g, (_, sp, ch) => sp + ch.toUpperCase());
  }
  return text;
}

function readStyle(host, source) {
  const cs = getComputedStyle(source);
  const fontSize = parseFloat(cs.fontSize);
  const lineHeight =
    cs.lineHeight === "normal" ? fontSize * 1.3 : parseFloat(cs.lineHeight);
  return {
    font: `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`,
    color: cs.color,
    fontSize,
    lineHeight,
    // NOT part of the `font` shorthand: a canvas ignores both unless they are
    // set on the context. A heading at -0.03em would otherwise bake ~3% wider
    // than the text it sits on top of.
    letterSpacing: cs.letterSpacing === "normal" ? "0px" : cs.letterSpacing,
    wordSpacing: cs.wordSpacing === "normal" ? "0px" : cs.wordSpacing,
    // The DOM node keeps the author's casing; only the rendering is
    // transformed. Draw the raw string and you get the wrong glyphs at the
    // wrong width 窶� which the width correction below then papers over as a
    // stretch.
    textTransform: cs.textTransform,
    stroke: host.closest("h1, h2, h3, h4, h5, h6") !== null,
  };
}

/** A rebake is only needed when the box or the type metrics actually moved. */
function layoutKey(root, style, dpr) {
  const rect = root.getBoundingClientRect();
  return `${Math.round(rect.width)}x${Math.round(rect.height)}:${Math.round(
    style.lineHeight,
  )}:${dpr}`;
}

/**
 * The line boxes the browser actually produced, in host-local coordinates.
 *
 * The canvas is painted on top of the real text, so the two have to agree
 * exactly 窶� measuring the live layout instead of re-implementing line breaking
 * is what makes a selection highlight land under the glyphs you can see. It
 * also means CSS owns wrapping, hyphenation, `text-wrap: balance`, and every
 * other thing a hand-rolled greedy wrapper gets subtly wrong.
 */
function measureLines(textNode, hostRect) {
  const data = textNode.data;
  const range = document.createRange();
  const breaks = [];
  let lineStart = 0;
  let prevTop = null;

  for (let i = 0; i < data.length; i++) {
    range.setStart(textNode, i);
    range.setEnd(textNode, i + 1);
    const r = range.getBoundingClientRect();
    // Collapsed whitespace at a wrap point has no box 窶� skip it, or the line
    // break is attributed to the space rather than the first word after it.
    if (!r.width && !r.height) continue;
    if (prevTop === null) {
      prevTop = r.top;
      continue;
    }
    if (r.top - prevTop > 1) {
      breaks.push([lineStart, i]);
      lineStart = i;
      prevTop = r.top;
    }
  }
  breaks.push([lineStart, data.length]);

  const lines = [];
  for (const [rawStart, rawEnd] of breaks) {
    // Trim the collapsed space a continuation line inherits: its rect has zero
    // width, but fillText would still advance by a space.
    let a = rawStart;
    let b = rawEnd;
    while (a < b && /\s/.test(data[a])) a++;
    while (b > a && /\s/.test(data[b - 1])) b--;
    if (a >= b) continue;
    range.setStart(textNode, a);
    range.setEnd(textNode, b);
    const rect = range.getBoundingClientRect();
    lines.push({
      text: data.slice(a, b),
      x: rect.left - hostRect.left,
      top: rect.top - hostRect.top,
      height: rect.height,
      width: rect.width,
    });
  }
  return lines;
}

/**
 * Paint the measured lines onto a padded canvas.
 *
 * Sized and positioned from the host's own box, so the element keeps the size
 * the real text gave it 窶� no reserved-space guesswork, and no layout shift when
 * the canvas appears.
 */
function bakeCrisp(host, style, dpr) {
  const hostRect = host.root.getBoundingClientRect();
  const textNode = host.source.firstChild;
  if (!textNode || !hostRect.width) return null;

  const lines = measureLines(textNode, hostRect);
  if (!lines.length) return null;

  const pad = padFor(style.lineHeight);
  const width = Math.ceil(hostRect.width + pad * 2);
  const height = Math.ceil(hostRect.height + pad * 2);
  const scale = blurScale(style.lineHeight, host.intensity);

  const crisp = document.createElement("canvas");
  crisp.width = Math.ceil(width * dpr);
  crisp.height = Math.ceil(height * dpr);
  const ctx = get2d(crisp);
  if (!ctx) return null;
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.font = style.font;
  // Supported in Chrome 99+/Safari 17.4+; harmlessly ignored elsewhere, where
  // the per-line width correction below picks up the slack.
  ctx.letterSpacing = style.letterSpacing;
  ctx.wordSpacing = style.wordSpacing;
  ctx.fillStyle = style.color;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  for (const line of lines) {
    const drawn = applyTransform(line.text, style.textTransform);
    const m = ctx.measureText(drawn);
    const ascent = m.fontBoundingBoxAscent || style.fontSize * 0.8;
    const descent = m.fontBoundingBoxDescent || style.fontSize * 0.2;
    // A line box taller than the glyphs carries half its leading above them;
    // ignoring that drops every line by a few pixels against the real text.
    const halfLeading = Math.max(0, (line.height - (ascent + descent)) / 2);
    const y = pad + line.top + halfLeading + ascent;
    const x = pad + line.x;
    // Final guarantee that a painted line ends where the real line ends: any
    // residual difference (an unsupported spacing property, a font feature the
    // canvas resolves differently) is absorbed as a sub-percent x-scale rather
    // than left as drift between the glyphs and the selection under them.
    // Absorb sub-pixel differences only. Clamped, because a large mismatch
    // means something is genuinely wrong (a missing text-transform, a font
    // that failed to load) and a visibly stretched line hides the cause 窶�
    // slight misalignment is the better failure.
    const raw = m.width > 0 ? line.width / m.width : 1;
    const fit = Math.min(1.08, Math.max(0.92, raw));
    ctx.save();
    ctx.translate(x, y);
    if (Math.abs(fit - 1) > 0.002) ctx.scale(fit, 1);
    if (style.stroke) {
      ctx.lineWidth = 0.012 * style.fontSize;
      ctx.strokeStyle = style.color;
      ctx.strokeText(drawn, 0, 0);
    }
    ctx.fillText(drawn, 0, 0);
    ctx.restore();
  }
  return { crisp, width, height, scale, pad };
}

/* ---------- WebGL: wavy smoothstep L竊坦 ---------- */

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uTime;
uniform float uProgress;
uniform float uFront;
uniform float uScale;
uniform vec3 uColors[${MAX_COLORS}];
uniform int uColorCount;

float S(float a, float b, float x) {
  return smoothstep(a, b, x);
}

// GLSL ES 1.0 forbids indexing a uniform array with a non-constant, so walk it.
vec3 colorAt(int idx) {
  vec3 c = uColors[0];
  for (int i = 0; i < ${MAX_COLORS}; i++) {
    if (i == idx) c = uColors[i];
  }
  return c;
}

/** Palette sampled around a loop, so the sweep never shows a seam. */
vec3 paletteAt(float t) {
  float x = fract(t) * float(uColorCount);
  int i0 = int(floor(x));
  int i1 = i0 + 1;
  if (i1 >= uColorCount) i1 = 0;
  return mix(colorAt(i0), colorAt(i1), fract(x));
}

// Transparent outside 窶� clamping causes a hard left-edge clip on blur taps
vec4 tap(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4(0.0);
  }
  return texture2D(uTex, uv);
}

void main() {
  vec2 uv = vUv;
  vec2 px = uv * uRes;

  float feather = max(36.0, uRes.x * 0.26);
  float dist = (px.x - uFront) / feather;

  float ramp = S(0.0, ${INTRO_RAMP.toFixed(2)}, uProgress);
  float climax = pow(sin(clamp(uProgress, 0.0, 1.0) * 3.14159265), 1.35);
  float drama = 0.45 + climax * 1.1;
  float gate = S(1.2, 0.0, abs(dist)) * ramp * drama;

  vec4 crisp = tap(uv);
  float settle = S(0.9, 1.0, uProgress);
  float reveal = 1.0 - S(-0.25, 1.65, dist);

  // Away from the front nothing is warped, blurred, or aberrated 窶� the loops
  // below collapse to exactly this. Most pixels (padding, already-revealed
  // text, not-yet-reached text) take this path, so skip ~35 texture fetches.
  if (gate < 0.004) {
    float a = mix(crisp.a * reveal, crisp.a, settle);
    gl_FragColor = vec4(crisp.rgb * a, a);
    return;
  }

  // Soft vertical wave only 窶� X warp reads as a sideways jump
  vec2 warped = uv;
  for (float i = 0.0; i <= 3.0; i += 1.0) {
    float t = i / 3.0;
    warped.y += gate * uScale * sin(uTime * (1.0 + t * 0.7) + uv.x * (3.0 + t) * 2.2)
      * (0.00015 + t * 0.00008);
  }

  // Soft blur 窶� scaled to type size so body copy doesn't smear a whole word
  float blurPx = gate * (7.0 + 5.0 * climax) * uScale;
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (float i = -4.0; i <= 4.0; i += 1.0) {
    float w = S(5.0, 0.0, abs(i));
    acc += tap(warped + vec2(i * blurPx * 0.55 / uRes.x, 0.0)) * w;
    acc += tap(warped + vec2(0.0, i * blurPx * 0.4 / uRes.y)) * w * 0.55;
    wsum += w * 1.55;
  }
  acc /= max(wsum, 0.001);

  // Chromatic aberration on the blur front, fading out near the finish
  float caAmt = gate * (2.4 + 2.0 * climax) * uScale
    * (1.0 - S(0.88, 1.0, uProgress));
  if (caAmt > 0.15) {
    vec2 caOff = vec2(caAmt / uRes.x, caAmt * 0.22 / uRes.y);
    float caR = 0.0;
    float caG = 0.0;
    float caB = 0.0;
    float caA = 0.0;
    float caW = 0.0;
    for (float i = -2.0; i <= 2.0; i += 1.0) {
      float w = S(3.0, 0.0, abs(i));
      vec2 bo = vec2(i * blurPx * 0.35 / uRes.x, 0.0);
      vec4 s0 = tap(warped + bo);
      vec4 sR = tap(warped + bo + caOff);
      vec4 sB = tap(warped + bo - caOff);
      // Fall back to center sample when offset hits empty (avoids black fringes)
      caR += mix(s0.r, sR.r, sR.a) * w;
      caG += s0.g * w;
      caB += mix(s0.b, sB.b, sB.a) * w;
      caA += max(s0.a, max(sR.a, sB.a)) * w;
      caW += w;
    }
    float caMix = S(0.02, 0.55, gate);
    acc.rgb = mix(acc.rgb, vec3(caR, caG, caB) / max(caW, 0.001), caMix * 0.85);
    acc.a = max(acc.a, (caA / max(caW, 0.001)) * caMix);
  }

  // Tint the moving front only. The settle mix below fades this back to the
  // crisp texture, so the words land in their real CSS colour 窶� the palette
  // reads as light passing over the text, not as recoloured copy.
  if (uColorCount > 0) {
    vec3 tint = paletteAt(uv.x * 0.9 - uProgress * 0.45 + uTime * 0.05);
    acc.rgb = mix(acc.rgb, tint, clamp(gate * 1.15, 0.0, 1.0));
  }

  // Blur band arrives first; solid reveal lags behind the front
  float ghost = S(1.85, 0.15, dist) * gate * 0.22 * (1.0 - uProgress) * ramp;
  vec3 rgb = mix(acc.rgb, crisp.rgb, settle);
  float alpha = mix(max(acc.a * reveal, crisp.a * ghost), crisp.a, settle);

  gl_FragColor = vec4(rgb * alpha, alpha);
}
`;

let glState = null;
let glTried = false;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("[shimmer-text] shader compile", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function initGl() {
  if (glTried) return glState;
  glTried = true;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
    });
    if (!gl) return null;

    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return null;

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn("[shimmer-text] link", gl.getProgramInfoLog(program));
      return null;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const u = (name) => gl.getUniformLocation(program, name);
    const uniforms = {
      uTex: u("uTex"),
      uRes: u("uRes"),
      uTime: u("uTime"),
      uProgress: u("uProgress"),
      uFront: u("uFront"),
      uScale: u("uScale"),
      uColors: u("uColors[0]"),
      uColorCount: u("uColorCount"),
    };
    if (Object.values(uniforms).some((loc) => !loc)) return null;

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    glState = {
      canvas,
      gl,
      program,
      buf,
      aPos: gl.getAttribLocation(program, "aPos"),
      ...uniforms,
    };
  } catch (e) {
    console.warn("[shimmer-text] webgl init failed", e);
  }
  return glState;
}

function ensureTexture(host) {
  if (!glState) return null;
  if (host.texture) return host.texture;
  const { gl } = glState;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    host.crisp,
  );
  host.texture = tex;
  return tex;
}

function renderGl(host, progress, timeSec, frontX) {
  if (!glState) return false;
  const tex = ensureTexture(host);
  if (!tex) return false;

  const { gl, canvas, program, buf, aPos } = glState;
  const w = host.crisp.width;
  const h = host.crisp.height;
  if (canvas.width < w) canvas.width = w;
  if (canvas.height < h) canvas.height = h;

  gl.viewport(0, 0, w, h);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1i(glState.uTex, 0);
  gl.uniform2f(glState.uRes, host.width, host.height);
  gl.uniform1f(glState.uTime, timeSec);
  gl.uniform1f(glState.uProgress, progress);
  gl.uniform1f(glState.uFront, frontX);
  gl.uniform1f(glState.uScale, host.scale);
  gl.uniform1i(glState.uColorCount, host.colors.length / 3);
  if (host.colors.length) gl.uniform3fv(glState.uColors, host.colors);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  host.ctx.setTransform(1, 0, 0, 1, 0, 0);
  host.ctx.clearRect(0, 0, w, h);
  host.ctx.drawImage(canvas, 0, canvas.height - h, w, h, 0, 0, w, h);
  return true;
}

/** Canvas2D fallback 窶� L竊坦 strips matching the WebGL language */
function render2d(host, progress, timeSec, frontX) {
  const { ctx, width, height, dpr, crisp } = host;
  const pw = crisp.width;
  const ph = crisp.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);

  const feather = Math.max(36, width * 0.26);
  const ramp = smoothstep(0, INTRO_RAMP, progress);
  const climax = Math.sin(Math.min(1, Math.max(0, progress)) * Math.PI) ** 1.35;
  const drama = 0.45 + climax * 1.1;
  const settle = smoothstep(0.9, 1, progress);
  const strip = Math.max(3, Math.round(3 * dpr));

  for (let sx = 0; sx < pw; sx += strip) {
    const x = sx / dpr;
    const dist = (x - frontX) / feather;
    const gate = smoothstep(1.2, 0, Math.abs(dist)) * ramp * drama;
    const reveal = 1 - smoothstep(-0.25, 1.65, dist);
    // Nothing to blur and nothing revealed yet 窶� the whole strip is empty
    if (gate < 0.004 && reveal < 0.004 && settle < 0.004) continue;

    let yOff = 0;
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      yOff +=
        gate *
        host.scale *
        Math.sin(timeSec * (1 + t * 0.7) + (x / width) * (3 + t) * 2.2) *
        (0.00015 + t * 0.00008) *
        height *
        dpr;
    }

    const blurAmt = gate * (1 - settle) * (1 + climax) * host.scale;
    const ghost =
      smoothstep(1.85, 0.15, dist) * gate * 0.22 * (1 - progress) * ramp;

    ctx.save();
    ctx.beginPath();
    ctx.rect(sx, 0, strip + 1, ph);
    ctx.clip();

    const ca = gate * (2.4 + 2 * climax) * host.scale * dpr;
    const drawStrip = (xShift, alpha) => {
      ctx.globalAlpha = alpha;
      if (blurAmt > 0.04) {
        ctx.filter = `blur(${(4 + blurAmt * 14) * dpr}px)`;
      }
      ctx.drawImage(crisp, xShift, yOff);
      ctx.filter = "none";
    };

    const a = Math.max(reveal, ghost);
    // Behind the front there is no aberration left 窶� one pass instead of three
    if (ca > 0.5) {
      drawStrip(-ca * 0.7, a * 0.3);
      drawStrip(ca * 0.7, a * 0.3);
    }
    drawStrip(0, a);
    ctx.globalAlpha = 1;

    // Same idea as the shader's tint, one flat colour per strip. Runs AFTER
    // the glyphs: source-atop paints only where pixels already exist, so the
    // colour lands on the text and never on the transparent background.
    if (host.colors.length && gate > 0.02) {
      ctx.globalCompositeOperation = "source-atop";
      ctx.globalAlpha = Math.min(1, gate * 1.15);
      ctx.fillStyle = paletteCss(
        host.colors,
        (x / Math.max(width, 1)) * 0.9 - progress * 0.45 + timeSec * 0.05,
      );
      ctx.fillRect(sx, 0, strip + 1, ph);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.restore();
  }

  if (settle > 0) {
    ctx.save();
    ctx.globalAlpha = settle;
    ctx.drawImage(crisp, 0, 0);
    ctx.restore();
  }
}

/* ---------- host lifecycle ---------- */

function introFrontX(host, eased) {
  const feather = Math.max(36, host.width * 0.26);
  const left = -feather * 3.4;
  const right = host.width - host.pad + feather * 0.9;
  return left + eased * (right - left);
}

function drawCrisp(host) {
  host.ctx.setTransform(1, 0, 0, 1, 0, 0);
  host.ctx.clearRect(0, 0, host.crisp.width, host.crisp.height);
  host.ctx.drawImage(host.crisp, 0, 0);
}

function drawFrame(host, now) {
  if (host.settled) {
    drawCrisp(host);
    return false;
  }
  const tRaw = (now - host.startTime - host.delay) / host.duration;
  if (tRaw < 0) {
    // Stay blank through stagger delay 窶� avoids a pre-roll blur flash
    host.ctx.setTransform(1, 0, 0, 1, 0, 0);
    host.ctx.clearRect(0, 0, host.crisp.width, host.crisp.height);
    return true;
  }

  const t = Math.min(1, tRaw);
  const eased = easeOutExpo(t);
  const frontX = introFrontX(host, eased);
  const timeSec = now * 0.001;
  if (!renderGl(host, eased, timeSec, frontX)) {
    render2d(host, eased, timeSec, frontX);
  }

  if (t >= 1) {
    host.settled = true;
    drawCrisp(host);
    return false;
  }
  return true;
}

function applyBake(host, baked, key, dpr) {
  if (host.texture && glState) {
    glState.gl.deleteTexture(host.texture);
    host.texture = null;
  }
  host.crisp = baked.crisp;
  host.width = baked.width;
  host.height = baked.height;
  host.scale = baked.scale;
  host.pad = baked.pad;
  host.dpr = dpr;
  host.layoutKey = key;
  host.canvas.width = baked.crisp.width;
  host.canvas.height = baked.crisp.height;
  host.canvas.style.width = `${baked.width}px`;
  host.canvas.style.height = `${baked.height}px`;
  // Overlay, inset by the bleed. The real text keeps its place in the layout,
  // so the element never changes size and the selection layer stays put.
  host.canvas.style.top = `${-baked.pad}px`;
  host.canvas.style.left = `${-baked.pad}px`;
}

function rebakeHost(host) {
  const style = readStyle(host.root, host.source);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const key = layoutKey(host.root, style, dpr);
  if (key === host.layoutKey) return;
  const baked = bakeCrisp(host, style, dpr);
  if (!baked) return;
  applyBake(host, baked, key, dpr);
  if (host.settled) drawCrisp(host);
}

/* ---------- module singletons: CSS, raf loop, listeners ---------- */

const CSS = `
/* The real text, still in flow and still selectable 窶� the canvas is painted
   over it. Transparent rather than hidden so a selection highlight lands
   exactly under the glyphs you can see, the way a PDF text layer works.

   The stacking is load-bearing and has exactly one correct order:
     parent background  <  canvas (z-index 0)  <  text + its selection (z-index 1)
   A negative z-index on the canvas looks equivalent and is not 窶� it drops the
   canvas behind the backgrounds of every block in the stacking context, so on
   any panel with its own background colour the glyphs vanish entirely. */
.shimmer-text__source{position:relative;z-index:1;color:transparent;-webkit-text-fill-color:transparent}
/* Selected text becomes real again. Two things are needed and the first alone
   is not enough:
     1. the glyph colour comes back, so selected words are legibly solid;
     2. the highlight is tinted FROM that colour, because a host page's
        ::selection is tuned for its own body copy 窶� offbr.co uses 9% black,
        which is perfectly invisible on a dark panel.
   The colour is whatever the canvas baked with, handed over at mount. Where
   color-mix is unsupported the page's own ::selection background still
   applies, so this degrades to the previous behaviour rather than to none. */
.shimmer-text__source::selection{color:var(--shimmer-color);-webkit-text-fill-color:var(--shimmer-color);background:color-mix(in srgb, var(--shimmer-color) 24%, transparent)}
.shimmer-text__source::-moz-selection{color:var(--shimmer-color);-webkit-text-fill-color:var(--shimmer-color);background:color-mix(in srgb, var(--shimmer-color) 24%, transparent)}
.shimmer-text__canvas{position:absolute;z-index:0;pointer-events:none;display:block;max-width:none}
/* The text sweeps in FROM nothing, so it must never paint as plain text first.
   Hidden (not display:none) so it still occupies its box and nothing reflows
   when the canvas takes over. Cleared on mount 窶� and on failure, so a broken
   WebGL context can never leave a page with invisible copy. */
[data-shimmer-text]:not([data-shimmer-ready]),
[data-shimmer-pending]:not([data-shimmer-ready]){visibility:hidden}
`;

let cssInjected = false;

function injectCss() {
  if (cssInjected || typeof document === "undefined") return;
  cssInjected = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  // documentElement, not head: this runs at module eval, which on a
  // `<script type="module">` can precede <head> being closed.
  (document.head ?? document.documentElement).appendChild(style);
}

// At module eval, not inside shimmerText(): the hide rule has to land before
// the first paint, and shimmerText() awaits webfonts before it does anything.
injectCss();

const hosts = new Set();
let rafRunning = false;
let listenersBound = false;

function tick(now) {
  let any = false;
  for (const host of hosts) {
    if (!host.started || host.done) continue;
    if (drawFrame(host, now)) {
      any = true;
    } else {
      host.done = true;
    }
  }
  rafRunning = any;
  if (rafRunning) requestAnimationFrame(tick);
}

function kick() {
  if (!rafRunning) {
    rafRunning = true;
    requestAnimationFrame(tick);
  }
}

function startHost(host) {
  if (host.started) return;
  host.started = true;
  host.startTime = performance.now();
  kick();
}

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      requestAnimationFrame(() => {
        for (const host of hosts) rebakeHost(host);
      });
    }, 120);
  });
}

let io = null;

function observe(host) {
  if (!("IntersectionObserver" in window)) {
    startHost(host);
    return;
  }
  io ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const host of hosts) {
          if (host.root === entry.target) startHost(host);
        }
        io.unobserve(entry.target);
      }
    },
    { rootMargin: "10% 0px 10% 0px", threshold: 0.01 },
  );
  io.observe(host.root);
}

/* ---------- mount ---------- */

function mountHost(root, options, reduceMotion, index = 0) {
  // Already mounted (auto-init raced an explicit call, or React StrictMode
  // double-invoked an effect) 窶� hand back the same host and count the extra
  // owner, so the first destroy() can't tear down an animation the second
  // caller is still using.
  if (root.__shimmerText) {
    root.__shimmerText.refs++;
    return root.__shimmerText;
  }

  const text = (root.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const originalHTML = root.innerHTML;
  // Style is read BEFORE the source goes transparent 窶� that colour is what the
  // canvas bakes with.
  const style = readStyle(root, root);

  const source = document.createElement("span");
  source.className = "shimmer-text__source";
  source.textContent = text;
  source.style.setProperty("--shimmer-color", style.color);
  const canvas = document.createElement("canvas");
  canvas.className = "shimmer-text__canvas";
  canvas.setAttribute("aria-hidden", "true");
  // The text stays in normal flow: it keeps the element's size, it is what the
  // browser wraps and what the user selects, and the canvas is an overlay on
  // top of it. Absolute positioning needs a positioned ancestor.
  if (getComputedStyle(root).position === "static") {
    root.style.position = "relative";
  }
  root.replaceChildren(source, canvas);

  const ctx = get2d(canvas);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const host0 = {
    root,
    source,
    intensity: Number(root.dataset.shimmerIntensity ?? options.intensity ?? 1),
  };
  const baked = ctx ? bakeCrisp(host0, style, dpr) : null;
  if (!ctx || !baked) {
    root.innerHTML = originalHTML;
    root.style.position = "";
    return null;
  }

  const host = {
    root,
    source,
    canvas,
    ctx,
    text,
    originalHTML,
    // stagger walks the delay down the list, so sequencing a block of copy is
    // one option rather than a hand-written loop with an index.
    delay:
      Number(root.dataset.shimmerDelay ?? options.delay ?? 0) +
      index * Number(options.stagger ?? 0),
    duration: Number(
      root.dataset.shimmerDuration ?? options.duration ?? DEFAULT_DURATION,
    ),
    colors: parseColors(root.dataset.shimmerColors ?? options.colors),
    intensity: Number(root.dataset.shimmerIntensity ?? options.intensity ?? 1),
    refs: 1,
    started: false,
    done: false,
    settled: false,
    startTime: 0,
    dpr,
    width: baked.width,
    height: baked.height,
    scale: baked.scale,
    pad: baked.pad,
    crisp: baked.crisp,
    texture: null,
    layoutKey: layoutKey(root, style, dpr),
  };
  applyBake(host, baked, host.layoutKey, dpr);
  root.__shimmerText = host;
  hosts.add(host);

  if (reduceMotion) {
    host.started = true;
    host.settled = true;
    host.done = true;
    drawCrisp(host);
  } else {
    observe(host);
  }
  return host;
}

function unmountHost(host) {
  // Another caller still owns this host (StrictMode's second mount, or a
  // concurrent shimmerText() on the same element) 窶� release, don't tear down.
  if (--host.refs > 0) return;
  hosts.delete(host);
  if (host.texture && glState) {
    glState.gl.deleteTexture(host.texture);
    host.texture = null;
  }
  io?.unobserve(host.root);
  host.root.innerHTML = host.originalHTML;
  host.root.style.position = "";
  // Stays "ready": the original text is back and must be visible. A later
  // shimmerText() on this element clears the flag again before it hides it.
  host.root.removeAttribute("data-shimmer-pending");
  host.root.setAttribute("data-shimmer-ready", "");
  delete host.root.__shimmerText;
}

/* ---------- public API ---------- */

/**
 * Animate text with the shimmer reveal.
 *
 * @param {string | Element | Iterable<Element>} [target="[data-shimmer-text]"]
 * @param {{ duration?: number, delay?: number, stagger?: number,
 *           colors?: string[] | string, intensity?: number }} [options]
 *   duration 窶� sweep length in ms (default 5600)
 *   delay 窶� wait this long after entering the viewport (default 0)
 *   stagger 窶� extra delay per element, in order (default 0)
 *   colors 窶� CSS colours tinting the sweep front; the settled text keeps its
 *            own CSS colour. Up to 6, any CSS syntax.
 *   intensity 窶� how pronounced the sweep is (default 1). Blur, chromatic
 *            aberration and wave amplitude all ride it. ~1.8 for a hero,
 *            ~0.7 for body copy.
 * @returns {Promise<{ replay(): void, destroy(): void }>}
 */
export async function shimmerText(
  target = "[data-shimmer-text]",
  options = {},
) {
  const els =
    typeof target === "string"
      ? Array.from(document.querySelectorAll(target))
      : target instanceof Element
        ? [target]
        : Array.from(target);

  // Claim the targets BEFORE the first await. Anything after this point is a
  // frame or more away, and a programmatic target carries no data-shimmer-text
  // for the stylesheet to catch 窶� without this it paints as plain text and
  // then blanks when the canvas swaps in.
  for (const el of els) {
    el.removeAttribute("data-shimmer-ready");
    el.setAttribute("data-shimmer-pending", "");
  }

  // Fonts must be resolved before baking, but never block more than a beat
  await Promise.race([
    document.fonts.ready,
    new Promise((r) => setTimeout(r, 300)),
  ]);

  bindListeners();
  initGl();
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;

  const mounted = [];
  for (const [index, el] of els.entries()) {
    const host = mountHost(el, options, reduceMotion, index);
    if (host) mounted.push(host);
    // Reveal either way: a host that failed to mount still has to show its
    // text, or the hide rule above would erase the copy permanently.
    el.setAttribute("data-shimmer-ready", "");
  }

  return {
    replay() {
      if (reduceMotion) return;
      for (const host of mounted) {
        host.settled = false;
        host.done = false;
        host.started = true;
        host.startTime = performance.now();
      }
      kick();
    },
    destroy() {
      for (const host of mounted) unmountHost(host);
    },
  };
}

/** Pure helpers, exported for test.mjs only. Not part of the public API. */
export const __internals = {
  smoothstep,
  easeOutExpo,
  layoutKey,
  blurScale,
  padFor,
};

/* ---------- auto-init for the drop-in path ---------- */

if (typeof document !== "undefined") {
  const boot = () => {
    if (document.querySelector("[data-shimmer-text]")) shimmerText();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
}
