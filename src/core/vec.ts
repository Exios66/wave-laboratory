/**
 * Minimal 3D vector, quaternion and 3×3 matrix maths for the physics code.
 *
 * Frames: world is right-handed, z-up (x east, y north). Vessel body axes follow the
 * ITTC/SNAME convention adapted to z-up: x forward, y to port, z up.
 * Quaternions are unit quaternions (w, x, y, z) rotating body → world.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  w: number;
  x: number;
  y: number;
  z: number;
}

/** Row-major 3×3 matrix stored as 9 numbers. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? scale(a, 1 / l) : vec3();
}

export const quatIdentity = (): Quat => ({ w: 1, x: 0, y: 0, z: 0 });

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = normalize(axis);
  const s = Math.sin(angle / 2);
  return { w: Math.cos(angle / 2), x: n.x * s, y: n.y * s, z: n.z * s };
}

export function quatMul(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q.w, q.x, q.y, q.z);
  return l > 0 ? { w: q.w / l, x: q.x / l, y: q.y / l, z: q.z / l } : quatIdentity();
}

export const quatConjugate = (q: Quat): Quat => ({ w: q.w, x: -q.x, y: -q.y, z: -q.z });

/** Rotate vector v by unit quaternion q (body → world when q is the vessel attitude). */
export function rotate(q: Quat, v: Vec3): Vec3 {
  // t = 2 * cross(q.xyz, v); v' = v + w t + cross(q.xyz, t)
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Rotate by the inverse of q (world → body). */
export const rotateInverse = (q: Quat, v: Vec3): Vec3 => rotate(quatConjugate(q), v);

/**
 * Integrate attitude with body-frame angular velocity ω over dt using the exact exponential map
 * (q ← q ⊗ exp(ω dt / 2)). Stays unit-length to machine precision.
 */
export function integrateQuat(q: Quat, omegaBody: Vec3, dt: number): Quat {
  const angle = length(omegaBody) * dt;
  if (angle < 1e-12) return q;
  return quatNormalize(quatMul(q, quatFromAxisAngle(omegaBody, angle)));
}

/**
 * Euler angles (roll φ about x, pitch θ about y, yaw ψ about z), ZYX convention, radians.
 * With z-up / y-port axes: positive roll = starboard side down, positive pitch = bow down,
 * positive yaw = turning to port (counter-clockwise seen from above).
 */
export function quatToEuler(q: Quat): { roll: number; pitch: number; yaw: number } {
  const sinrCosp = 2 * (q.w * q.x + q.y * q.z);
  const cosrCosp = 1 - 2 * (q.x * q.x + q.y * q.y);
  const sinp = 2 * (q.w * q.y - q.z * q.x);
  const sinycosp = 2 * (q.w * q.z + q.x * q.y);
  const cosycosp = 1 - 2 * (q.y * q.y + q.z * q.z);
  return {
    roll: Math.atan2(sinrCosp, cosrCosp),
    pitch: Math.abs(sinp) >= 1 ? (Math.sign(sinp) * Math.PI) / 2 : Math.asin(sinp),
    yaw: Math.atan2(sinycosp, cosycosp),
  };
}

export function quatFromEuler(roll: number, pitch: number, yaw: number): Quat {
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  return {
    w: cr * cp * cy + sr * sp * sy,
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
  };
}

export const mat3Diag = (a: number, b: number, c: number): Mat3 => [a, 0, 0, 0, b, 0, 0, 0, c];

export function mat3MulVec(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}

export function mat3Inverse(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-300) throw new RangeError('Singular 3×3 matrix');
  const s = 1 / det;
  return [
    A * s,
    -(b * i - c * h) * s,
    (b * f - c * e) * s,
    B * s,
    (a * i - c * g) * s,
    -(a * f - c * d) * s,
    C * s,
    -(a * h - b * g) * s,
    (a * e - b * d) * s,
  ];
}
