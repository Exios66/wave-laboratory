/**
 * GLSL for the GPU ocean. Three.js compiles these as GLSL 3 and maps `gl_FragColor` /
 * `varying` for us. The FFT passes are a line-by-line port of `ifftPasses.ts`.
 */

export const FFT_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const FFT_FRAG = /* glsl */ `
uniform sampler2D uSrc;
uniform int uMode;
uniform int uBits;
uniform int uLen;
uniform float uSign;
varying vec2 vUv;

int bitReverse(int x, int bits) {
  int r = 0;
  for (int i = 0; i < 9; i++) {
    if (i >= bits) break;
    r = (r << 1) | (x & 1);
    x >>= 1;
  }
  return r;
}

vec2 cmul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

void main() {
  int ix = int(gl_FragCoord.x);
  int iy = int(gl_FragCoord.y);
  vec2 result;
  if (uMode == 0) {
    result = texelFetch(uSrc, ivec2(bitReverse(ix, uBits), iy), 0).rg;
  } else if (uMode == 2) {
    result = texelFetch(uSrc, ivec2(ix, bitReverse(iy, uBits)), 0).rg;
  } else {
    int along = uMode == 1 ? ix : iy;
    int other = uMode == 1 ? iy : ix;
    int span = uLen >> 1;
    int pos = along & (uLen - 1);
    int block = along - pos;
    int k = pos < span ? pos : pos - span;
    int idxA = block + k;
    int idxB = idxA + span;
    ivec2 cA = uMode == 1 ? ivec2(idxA, other) : ivec2(other, idxA);
    ivec2 cB = uMode == 1 ? ivec2(idxB, other) : ivec2(other, idxB);
    vec2 a = texelFetch(uSrc, cA, 0).rg;
    vec2 b = texelFetch(uSrc, cB, 0).rg;
    float theta = uSign * 6.283185307179586 * float(k) / float(uLen);
    vec2 t = cmul(vec2(cos(theta), sin(theta)), b);
    result = pos < span ? a + t : a - t;
  }
  gl_FragColor = vec4(result, 0.0, 1.0);
}
`;

export const SPECTRUM_FRAG = /* glsl */ `
uniform sampler2D uH0;
uniform int uN;
uniform float uSize;
uniform float uTime;
uniform float uDepth;
uniform float uLambda;
uniform int uField;

int wrapNeg(int i, int n) {
  return i == 0 ? 0 : n - i;
}

void main() {
  int ix = int(gl_FragCoord.x);
  int iy = int(gl_FragCoord.y);
  int n = uN;
  vec4 h = texelFetch(uH0, ivec2(ix, iy), 0);
  vec4 hn = texelFetch(uH0, ivec2(wrapNeg(ix, n), wrapNeg(iy, n)), 0);
  float ar = h.r;
  float ai = h.g;
  float omega = h.b;
  float br = hn.r;
  float bi = hn.g;
  float c = cos(omega * uTime);
  float s = sin(omega * uTime);
  float e1r = ar * c + ai * s;
  float e1i = ai * c - ar * s;
  float e2r = br * c + bi * s;
  float e2i = br * s - bi * c;
  float hr = e1r + e2r;
  float hi = e1i + e2i;
  if (uField == 0) {
    gl_FragColor = vec4(hr, hi, 0.0, 1.0);
    return;
  }
  int mx = ix < n / 2 ? ix : ix - n;
  int my = iy < n / 2 ? iy : iy - n;
  float dk = 6.283185307179586 / uSize;
  float kx = float(mx) * dk;
  float ky = float(my) * dk;
  float k = length(vec2(kx, ky));
  if (k < 1.0e-6) {
    gl_FragColor = vec4(0.0);
    return;
  }
  float kh = min(k * uDepth, 20.0);
  float coth = 1.0 / tanh(kh);
  float ux = (kx / k) * coth;
  float uy = (ky / k) * coth;
  float dxr = -uLambda * ux * hi;
  float dxi = uLambda * ux * hr;
  float dyr = -uLambda * uy * hi;
  float dyi = uLambda * uy * hr;
  gl_FragColor = vec4(dxr - dyi, dxi + dyr, 0.0, 1.0);
}
`;

/**
 * Slopes of one cascade by central differences in texel space:
 *   RGBA = (∂η/∂x, ∂η/∂y, ∂Dx/∂x, ∂Dy/∂y).
 * The fragment shader builds per-pixel normals and the Jacobian (foam) from these, so the
 * surface detail no longer depends on how dense the mesh is near the camera.
 */
export const GRADIENT_FRAG = /* glsl */ `
uniform sampler2D uDisp;
uniform int uN;
uniform float uTexel;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = uN;
  vec3 xp = texelFetch(uDisp, ivec2((p.x + 1) % n, p.y), 0).rgb;
  vec3 xm = texelFetch(uDisp, ivec2((p.x + n - 1) % n, p.y), 0).rgb;
  vec3 yp = texelFetch(uDisp, ivec2(p.x, (p.y + 1) % n), 0).rgb;
  vec3 ym = texelFetch(uDisp, ivec2(p.x, (p.y + n - 1) % n), 0).rgb;
  float inv = 0.5 / uTexel;
  gl_FragColor = vec4((xp.r - xm.r) * inv, (yp.r - ym.r) * inv, (xp.g - xm.g) * inv, (yp.b - ym.b) * inv);
}
`;

export const COMBINE_FRAG = /* glsl */ `
uniform sampler2D uHeight;
uniform sampler2D uDisp;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float eta = texelFetch(uHeight, p, 0).r;
  vec2 d = texelFetch(uDisp, p, 0).rg;
  gl_FragColor = vec4(eta, d.x, d.y, 1.0);
}
`;

/** Shared noise helpers. */
const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

/**
 * Sky with weather: a clear-sky gradient that turns grey and darker as the cloud cover rises,
 * procedural clouds on a deck at 1.5 km drifting with the wind, the sun disc hidden behind
 * them, and lightning flashes. Shared by the sky dome and the water's reflections.
 */
const SKY = /* glsl */ `
uniform vec3 uSunDir;
uniform float uCloud;
uniform float uFlash;
// HDR boost of the sun disc, the sharp sun glint and lightning (1 = off, no bloom pass).
uniform float uSunHdr;
uniform float uSkyTime;
uniform vec2 uCloudDrift;
uniform float uCloudOctaves;
// Day:night (scenery/lighting.ts). All 0 = plain daytime.
uniform float uNight;
uniform float uDusk;
uniform vec3 uMoonDir;
${NOISE}
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
// Mirrored by skyLightLevel() in scenery/lighting.ts: brighter through the golden hour, with
// a moonlight floor at night.
float daylight() {
  return min(1.0, clamp(uSunDir.y * 4.0 + 0.25, 0.08 + 0.14 * uNight, 1.0) + uDusk * 0.25);
}
// Overcast luminance follows the CIE overcast sky, L(θ) ∝ (1 + 2 sin θ) / 3: the horizon is a
// third as bright as the zenith, which is what keeps wave slopes visible under a grey sky.
vec3 overcastBase() {
  vec3 grey = srgbToLinear(vec3(0.62, 0.66, 0.70));
  vec3 storm = srgbToLinear(vec3(0.36, 0.39, 0.42));
  return mix(grey, storm, smoothstep(0.75, 1.0, uCloud));
}
float overcastAmount() {
  return smoothstep(0.2, 0.85, uCloud);
}
// Mirrored by horizonColor() in LabRenderer.ts (fog and clear colour).
vec3 horizonColor() {
  vec3 clear = srgbToLinear(vec3(0.78, 0.84, 0.90));
  clear = mix(clear, srgbToLinear(vec3(0.95, 0.66, 0.46)), uDusk * 0.45);
  vec3 c = mix(clear, overcastBase() * 0.62, overcastAmount()) * daylight();
  c = mix(c, srgbToLinear(vec3(0.15, 0.20, 0.30)) * (1.0 - 0.5 * overcastAmount()), uNight);
  return c + vec3(0.55, 0.6, 0.75) * uFlash * 0.6;
}
float cloudDensity(vec3 dir) {
  if (dir.y <= 0.0 || uCloud < 0.02) return 0.0;
  vec2 p = dir.xz / max(dir.y, 0.03) * 1.5 + uCloudDrift;
  float f = 0.0;
  float amp = 0.5;
  vec2 q = p * 0.35;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= uCloudOctaves) break;
    f += amp * vnoise(q);
    q = q * 2.03 + vec2(17.1, 3.7);
    amp *= 0.5;
  }
  float cover = uCloud;
  float d = smoothstep(1.0 - cover - 0.08, 1.0 - cover + 0.32, f + 0.12 * cover);
  return d * smoothstep(0.0, 0.12, dir.y);
}
vec3 skyColor(vec3 dir, vec3 sun) {
  vec3 horizon = horizonColor();
  vec3 zenithClear = srgbToLinear(vec3(0.16, 0.38, 0.72));
  vec3 zenith = mix(zenithClear, overcastBase() * 1.6, overcastAmount()) * daylight();
  zenith = mix(zenith, srgbToLinear(vec3(0.04, 0.07, 0.15)) * (1.0 - 0.5 * overcastAmount()), uNight);
  vec3 below = horizon * 0.8;
  float up = pow(clamp(dir.y, 0.0, 1.0), 0.55);
  vec3 col = dir.y >= 0.0 ? mix(horizon, zenith, up) : mix(horizon, below, clamp(-dir.y, 0.0, 1.0));
  vec3 nd = normalize(dir);
  float clear = 1.0 - overcastAmount();
  if (uDusk > 0.001) {
    // Golden hour: a warm band low in the sky, strongest toward the sun, violet-blue above.
    vec2 hd = normalize(nd.xz + vec2(1e-5));
    vec2 hs = normalize(sun.xz + vec2(1e-5));
    float toward = 0.5 + 0.5 * dot(hd, hs);
    float low = 1.0 - smoothstep(-0.05, 0.45, abs(nd.y));
    vec3 warm = mix(srgbToLinear(vec3(0.98, 0.72, 0.52)), srgbToLinear(vec3(1.0, 0.52, 0.26)), toward);
    col = mix(col, warm * daylight(), uDusk * clear * low * mix(0.45, 0.95, toward * toward));
    col = mix(col, srgbToLinear(vec3(0.30, 0.34, 0.62)) * daylight(), uDusk * clear * up * 0.35);
  }
  if (uNight > 0.001) {
    float md = max(dot(nd, uMoonDir), 0.0);
    float moonUp = smoothstep(-0.04, 0.02, uMoonDir.y) * uNight * (1.0 - cloudDensity(dir)) * (1.0 - 0.8 * overcastAmount());
    col += srgbToLinear(vec3(0.85, 0.90, 1.0)) * (smoothstep(0.99965, 0.99985, md) * 0.9 + pow(md, 60.0) * 0.06) * moonUp;
  }
  float d = cloudDensity(dir);
  float clearSun = 1.0 - smoothstep(0.55, 0.95, uCloud);
  float sunGate = 1.0 - uNight * (1.0 - smoothstep(-0.06, 0.0, sun.y));
  float sunDisc = pow(max(dot(normalize(dir), sun), 0.0), 1400.0) * (1.0 - d) * clearSun * sunGate;
  float glow = pow(max(dot(normalize(dir), sun), 0.0), 8.0) * (1.0 - 0.7 * uCloud);
  vec3 glowCol = mix(srgbToLinear(vec3(1.0, 0.85, 0.65)), srgbToLinear(vec3(1.0, 0.55, 0.25)), uDusk);
  col += srgbToLinear(vec3(1.0, 0.96, 0.88)) * sunDisc * 1.6 * uSunHdr;
  col += glowCol * glow * (0.28 + 0.35 * uDusk) * daylight() * (1.0 - uNight * (1.0 - smoothstep(-0.2, 0.0, sun.y)));
  // Cloud: bright tops toward the sun, dark bases when the deck is thick.
  float lit = 0.55 + 0.45 * max(dot(normalize(dir), sun), 0.0);
  vec3 cloudCol = mix(srgbToLinear(vec3(0.95, 0.96, 0.97)), srgbToLinear(vec3(0.30, 0.32, 0.36)), smoothstep(0.35, 1.0, uCloud));
  cloudCol *= lit * daylight();
  cloudCol += vec3(0.8, 0.85, 1.0) * uFlash * (0.6 + 0.8 * d) * (1.0 + 0.5 * (uSunHdr - 1.0));
  col = mix(col, cloudCol, d * 0.92);
  col += vec3(0.6, 0.65, 0.85) * uFlash * 0.25;
  return col;
}
`;

export const OCEAN_VERT = /* glsl */ `
attribute float aCell;
uniform sampler2D uC0;
uniform sampler2D uC1;
uniform sampler2D uC2;
uniform sampler2D uC3;
uniform float uSize0;
uniform float uSize1;
uniform float uSize2;
uniform float uSize3;
uniform float uCount;
uniform float uN;
uniform float uTime;
uniform float uLambda;
uniform float uHasMips;
uniform float uMeshScale;
uniform vec2 uDrift;
uniform vec4 uRegA[48];
uniform vec4 uRegB[48];
uniform float uRegularCount;
varying vec3 vThreePos;
varying vec2 vLabel;
varying float vEta;
varying vec4 vRegSlope;
varying float vCell;

// Displacement of one cascade, low-passed to the local vertex spacing h: the mip level whose
// texels are about as large as the mesh cells (or a fade when mips are unavailable).
vec3 cascadeSample(sampler2D tex, float size, vec2 worldXY, float h) {
  float texel = size / uN;
  float lod = max(0.0, log2(h / texel) + 0.5);
  vec4 t = textureLod(tex, worldXY / size + (0.5 / uN), lod);
  float w = uHasMips > 0.5 ? 1.0 : 1.0 - smoothstep(0.5, 2.0, lod);
  return vec3(t.g, t.b, t.r) * w;
}

vec3 regularSample(vec2 worldXY, float h, out vec4 slope) {
  vec3 d = vec3(0.0);
  slope = vec4(0.0);
  for (int i = 0; i < 48; i++) {
    if (float(i) + 0.5 > uRegularCount) break;
    vec4 a = uRegA[i];
    vec4 b = uRegB[i];
    float wavelength = 6.2831853 / max(a.z, 1.0e-6);
    float fade = smoothstep(2.0 * h, 4.0 * h, wavelength);
    float amp = a.x * fade;
    float theta = a.z * dot(b.xy, worldXY) - a.y * uTime + a.w;
    float s = sin(theta);
    float c = cos(theta);
    float coth = b.z;
    float sigma = 1.0 / max(coth, 1.0e-3);
    // Same as stokesSecondAmplitude(): held at a/4 so shallow water gets no second crest.
    float a2 = (uLambda > 0.001 && b.w > 0.5)
      ? min((a.z * amp * amp * 0.25) * (3.0 - sigma * sigma) / (sigma * sigma * sigma), 0.25 * amp)
      : 0.0;
    float horiz = -uLambda * amp * coth * s;
    d.x += horiz * b.x;
    d.y += horiz * b.y;
    d.z += amp * c + a2 * cos(2.0 * theta);
    float deta = -amp * a.z * s - 2.0 * a2 * a.z * sin(2.0 * theta);
    float dd = -uLambda * amp * coth * a.z * c;
    slope += vec4(deta * b.x, deta * b.y, dd * b.x * b.x, dd * b.y * b.y);
  }
  return d;
}

void main() {
  vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 worldXY = vec2(base.x, -base.z);
  // The sea lives in the frame of the moving water: sample it where the current carried this
  // point from (uDrift = current × time), as the CPU physics does.
  vec2 waterXY = worldXY - uDrift;
  float h = max(aCell * uMeshScale, 0.02);
  vec4 regSlope;
  vec3 d = regularSample(waterXY, h, regSlope);
  if (uCount > 0.5) d += cascadeSample(uC0, uSize0, waterXY, h);
  if (uCount > 1.5) d += cascadeSample(uC1, uSize1, waterXY, h);
  if (uCount > 2.5) d += cascadeSample(uC2, uSize2, waterXY, h);
  if (uCount > 3.5) d += cascadeSample(uC3, uSize3, waterXY, h);
  vec3 p = vec3(worldXY.x + d.x, d.z, -(worldXY.y + d.y));
  vThreePos = p;
  vLabel = waterXY;
  vEta = d.z;
  vRegSlope = regSlope;
  vCell = h;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const OCEAN_FRAG = /* glsl */ `
uniform vec2 uDrift;
uniform float uWind;
uniform float uTime;
uniform float uHs;
uniform vec3 uScatter;
uniform vec3 uAtten;
uniform float uWaterDepth;
uniform float uOverlay;
uniform float uFogDensity;
uniform float uWakeCount;
uniform sampler2D uWakeTex;
uniform vec4 uWakeShip[8];
uniform vec4 uWakeInfo[8];
uniform vec4 uWakeBox[8];
uniform sampler2D uS0;
uniform sampler2D uS1;
uniform sampler2D uS2;
uniform sampler2D uS3;
uniform float uSize0;
uniform float uSize1;
uniform float uSize2;
uniform float uSize3;
uniform float uCount;
uniform float uN;
uniform float uHasMips;
uniform float uDetailCascades;
uniform float uWhitecap;
uniform vec2 uWindDir;
uniform float uRain;
uniform float uAdvect;
uniform vec4 uGust[24];
uniform float uGustCount;
uniform vec4 uSquall;
uniform float uSquallOn;
uniform float uSquallDur;
varying vec3 vThreePos;
varying vec2 vLabel;
varying float vEta;
varying vec4 vRegSlope;
varying float vCell;

${SKY}

vec3 ramp5(float u, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e) {
  float x = clamp(u, 0.0, 1.0);
  if (x < 0.25) return mix(a, b, x / 0.25);
  if (x < 0.5) return mix(b, c, (x - 0.25) / 0.25);
  if (x < 0.75) return mix(c, d, (x - 0.5) / 0.25);
  return mix(d, e, (x - 0.75) / 0.25);
}

vec4 slopeSample(sampler2D tex, float size, vec2 p) {
  vec2 uv = p / size + (0.5 / uN);
  vec4 s = texture(tex, uv);
  if (uHasMips < 0.5) {
    // Without mip chains, fade detail finer than a pixel instead of letting it alias.
    float texel = size / uN;
    float foot = length(fwidth(p));
    s *= 1.0 - smoothstep(1.0, 3.0, foot / texel);
  }
  return s;
}

// Ship wakes along each hull's recorded track (see render/scene/wakes.ts). Row 2i of uWakeTex
// holds (x, y, time laid, odometer) in the water frame, bow first; row 2i + 1 the speed then.
// p is the water-frame label, so the foam rides the orbital motion and drifts with the current.
float wakeFoam(vec2 p, float foot) {
  float foam = 0.0;
  // Fine noise averages out once a pixel covers it, instead of shimmering.
  float fine = 1.0 - smoothstep(0.6, 2.5, foot);
  for (int i = 0; i < 8; i++) {
    if (float(i) + 0.5 > uWakeCount) break;
    vec4 box = uWakeBox[i];
    if (p.x < box.x || p.y < box.y || p.x > box.z || p.y > box.w) continue;
    vec4 ship = uWakeShip[i];
    vec4 info = uWakeInfo[i];
    float L = max(ship.x, 2.0);
    float B = max(ship.y, 1.0);
    // Nearest point on the track polyline.
    float best = 1e20;
    float age = 0.0;
    float s = 0.0;
    float u = 0.0;
    float odo = 0.0;
    float side = 0.0;
    vec2 aft = vec2(1.0, 0.0);
    bool outside = false;
    vec4 a = texelFetch(uWakeTex, ivec2(0, 2 * i), 0);
    float ua = texelFetch(uWakeTex, ivec2(0, 2 * i + 1), 0).x;
    for (int j = 1; j < 32; j++) {
      if (float(j) + 0.5 > info.x) break;
      vec4 b = texelFetch(uWakeTex, ivec2(j, 2 * i), 0);
      float ub = texelFetch(uWakeTex, ivec2(j, 2 * i + 1), 0).x;
      vec2 ab = b.xy - a.xy;
      float l2 = max(dot(ab, ab), 1e-6);
      float h = clamp(dot(p - a.xy, ab) / l2, 0.0, 1.0);
      vec2 d = p - (a.xy + ab * h);
      float dd = dot(d, d);
      if (dd < best) {
        best = dd;
        // Nearest to an open end of the track (ahead of the bow, or past the oldest point):
        // nothing is drawn there, or the arms would close into circles.
        outside = (j == 1 && h <= 0.0) || (float(j) + 1.5 > info.x && h >= 1.0);
        age = uTime - mix(a.z, b.z, h);
        s = ship.w - mix(a.w, b.w, h);
        u = mix(ua, ub, h);
        odo = mix(a.w, b.w, h);
        aft = ab * inversesqrt(l2);
        side = d.x * aft.y - d.y * aft.x;
      }
      a = b;
      ua = ub;
    }
    if (outside) continue;
    float lat = sqrt(best);
    float tau = info.z;
    float life = 1.0 - smoothstep(0.6, 1.0, age / info.w);
    float fn = u / sqrt(9.81 * L);
    float go = smoothstep(0.4, 3.0, u);

    // Turbulent wake from the stern aft (from a little forward of it along the hull sides).
    float astern = s - L;
    float c = 0.0;
    if (astern > -0.25 * L) {
      float halfW = 0.5 * B * (0.85 + 0.55 * pow(max(astern, 0.0) / B, 0.3333));
      halfW *= smoothstep(-0.25 * L, 0.05 * L, astern) * 0.4 + 0.6;
      // Screw race: water thrown aft at ~30 % of ship speed, settling within a few seconds.
      float race = 0.3 * u * 3.0 * (1.0 - exp(-age / 3.0));
      vec2 q = p - aft * race;
      vec2 qr = mat2(0.8, -0.6, 0.6, 0.8) * q;
      float n1 = vnoise(q * 0.13 + vec2(float(i) * 7.3, uTime * 0.025));
      float n2 = vnoise(qr * 0.55 - vec2(uTime * 0.05, float(i) * 3.1));
      float n3 = vnoise(q * 1.9 + vec2(0.0, uTime * 0.09));
      // Streaks along the track, fixed to the water (odometer, signed offset).
      float streak = vnoise(vec2((odo + race) * 0.025, side * 0.3 + float(i) * 11.0));
      float tex = n1 * 0.36 + streak * 0.3 + mix(0.5, n2, fine) * 0.22 + mix(0.5, n3, fine) * 0.12;
      // Ragged edges that wander along the track.
      float edge = halfW * (0.75 + 0.45 * vnoise(vec2(odo * 0.04, float(i))));
      float prof = 1.0 - smoothstep(0.35 * edge, edge, lat);
      float bright = exp(-age / tau);
      float lane = exp(-age / (3.0 * tau));
      // Fresh foam is nearly solid; as bubbles burst it breaks into patches, then streaks.
      float thr = mix(0.68, 0.3, bright);
      float patches = smoothstep(thr - 0.12, thr + 0.2, tex);
      float core = (1.0 - smoothstep(0.0, 0.45 * halfW, lat)) * exp(-age / (0.35 * tau));
      c = prof * go * (bright * (0.55 * patches + 0.3 * core) + 0.14 * lane * patches) * life;
    }

    // Kelvin arms: divergent waves at 19.47° from the bow, breaking along their cusps.
    float arm = 0.0;
    if (fn > 0.12 && s < 4.0 * L) {
      float off = abs(lat - 0.35355 * s);
      float wa = 0.4 + 0.02 * s + 0.03 * B;
      float lambdaD = 4.18879 * u * u / 9.81; // (2/3) 2π U² / g
      float cusps = 0.7 + 0.3 * cos(6.28318 * s / max(lambdaD, 0.5));
      float broken = smoothstep(0.3, 0.8, vnoise(vec2(odo * 0.09, off * 0.35 + side * 0.01)));
      arm = (1.0 - smoothstep(0.3 * wa, wa, off)) * cusps * mix(0.6, broken, fine)
        * smoothstep(0.12, 0.3, fn) * exp(-s / (1.3 * L)) * exp(-age / tau) * 0.45;
    }
    foam = max(foam, c + arm);
  }
  return foam;
}

/** Relative gust u'/U at a point: the same Fourier modes the vessels feel. */
float gustAt(vec2 p) {
  float along = dot(p, uWindDir);
  float across = -p.x * uWindDir.y + p.y * uWindDir.x;
  float g = 0.0;
  for (int i = 0; i < 24; i++) {
    if (float(i) + 0.5 > uGustCount) break;
    vec4 m = uGust[i];
    float kx = m.x / uAdvect;
    g += m.y * cos(m.x * uTime - kx * along + kx * m.w * across + m.z);
  }
  return g;
}

float squallAt(vec2 p) {
  if (uSquallOn < 0.5) return 0.0;
  float tau = uTime - dot(p, uWindDir) / uAdvect;
  float e = 0.0;
  for (int i = 0; i < 3; i++) {
    float s = tau - uSquall[i];
    float rise = smoothstep(-0.08 * uSquallDur, 0.0, s);
    float fall = 1.0 - smoothstep(0.55 * uSquallDur, 1.4 * uSquallDur, s);
    e = max(e, rise * fall);
  }
  return e;
}

/** Expanding rain-drop rings on a cell grid (normal perturbation). */
vec2 rainRipples(vec2 p, float rate) {
  vec2 n = vec2(0.0);
  for (int layer = 0; layer < 2; layer++) {
    vec2 q = p * (1.6 + float(layer) * 0.9) + float(layer) * 13.7;
    vec2 cell = floor(q);
    vec2 f = fract(q) - 0.5;
    float h = hash12(cell);
    vec2 c = vec2(hash12(cell + 7.1), hash12(cell + 3.3)) - 0.5;
    float phase = fract(uTime * (0.7 + h) * rate + h * 9.0);
    vec2 d = f - c * 0.6;
    float r = length(d);
    float front = 0.45 * phase;
    float mask = 1.0 - smoothstep(front - 0.02, front + 0.05, r);
    float ring = sin((r - front) * 40.0) * (1.0 - phase) * mask;
    n += (r > 1.0e-4 ? d / r : vec2(0.0)) * ring;
  }
  return n;
}

void main() {
  vec2 label = vLabel;
  // Total slopes of the surface (spectral cascades + analytic waves) at this particle label.
  vec4 sl = vRegSlope;
  if (uCount > 0.5) sl += slopeSample(uS0, uSize0, label);
  if (uCount > 1.5) sl += slopeSample(uS1, uSize1, label);
  if (uCount > 2.5 && uDetailCascades > 2.5) sl += slopeSample(uS2, uSize2, label);
  if (uCount > 3.5 && uDetailCascades > 3.5) sl += slopeSample(uS3, uSize3, label);
  float jx = 1.0 + sl.z;
  float jy = 1.0 + sl.w;
  float jacobian = jx * jy;

  float dist = distance(cameraPosition, vThreePos);
  float foot = length(fwidth(label));
  float near = 1.0 - smoothstep(30.0, 250.0, dist);

  // Weather on the water: gust patches ("cat's paws") roughen it, squall lines darken it.
  // Wind, rain and ship wakes are anchored to the world, not to the drifting water.
  vec2 world = label + uDrift;
  float gust = uGustCount > 0.5 ? gustAt(world) : 0.0;
  float squall = squallAt(world);
  float rough = clamp(0.35 + uWind * 0.05, 0.2, 2.5) * (1.0 + 2.5 * max(gust, 0.0)) * (1.0 + squall);
  vec2 cap = vec2(0.0);
  float capFade = 1.0 - smoothstep(0.15, 0.6, foot);
  if (capFade > 0.0) {
    vec2 q = label * 2.2 + uWindDir * uTime * 0.8;
    cap.x = vnoise(q) - vnoise(q + vec2(0.37, 0.0));
    cap.y = vnoise(q) - vnoise(q + vec2(0.0, 0.37));
    cap *= 0.35 * rough * capFade;
  }
  if (uRain > 0.1 && near > 0.0) {
    cap += rainRipples(world, clamp(uRain / 20.0, 0.3, 3.0)) * 0.08 * near * clamp(uRain / 15.0, 0.2, 1.0);
  }
  // Lagrangian normal: tangents (1 + Dxx, 0, ηx) and (0, 1 + Dyy, ηy) in world (x, y, z).
  vec3 nWorld = normalize(vec3(-(sl.x + cap.x) * jy, -(sl.y + cap.y) * jx, jx * jy));
  vec3 N = normalize(vec3(nWorld.x, nWorld.z, -nWorld.y));
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vThreePos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  if (R.y < 0.0) R.y = -R.y * 0.3;
  vec3 reflection = skyColor(R, uSunDir);
  float crest = clamp(vEta / max(uHs, 0.4) * 0.5 + 0.5, 0.0, 1.0);
  float light = daylight() * (1.0 - 0.55 * uCloud) + uFlash * 0.5;
  // Jerlov body colour and Beer–Lambert transmission. Scatter is already linear RGB.
  vec3 scatter = uScatter;
  vec3 kd = max(uAtten, vec3(1.0e-4));
  float crestPath = mix(1.6, 0.22, crest);
  vec3 transCrest = exp(-kd * crestPath);
  vec3 deep = scatter * 1.7;
  vec3 shallow = scatter * 0.35 + transCrest * vec3(0.10, 0.28, 0.26);
  vec3 stormy = mix(deep, scatter * 0.9, 0.45);
  vec3 water = mix(deep, mix(shallow, stormy, smoothstep(0.4, 1.0, uCloud)), crest) * light;
  water *= 1.0 - 0.25 * squall;
  vec3 col = mix(water, reflection, fresnel);
  // Sun glitter: roughness grows with the unresolved slope variance at distance.
  float sharp = mix(1400.0, 90.0, clamp(foot / 2.0, 0.0, 1.0));
  float sun = max(dot(normalize(R), uSunDir), 0.0);
  float sunVis = (1.0 - smoothstep(0.5, 0.95, uCloud)) * step(0.0, uSunDir.y);
  float spec = (pow(sun, 90.0) * 0.3 + pow(sun, sharp) * (sharp / 1400.0 + 0.15) * uSunHdr) * sunVis;
  vec3 glint = mix(srgbToLinear(vec3(1.0, 0.97, 0.90)), srgbToLinear(vec3(1.0, 0.68, 0.40)), uDusk);
  col += glint * spec * (0.4 + 0.6 * fresnel);
  // Moon glitter path at night.
  float moonGlint = pow(max(dot(normalize(R), uMoonDir), 0.0), 220.0) * uNight * step(0.0, uMoonDir.y);
  col += srgbToLinear(vec3(0.75, 0.82, 0.95)) * moonGlint * 0.5 * (1.0 - smoothstep(0.4, 0.9, uCloud));
  // Subsurface glow through thin crests, tinted by what this water type transmits.
  vec3 sssTint = scatter * 10.0 + transCrest * vec3(0.08, 0.32, 0.28);
  float sss = pow(crest, 2.0) * (1.0 - fresnel) * max(dot(V, -uSunDir) * 0.5 + 0.5, 0.0);
  col += sssTint * sss * 0.5 * light;
  float thin = clamp(length(sl.xy) * 2.5, 0.0, 1.0) * crest;
  col += sssTint * thin * light * 0.45;
  // Crest glow: sunlight through thin crests when looking toward a low sun.
  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(0.0, 1e-4, 0.0));
  float backlit = pow(clamp(dot(-V, sunFlat), 0.0, 1.0), 3.0);
  float glowCrest = smoothstep(0.55, 1.0, crest) * smoothstep(0.05, 0.3, length(sl.xy) + 0.08);
  float sunUp = smoothstep(-0.05, 0.25, uSunDir.y);
  vec3 glowTint = scatter * 14.0 + transCrest * vec3(0.10, 0.62, 0.48);
  col += glowTint * backlit * glowCrest * sunUp * sunVis * (1.0 - fresnel) * 0.65;
  // Optically shallow water: the bottom shows through where K_d · depth is small.
  vec3 bottom = srgbToLinear(vec3(0.30, 0.26, 0.16));
  float kdMean = dot(kd, vec3(0.3, 0.45, 0.25));
  float seeBottom = exp(-kdMean * uWaterDepth) * (1.0 - smoothstep(20.0, 70.0, uWaterDepth));
  col = mix(col, mix(col, bottom * transCrest * light, 0.6), seeBottom * (1.0 - fresnel));

  // Whitecaps: breaking where the surface compresses (Jacobian), with coverage that follows
  // the Monahan whitecap law for the wind, plus wind-aligned foam streaks above Beaufort 8.
  // Breaking happens on the crests: weight the compression by the elevation.
  float gate = 0.5 + 0.7 * sqrt(uWhitecap) + 0.15 * squall;
  float onCrest = smoothstep(-0.15, 0.45, vEta / max(uHs, 0.3));
  float breaking = (1.0 - smoothstep(gate - 0.25, gate, jacobian)) * (0.35 + 0.65 * onCrest);
  // Streaks: long, narrow, wavy bands along the wind, faded where a pixel spans a band.
  float alongW = dot(label, uWindDir);
  float acrossW = -label.x * uWindDir.y + label.y * uWindDir.x;
  float wobble = vnoise(vec2(alongW * 0.01, acrossW * 0.02)) * 6.0;
  float band = vnoise(vec2(alongW * 0.03, (acrossW + wobble) * 0.6));
  float bandFade = 1.0 - smoothstep(0.4, 1.2, foot);
  float streaks = smoothstep(0.7, 0.92, band) * vnoise(vec2(alongW, acrossW) * 0.08)
    * smoothstep(16.0, 24.0, uWind) * 0.6 * bandFade
    // Streaks come and go along their length instead of running unbroken for kilometres.
    * smoothstep(0.25, 0.65, vnoise(vec2(alongW * 0.004, acrossW * 0.015 + 7.0)));
  float texture1 = vnoise(label * 0.9 + uTime * 0.05) * 0.6 + vnoise(label * 3.1) * 0.4;
  float foam = breaking * smoothstep(0.25, 0.75, texture1 + breaking * 0.35);
  foam += streaks * (0.5 + 0.5 * texture1);
  foam += wakeFoam(label, foot);
  foam = clamp(foam, 0.0, 1.0);
  // Foam is lit like the water around it: at night only a faint grey, not a glowing band.
  vec3 foamCol = srgbToLinear(vec3(0.90, 0.94, 0.96)) * (0.06 + 0.94 * light);
  col = mix(col, foamCol, foam * 0.92);

  if (uOverlay > 0.5 && uOverlay < 1.5) {
    float u = clamp(vEta / max(0.25, uHs * 0.75) * 0.5 + 0.5, 0.0, 1.0);
    col = ramp5(u,
      srgbToLinear(vec3(0.129, 0.400, 0.675)),
      srgbToLinear(vec3(0.404, 0.663, 0.812)),
      srgbToLinear(vec3(0.969, 0.969, 0.969)),
      srgbToLinear(vec3(0.937, 0.541, 0.384)),
      srgbToLinear(vec3(0.698, 0.094, 0.169)));
  } else if (uOverlay > 1.5 && uOverlay < 2.5) {
    float slope = length(sl.xy);
    col = ramp5(clamp(slope / 0.3, 0.0, 1.0),
      srgbToLinear(vec3(0.051, 0.031, 0.529)),
      srgbToLinear(vec3(0.494, 0.012, 0.659)),
      srgbToLinear(vec3(0.800, 0.278, 0.471)),
      srgbToLinear(vec3(0.973, 0.584, 0.251)),
      srgbToLinear(vec3(0.941, 0.976, 0.129)));
  } else if (uOverlay > 2.5) {
    float u = clamp(1.0 - jacobian, 0.0, 1.0);
    col = mix(srgbToLinear(vec3(0.031, 0.188, 0.420)), srgbToLinear(vec3(0.969, 0.984, 1.0)), u);
  }

  float fogAmount = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  col = mix(col, horizonColor(), clamp(fogAmount, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = clip.xyww;
}
`;

export const SKY_FRAG = /* glsl */ `
uniform float uFogDensity;
uniform float uStars;
uniform mat3 uCelestial;
uniform vec3 uGalPole;
uniform vec3 uGalCentre;
varying vec3 vDir;
${SKY}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}
float fbm3(vec3 p) {
  float sum = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    sum += amp * vnoise3(p);
    p = p * 2.03 + vec3(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum;
}
// One layer of procedural stars on a grid of cells over the star frame: one candidate star per
// cell, kept when its hash beats the threshold. Returns colour-weighted brightness.
vec3 starLayer(vec3 c, float scale, float keep, float twinkleT) {
  vec3 p = c * scale;
  vec3 cell = floor(p);
  float n = hash13(cell);
  if (n < keep) return vec3(0.0);
  vec3 jitter = vec3(hash13(cell + 11.3), hash13(cell + 27.1), hash13(cell + 43.7)) * 0.5 + 0.25;
  float r = length(fract(p) - jitter);
  float mag = (n - keep) / (1.0 - keep);
  float core = smoothstep(0.22, 0.0, r) * (0.25 + 0.75 * mag * mag);
  float tw = 0.78 + 0.22 * sin(twinkleT * (2.0 + 5.0 * fract(n * 91.7)) + n * 400.0);
  // Blue-white to warm orange, most stars near white.
  float temp = fract(n * 53.1);
  vec3 tint = temp < 0.2 ? vec3(1.0, 0.78, 0.6) : temp < 0.5 ? vec3(1.0, 0.95, 0.88) : vec3(0.78, 0.86, 1.0);
  return tint * core * tw;
}
// The Milky Way: a band along the galactic plane, broad and bright toward the core, with
// star clouds, a dark dust rift down the middle and dust lanes breaking it up.
// Returns linear radiance; 'density' (0-1) says how crowded with stars the band is here.
vec3 milkyWay(vec3 c, out float density) {
  vec3 east = normalize(cross(uGalPole, uGalCentre));
  float lat = asin(clamp(dot(c, uGalPole), -1.0, 1.0));
  density = 0.0;
  if (abs(lat) > 0.8) return vec3(0.0);
  float lon = atan(dot(c, east), dot(c, uGalCentre));
  float toCore = exp(-lon * lon / (2.0 * 0.75 * 0.75));
  // Warp the band so it meanders rather than running as a perfect great circle.
  float warp = (fbm3(c * 2.2) - 0.5) * 0.1;
  float l = lat + warp;
  float width = 0.1 + 0.12 * toCore;
  float band = exp(-l * l / (2.0 * width * width));
  // The bulge: a fat glow around the core.
  float bulge = exp(-(l * l * 1.8 + lon * lon * 0.8) / (2.0 * 0.15 * 0.15));
  // Knotty star clouds at two scales.
  float clouds = fbm3(c * 8.0);
  float fine = fbm3(c * 44.0);
  float knots = smoothstep(0.35, 0.8, clouds) * (0.3 + 0.7 * smoothstep(0.32, 0.72, fine));
  float glow = band * (0.15 + 0.85 * knots) * (0.45 + 0.9 * toCore);
  glow += bulge * (0.8 + 0.6 * fine);
  // The Great Rift: a ragged dark lane just off the plane, widest toward the core.
  float riftOff = l - 0.02 - 0.03 * sin(lon * 2.3) - (fbm3(c * 14.0) - 0.5) * 0.05;
  float riftW = 0.022 + 0.03 * toCore;
  float rift = exp(-riftOff * riftOff / (2.0 * riftW * riftW));
  rift *= smoothstep(0.3, 0.6, fbm3(c * 5.0 + 4.0)) * smoothstep(2.4, 0.3, abs(lon));
  // Filaments of dust across the band.
  float dust = smoothstep(0.52, 0.72, fbm3(c * 13.0 + 9.0)) * band;
  glow *= (1.0 - 0.92 * rift) * (1.0 - 0.7 * dust);
  density = clamp(band * (0.4 + 0.6 * knots) * (1.0 - 0.8 * rift) * (1.0 - 0.5 * dust), 0.0, 1.0);
  vec3 armCol = vec3(0.66, 0.74, 1.0);
  vec3 coreCol = vec3(1.0, 0.8, 0.56);
  vec3 col = mix(armCol, coreCol, clamp(toCore * 0.7 + bulge * 0.8, 0.0, 1.0));
  // Pink glow of emission nebulae dotted along the plane.
  float neb = smoothstep(0.66, 0.86, fbm3(c * 10.0 + 21.0)) * band * (1.0 - rift);
  return col * glow + vec3(0.95, 0.3, 0.45) * neb * 0.3;
}
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyColor(dir, uSunDir);
  if (uStars > 0.001 && dir.y > 0.0) {
    float seen = uStars * (1.0 - cloudDensity(dir)) * (1.0 - overcastAmount());
    // Extinction: everything dims and reddens toward the horizon.
    float alt = smoothstep(0.0, 0.25, dir.y);
    seen *= mix(0.15, 1.0, alt);
    // A bright moon washes out the faint glow (but not the stars) .
    float moonWash = smoothstep(-0.05, 0.3, uMoonDir.y);
    vec3 c = uCelestial * dir;
    float density;
    vec3 mw = milkyWay(c, density);
    col += mw * 0.1 * seen * (1.0 - 0.3 * moonWash);
    vec3 st = starLayer(c, 260.0, 0.982, uSkyTime) * 1.0;
    st += starLayer(c, 520.0, mix(0.993, 0.955, density), uSkyTime * 1.3) * 0.45;
    st += starLayer(c, 900.0, mix(0.999, 0.93, density), uSkyTime * 0.7) * 0.25 * (1.0 - 0.5 * moonWash);
    // Unresolved star dust: a fine sparkle that makes the band grainy rather than misty.
    st += starLayer(c, 380.0, mix(1.0, 0.7, density), 0.0) * 0.8 * density;
    st += starLayer(c.zxy, 470.0, mix(1.0, 0.75, density), 0.0) * 0.6 * density;
    col += st * 0.85 * seen * vec3(1.0, mix(0.85, 1.0, alt), mix(0.7, 1.0, alt));
  }
  // Low visibility (rain, fog) hides the horizon and the lower sky.
  float haze = clamp(uFogDensity * 4000.0, 0.0, 1.0);
  col = mix(col, horizonColor(), haze * (1.0 - smoothstep(0.0, 0.35, dir.y)));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Rain streaks in a box that follows the camera: each streak falls at the drops' terminal
 * velocity, drifts with the wind and wraps around the box.
 */
export const RAIN_VERT = /* glsl */ `
attribute vec3 aSeed;
attribute float aEnd;
uniform float uTime;
uniform vec3 uVel;
uniform vec3 uBox;
uniform float uStreak;
varying float vFade;
void main() {
  vec3 p = aSeed * uBox + uVel * uTime;
  vec3 origin = cameraPosition - uBox * 0.5;
  p = mod(p - origin, uBox) + origin;
  p -= uVel * uStreak * aEnd;
  vec3 rel = p - cameraPosition;
  vFade = (1.0 - smoothstep(uBox.x * 0.25, uBox.x * 0.5, length(rel.xz))) * (0.4 + 0.6 * aEnd);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const RAIN_FRAG = /* glsl */ `
uniform float uOpacity;
uniform vec3 uColor;
varying float vFade;
void main() {
  gl_FragColor = vec4(uColor, uOpacity * vFade);
  #include <colorspace_fragment>
}
`;

/** Soft round sprites for spray and spindrift. */
export const SPRAY_VERT = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
uniform float uPixelScale;
varying float vAlpha;
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(aSize * uPixelScale / max(-mv.z, 0.5), 1.0, 64.0);
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * mv;
}
`;

export const SPRAY_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = dot(c, c) * 4.0;
  if (r > 1.0) discard;
  gl_FragColor = vec4(uColor, vAlpha * (1.0 - r));
  #include <colorspace_fragment>
}
`;
