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

const SKY = /* glsl */ `
vec3 srgbToLinear(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
vec3 skyColor(vec3 dir, vec3 sun) {
  float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 horizon = srgbToLinear(vec3(0.78, 0.84, 0.90));
  vec3 zenith = srgbToLinear(vec3(0.16, 0.38, 0.72));
  vec3 below = srgbToLinear(vec3(0.45, 0.55, 0.62));
  vec3 col = dir.y >= 0.0 ? mix(horizon, zenith, pow(clamp(dir.y, 0.0, 1.0), 0.55)) : mix(horizon, below, clamp(-dir.y, 0.0, 1.0));
  float sunDisc = pow(max(dot(normalize(dir), sun), 0.0), 1400.0);
  float glow = pow(max(dot(normalize(dir), sun), 0.0), 8.0);
  col += srgbToLinear(vec3(1.0, 0.96, 0.88)) * sunDisc;
  col += srgbToLinear(vec3(1.0, 0.85, 0.65)) * glow * 0.28;
  return col;
}
`;

export const OCEAN_VERT = /* glsl */ `
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
uniform float uEps;
uniform vec4 uRegA[8];
uniform vec4 uRegB[8];
uniform float uRegularCount;
varying vec3 vNormal;
varying vec3 vThreePos;
varying float vEta;
varying float vSlope;
varying float vJacobian;

vec3 cascadeSample(sampler2D tex, float size, vec2 worldXY) {
  vec2 uv = worldXY / size + (0.5 / uN);
  vec4 t = texture(tex, uv);
  return vec3(t.g, t.b, t.r);
}

vec3 regularSample(vec2 worldXY) {
  vec3 d = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float use = step(float(i) + 0.5, uRegularCount);
    vec4 a = uRegA[i];
    vec4 b = uRegB[i];
    float theta = a.z * dot(b.xy, worldXY) - a.y * uTime + a.w;
    float s = sin(theta);
    float horiz = -uLambda * a.x * b.z * s;
    float sigma = 1.0 / max(b.z, 1.0e-3);
    float a2 = uLambda > 0.001
      ? (a.z * a.x * a.x * 0.25) * (3.0 - sigma * sigma) / (sigma * sigma * sigma)
      : 0.0;
    d.x += use * horiz * b.x;
    d.y += use * horiz * b.y;
    d.z += use * (a.x * cos(theta) + a2 * cos(theta * 2.0));
  }
  return d;
}

vec3 displace(vec2 worldXY) {
  vec3 d = regularSample(worldXY);
  if (uCount > 0.5) d += cascadeSample(uC0, uSize0, worldXY);
  if (uCount > 1.5) d += cascadeSample(uC1, uSize1, worldXY);
  if (uCount > 2.5) d += cascadeSample(uC2, uSize2, worldXY);
  if (uCount > 3.5) d += cascadeSample(uC3, uSize3, worldXY);
  return d;
}

vec3 toThree(vec2 worldXY, vec3 d) {
  return vec3(worldXY.x + d.x, d.z, -(worldXY.y + d.y));
}

void main() {
  vec3 base = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 worldXY = vec2(base.x, -base.z);
  vec3 d0 = displace(worldXY);
  vec3 dx = displace(worldXY + vec2(uEps, 0.0));
  vec3 dy = displace(worldXY + vec2(0.0, uEps));
  vec3 p = toThree(worldXY, d0);
  vec3 px = toThree(worldXY + vec2(uEps, 0.0), dx);
  vec3 py = toThree(worldXY + vec2(0.0, uEps), dy);
  vec3 n = cross(px - p, py - p);
  float nLen = length(n);
  vNormal = nLen > 1.0e-5 ? n / nLen : vec3(0.0, 1.0, 0.0);
  vThreePos = p;
  vEta = d0.z;
  vSlope = length(vec2(dx.z - d0.z, dy.z - d0.z)) / uEps;
  float dDxdx = (dx.x - d0.x) / uEps;
  float dDydy = (dy.y - d0.y) / uEps;
  float dDxdy = (dy.x - d0.x) / uEps;
  vJacobian = (1.0 + dDxdx) * (1.0 + dDydy) - dDxdy * dDxdy;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

export const OCEAN_FRAG = /* glsl */ `
uniform vec3 uSunDir;
uniform float uWind;
uniform float uTime;
uniform float uHs;
uniform float uOverlay;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uWakeCount;
uniform vec4 uWakeA[4];
uniform vec4 uWakeB[4];
uniform sampler2D uC2;
uniform sampler2D uC3;
uniform float uSize2;
uniform float uSize3;
uniform float uCount;
uniform float uN;
varying vec3 vNormal;
varying vec3 vThreePos;
varying float vEta;
varying float vSlope;
varying float vJacobian;

${SKY}

vec3 ramp5(float u, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e) {
  float x = clamp(u, 0.0, 1.0);
  if (x < 0.25) return mix(a, b, x / 0.25);
  if (x < 0.5) return mix(b, c, (x - 0.25) / 0.25);
  if (x < 0.75) return mix(c, d, (x - 0.5) / 0.25);
  return mix(d, e, (x - 0.75) / 0.25);
}

float smallEta(vec2 p) {
  vec2 bias = vec2(0.5 / max(uN, 1.0));
  float h = 0.0;
  if (uCount > 2.5) h += texture(uC2, p / uSize2 + bias).r;
  if (uCount > 3.5) h += texture(uC3, p / uSize3 + bias).r;
  return h;
}

float capillary(vec2 p) {
  float a = 0.012 * (0.35 + uWind * 0.05);
  float w = sin(p.x * 2.4 + p.y * 1.1 + uTime * 1.7);
  w += 0.55 * sin(p.x * 5.6 - p.y * 4.2 + uTime * 2.6);
  return w * a;
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
      foam += inside * fade * clamp(speed / 8.0, 0.0, 1.0) * 0.55;
    }
  }
  return foam;
}

void main() {
  vec2 worldXY = vec2(vThreePos.x, -vThreePos.z);
  float e = 0.55;
  float h0 = smallEta(worldXY) + capillary(worldXY);
  float hx = smallEta(worldXY + vec2(e, 0.0)) + capillary(worldXY + vec2(e, 0.0));
  float hy = smallEta(worldXY + vec2(0.0, e)) + capillary(worldXY + vec2(0.0, e));
  vec3 detail = normalize(vec3(-(hx - h0) / e, 1.0, (hy - h0) / e));
  vec3 N = normalize(mix(normalize(vNormal), detail, 0.82));
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vThreePos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, N);
  vec3 reflection = skyColor(R, uSunDir);
  float crest = clamp(vEta / max(uHs, 0.4) * 0.5 + 0.5, 0.0, 1.0);
  vec3 deep = srgbToLinear(vec3(0.015, 0.07, 0.12));
  vec3 shallow = srgbToLinear(vec3(0.04, 0.38, 0.46));
  vec3 water = mix(deep, shallow, crest);
  vec3 col = mix(water, reflection, fresnel);
  float sun = max(dot(normalize(R), uSunDir), 0.0);
  float spec = pow(sun, 90.0) * 0.35 + pow(sun, 1400.0);
  col += srgbToLinear(vec3(1.0, 0.97, 0.90)) * spec * (0.4 + 0.6 * fresnel);
  col += srgbToLinear(vec3(0.10, 0.40, 0.38)) * pow(crest, 2.0) * (1.0 - fresnel) * 0.45;
  float foamGate = mix(0.45, 0.75, clamp(uWind / 28.0, 0.0, 1.0));
  float foam = 1.0 - smoothstep(foamGate - 0.35, foamGate, vJacobian);
  foam = clamp(foam + smoothstep(0.22, 0.45, vSlope) * 0.35 + wakeFoam(worldXY), 0.0, 1.0);
  col = mix(col, srgbToLinear(vec3(0.90, 0.94, 0.96)), foam * 0.9);

  if (uOverlay > 0.5 && uOverlay < 1.5) {
    float u = clamp(vEta / max(0.25, uHs * 0.75) * 0.5 + 0.5, 0.0, 1.0);
    col = ramp5(u,
      srgbToLinear(vec3(0.129, 0.400, 0.675)),
      srgbToLinear(vec3(0.404, 0.663, 0.812)),
      srgbToLinear(vec3(0.969, 0.969, 0.969)),
      srgbToLinear(vec3(0.937, 0.541, 0.384)),
      srgbToLinear(vec3(0.698, 0.094, 0.169)));
  } else if (uOverlay > 1.5 && uOverlay < 2.5) {
    col = ramp5(clamp(vSlope / 0.3, 0.0, 1.0),
      srgbToLinear(vec3(0.051, 0.031, 0.529)),
      srgbToLinear(vec3(0.494, 0.012, 0.659)),
      srgbToLinear(vec3(0.800, 0.278, 0.471)),
      srgbToLinear(vec3(0.973, 0.584, 0.251)),
      srgbToLinear(vec3(0.941, 0.976, 0.129)));
  } else if (uOverlay > 2.5) {
    float u = clamp(1.0 - vJacobian, 0.0, 1.0);
    col = mix(srgbToLinear(vec3(0.031, 0.188, 0.420)), srgbToLinear(vec3(0.969, 0.984, 1.0)), u);
  }

  float dist = distance(cameraPosition, vThreePos);
  float fog = 1.0 - exp(-dist * dist * uFogDensity);
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));
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
uniform vec3 uSunDir;
varying vec3 vDir;
${SKY}
void main() {
  gl_FragColor = vec4(skyColor(normalize(vDir), uSunDir), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
