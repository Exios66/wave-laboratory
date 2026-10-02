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
uniform float uSkyTime;
uniform vec2 uCloudDrift;
uniform float uCloudOctaves;
${NOISE}
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
float daylight() {
  return clamp(uSunDir.y * 4.0 + 0.25, 0.08, 1.0);
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
vec3 horizonColor() {
  vec3 clear = srgbToLinear(vec3(0.78, 0.84, 0.90));
  vec3 c = mix(clear, overcastBase() * 0.62, overcastAmount());
  return c * daylight() + vec3(0.55, 0.6, 0.75) * uFlash * 0.6;
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
  vec3 below = horizon * 0.8;
  vec3 col = dir.y >= 0.0 ? mix(horizon, zenith, pow(clamp(dir.y, 0.0, 1.0), 0.55)) : mix(horizon, below, clamp(-dir.y, 0.0, 1.0));
  float d = cloudDensity(dir);
  float clearSun = 1.0 - smoothstep(0.55, 0.95, uCloud);
  float sunDisc = pow(max(dot(normalize(dir), sun), 0.0), 1400.0) * (1.0 - d) * clearSun;
  float glow = pow(max(dot(normalize(dir), sun), 0.0), 8.0) * (1.0 - 0.7 * uCloud);
  col += srgbToLinear(vec3(1.0, 0.96, 0.88)) * sunDisc * 1.6;
  col += srgbToLinear(vec3(1.0, 0.85, 0.65)) * glow * 0.28 * daylight();
  // Cloud: bright tops toward the sun, dark bases when the deck is thick.
  float lit = 0.55 + 0.45 * max(dot(normalize(dir), sun), 0.0);
  vec3 cloudCol = mix(srgbToLinear(vec3(0.95, 0.96, 0.97)), srgbToLinear(vec3(0.30, 0.32, 0.36)), smoothstep(0.35, 1.0, uCloud));
  cloudCol *= lit * daylight();
  cloudCol += vec3(0.8, 0.85, 1.0) * uFlash * (0.6 + 0.8 * d);
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
    float a2 = (uLambda > 0.001 && b.w > 0.5)
      ? (a.z * amp * amp * 0.25) * (3.0 - sigma * sigma) / (sigma * sigma * sigma)
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
  float h = max(aCell * uMeshScale, 0.02);
  vec4 regSlope;
  vec3 d = regularSample(worldXY, h, regSlope);
  if (uCount > 0.5) d += cascadeSample(uC0, uSize0, worldXY, h);
  if (uCount > 1.5) d += cascadeSample(uC1, uSize1, worldXY, h);
  if (uCount > 2.5) d += cascadeSample(uC2, uSize2, worldXY, h);
  if (uCount > 3.5) d += cascadeSample(uC3, uSize3, worldXY, h);
  vec3 p = vec3(worldXY.x + d.x, d.z, -(worldXY.y + d.y));
  vThreePos = p;
  vLabel = worldXY;
  vEta = d.z;
  vRegSlope = regSlope;
  vCell = h;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const OCEAN_FRAG = /* glsl */ `
uniform float uWind;
uniform float uTime;
uniform float uHs;
uniform float uOverlay;
uniform float uFogDensity;
uniform float uWakeCount;
uniform vec4 uWakeA[4];
uniform vec4 uWakeB[4];
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

float wakeFoam(vec2 worldXY) {
  float foam = 0.0;
  for (int i = 0; i < 4; i++) {
    if (float(i) + 0.5 > uWakeCount) break;
    vec4 a = uWakeA[i];
    vec4 b = uWakeB[i];
    vec2 rel = worldXY - a.xy;
    float along = dot(rel, b.xy);
    float across = abs(rel.x * b.y - rel.y * b.x);
    float behind = -along;
    float speed = a.z;
    float len = max(a.w, 4.0);
    float beam = max(b.z, 1.0);
    if (behind > 0.0 && behind < len * 6.0 && speed > 0.8) {
      float wedge = beam * 0.42 + behind * 0.16;
      float inside = 1.0 - smoothstep(wedge * 0.35, wedge, across);
      float fade = exp(-behind / (len * 1.8));
      // Churned water: patchy, strongest just astern, breaking up downstream.
      float n1 = vnoise(rel * 0.45 + vec2(uTime * 0.2, 0.0));
      float n2 = vnoise(rel * 1.7 - vec2(0.0, uTime * 0.3));
      float churn = smoothstep(0.35 + 0.35 * (1.0 - fade), 0.85, n1 * 0.6 + n2 * 0.4);
      float core = 1.0 - smoothstep(0.0, beam * 0.6, across);
      foam += inside * fade * clamp(speed / 8.0, 0.0, 1.0) * (0.45 * churn + 0.25 * core * fade);
    }
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
  float gust = uGustCount > 0.5 ? gustAt(label) : 0.0;
  float squall = squallAt(label);
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
    cap += rainRipples(label, clamp(uRain / 20.0, 0.3, 3.0)) * 0.08 * near * clamp(uRain / 15.0, 0.2, 1.0);
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
  vec3 deep = srgbToLinear(vec3(0.012, 0.06, 0.10));
  vec3 shallow = srgbToLinear(vec3(0.04, 0.36, 0.44));
  vec3 stormy = srgbToLinear(vec3(0.03, 0.10, 0.11));
  vec3 water = mix(deep, mix(shallow, stormy, smoothstep(0.4, 1.0, uCloud)), crest) * light;
  water *= 1.0 - 0.25 * squall;
  vec3 col = mix(water, reflection, fresnel);
  // Sun glitter: roughness grows with the unresolved slope variance at distance.
  float sharp = mix(1400.0, 90.0, clamp(foot / 2.0, 0.0, 1.0));
  float sun = max(dot(normalize(R), uSunDir), 0.0);
  float sunVis = (1.0 - smoothstep(0.5, 0.95, uCloud)) * step(0.0, uSunDir.y);
  float spec = (pow(sun, 90.0) * 0.3 + pow(sun, sharp) * (sharp / 1400.0 + 0.15)) * sunVis;
  col += srgbToLinear(vec3(1.0, 0.97, 0.90)) * spec * (0.4 + 0.6 * fresnel);
  // Subsurface glow through thin crests.
  float sss = pow(crest, 2.0) * (1.0 - fresnel) * max(dot(V, -uSunDir) * 0.5 + 0.5, 0.0);
  col += srgbToLinear(vec3(0.10, 0.40, 0.38)) * sss * 0.5 * light;
  // Diffuse light through steep, thin crests, also under an overcast sky.
  float thin = clamp(length(sl.xy) * 2.5, 0.0, 1.0) * crest;
  col += srgbToLinear(vec3(0.06, 0.24, 0.24)) * thin * light * 0.6;
  // Crest glow: sunlight through thin crests when looking toward a low sun.
  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(0.0, 1e-4, 0.0));
  float backlit = pow(clamp(dot(-V, sunFlat), 0.0, 1.0), 3.0);
  float glowCrest = smoothstep(0.55, 1.0, crest) * smoothstep(0.05, 0.3, length(sl.xy) + 0.08);
  float sunUp = smoothstep(-0.05, 0.25, uSunDir.y);
  col += srgbToLinear(vec3(0.12, 0.72, 0.58)) * backlit * glowCrest * sunUp * sunVis
    * (1.0 - fresnel) * 0.55;

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
    * smoothstep(16.0, 24.0, uWind) * 0.6 * bandFade;
  float texture1 = vnoise(label * 0.9 + uTime * 0.05) * 0.6 + vnoise(label * 3.1) * 0.4;
  float foam = breaking * smoothstep(0.25, 0.75, texture1 + breaking * 0.35);
  foam += streaks * (0.5 + 0.5 * texture1);
  foam += wakeFoam(label);
  foam = clamp(foam, 0.0, 1.0);
  vec3 foamCol = srgbToLinear(vec3(0.90, 0.94, 0.96)) * (0.35 + 0.65 * light);
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
varying vec3 vDir;
${SKY}
void main() {
  vec3 dir = normalize(vDir);
  vec3 col = skyColor(dir, uSunDir);
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
