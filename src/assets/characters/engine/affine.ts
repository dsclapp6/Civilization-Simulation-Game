// Tiny allocation-free affine math for the skinned crowds.
// Matrices are 3x4 row-major blocks of 12 numbers inside a flat array:
//   [r00 r01 r02 tx | r10 r11 r12 ty | r20 r21 r22 tz]
// Euler angles use order YXZ (R = Ry * Rx * Rz): yaw outermost, then pitch, then roll.
// Bone conventions (bind pose = identity rotations, limbs hang along -y, body faces +z, +x = body's left):
//   spine/head  +X leans/nods forward      limbs (hanging)  -X swings forward
//   +Y turns towards the body's left       left arm/leg +Z abducts (right side: -Z)

export type Arr = Float32Array | Float64Array | number[];

export function setIdentity(m: Arr, o: number): void {
  m[o] = 1; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
  m[o + 4] = 0; m[o + 5] = 1; m[o + 6] = 0; m[o + 7] = 0;
  m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = 1; m[o + 11] = 0;
}

export function setZero(m: Arr, o: number): void {
  for (let i = 0; i < 12; i++) m[o + i] = 0;
}

/** Local transform from YXZ Euler angles and a translation. */
export function setEulerT(m: Arr, o: number, x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
  let cx = 1, sx = 0, cy = 1, sy = 0, cz = 1, sz = 0;
  if (x !== 0) { cx = Math.cos(x); sx = Math.sin(x); }
  if (y !== 0) { cy = Math.cos(y); sy = Math.sin(y); }
  if (z !== 0) { cz = Math.cos(z); sz = Math.sin(z); }
  m[o] = cy * cz + sy * sx * sz; m[o + 1] = -cy * sz + sy * sx * cz; m[o + 2] = sy * cx; m[o + 3] = tx;
  m[o + 4] = cx * sz; m[o + 5] = cx * cz; m[o + 6] = -sx; m[o + 7] = ty;
  m[o + 8] = -sy * cz + cy * sx * sz; m[o + 9] = sy * sz + cy * sx * cz; m[o + 10] = cy * cx; m[o + 11] = tz;
}

/** out = a * b. `out` may alias neither a nor b at the same offset. */
export function mul(out: Arr, oo: number, a: Arr, ao: number, b: Arr, bo: number): void {
  const a00 = a[ao], a01 = a[ao + 1], a02 = a[ao + 2], a03 = a[ao + 3];
  const a10 = a[ao + 4], a11 = a[ao + 5], a12 = a[ao + 6], a13 = a[ao + 7];
  const a20 = a[ao + 8], a21 = a[ao + 9], a22 = a[ao + 10], a23 = a[ao + 11];
  const b00 = b[bo], b01 = b[bo + 1], b02 = b[bo + 2], b03 = b[bo + 3];
  const b10 = b[bo + 4], b11 = b[bo + 5], b12 = b[bo + 6], b13 = b[bo + 7];
  const b20 = b[bo + 8], b21 = b[bo + 9], b22 = b[bo + 10], b23 = b[bo + 11];
  out[oo] = a00 * b00 + a01 * b10 + a02 * b20;
  out[oo + 1] = a00 * b01 + a01 * b11 + a02 * b21;
  out[oo + 2] = a00 * b02 + a01 * b12 + a02 * b22;
  out[oo + 3] = a00 * b03 + a01 * b13 + a02 * b23 + a03;
  out[oo + 4] = a10 * b00 + a11 * b10 + a12 * b20;
  out[oo + 5] = a10 * b01 + a11 * b11 + a12 * b21;
  out[oo + 6] = a10 * b02 + a11 * b12 + a12 * b22;
  out[oo + 7] = a10 * b03 + a11 * b13 + a12 * b23 + a13;
  out[oo + 8] = a20 * b00 + a21 * b10 + a22 * b20;
  out[oo + 9] = a20 * b01 + a21 * b11 + a22 * b21;
  out[oo + 10] = a20 * b02 + a21 * b12 + a22 * b22;
  out[oo + 11] = a20 * b03 + a21 * b13 + a22 * b23 + a23;
}

/** World = parent * local(Euler, t) without building the local matrix separately. */
export function mulEulerT(out: Arr, oo: number, p: Arr, po: number,
  x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
  let cx = 1, sx = 0, cy = 1, sy = 0, cz = 1, sz = 0;
  if (x !== 0) { cx = Math.cos(x); sx = Math.sin(x); }
  if (y !== 0) { cy = Math.cos(y); sy = Math.sin(y); }
  if (z !== 0) { cz = Math.cos(z); sz = Math.sin(z); }
  const l00 = cy * cz + sy * sx * sz, l01 = -cy * sz + sy * sx * cz, l02 = sy * cx;
  const l10 = cx * sz, l11 = cx * cz, l12 = -sx;
  const l20 = -sy * cz + cy * sx * sz, l21 = sy * sz + cy * sx * cz, l22 = cy * cx;
  const p00 = p[po], p01 = p[po + 1], p02 = p[po + 2], p03 = p[po + 3];
  const p10 = p[po + 4], p11 = p[po + 5], p12 = p[po + 6], p13 = p[po + 7];
  const p20 = p[po + 8], p21 = p[po + 9], p22 = p[po + 10], p23 = p[po + 11];
  out[oo] = p00 * l00 + p01 * l10 + p02 * l20;
  out[oo + 1] = p00 * l01 + p01 * l11 + p02 * l21;
  out[oo + 2] = p00 * l02 + p01 * l12 + p02 * l22;
  out[oo + 3] = p00 * tx + p01 * ty + p02 * tz + p03;
  out[oo + 4] = p10 * l00 + p11 * l10 + p12 * l20;
  out[oo + 5] = p10 * l01 + p11 * l11 + p12 * l21;
  out[oo + 6] = p10 * l02 + p11 * l12 + p12 * l22;
  out[oo + 7] = p10 * tx + p11 * ty + p12 * tz + p13;
  out[oo + 8] = p20 * l00 + p21 * l10 + p22 * l20;
  out[oo + 9] = p20 * l01 + p21 * l11 + p22 * l21;
  out[oo + 10] = p20 * l02 + p21 * l12 + p22 * l22;
  out[oo + 11] = p20 * tx + p21 * ty + p22 * tz + p23;
}

/** Copy a 3x4 block. */
export function copy12(out: Arr, oo: number, a: Arr, ao: number): void {
  for (let i = 0; i < 12; i++) out[oo + i] = a[ao + i];
}

/** Uniformly scale the rotation part of a matrix in place (used to hide or resize attachments). */
export function scaleRot(m: Arr, o: number, s: number): void {
  m[o] *= s; m[o + 1] *= s; m[o + 2] *= s;
  m[o + 4] *= s; m[o + 5] *= s; m[o + 6] *= s;
  m[o + 8] *= s; m[o + 9] *= s; m[o + 10] *= s;
}

/** Transform a point; result written to out[0..2]. */
export function xformPoint(m: Arr, o: number, x: number, y: number, z: number, out: Arr): void {
  out[0] = m[o] * x + m[o + 1] * y + m[o + 2] * z + m[o + 3];
  out[1] = m[o + 4] * x + m[o + 5] * y + m[o + 6] * z + m[o + 7];
  out[2] = m[o + 8] * x + m[o + 9] * y + m[o + 10] * z + m[o + 11];
}

/** Rotate a direction; result written to out[0..2]. */
export function xformDir(m: Arr, o: number, x: number, y: number, z: number, out: Arr): void {
  out[0] = m[o] * x + m[o + 1] * y + m[o + 2] * z;
  out[1] = m[o + 4] * x + m[o + 5] * y + m[o + 6] * z;
  out[2] = m[o + 8] * x + m[o + 9] * y + m[o + 10] * z;
}

/**
 * Build a rotation+translation from basis vectors (columns = local x, y, z axes in world space).
 * Axes need not be perfectly orthonormal on input: y is kept, z is orthogonalised against it, x = y × z.
 */
export function setBasis(m: Arr, o: number,
  yx: number, yy: number, yz: number, zx: number, zy: number, zz: number,
  tx: number, ty: number, tz: number): void {
  let l = Math.hypot(yx, yy, yz) || 1;
  yx /= l; yy /= l; yz /= l;
  const d = zx * yx + zy * yy + zz * yz;
  zx -= d * yx; zy -= d * yy; zz -= d * yz;
  l = Math.hypot(zx, zy, zz);
  if (l < 1e-6) {
    // z parallel to y: pick any perpendicular
    if (Math.abs(yx) < 0.9) { zx = 0; zy = -yz; zz = yy; } else { zx = -yz; zy = 0; zz = yx; }
    l = Math.hypot(zx, zy, zz) || 1;
  }
  zx /= l; zy /= l; zz /= l;
  const xx = yy * zz - yz * zy, xy = yz * zx - yx * zz, xz = yx * zy - yy * zx;
  m[o] = xx; m[o + 1] = yx; m[o + 2] = zx; m[o + 3] = tx;
  m[o + 4] = xy; m[o + 5] = yy; m[o + 6] = zy; m[o + 7] = ty;
  m[o + 8] = xz; m[o + 9] = yz; m[o + 10] = zz; m[o + 11] = tz;
}

/** Linear blend of two 3x4 blocks into out (for cross-fades of attachment transforms). */
export function lerp12(out: Arr, oo: number, a: Arr, ao: number, b: Arr, bo: number, t: number): void {
  for (let i = 0; i < 12; i++) out[oo + i] = a[ao + i] + (b[bo + i] - a[ao + i]) * t;
}

const _e = [0, 0, 0];
const _s = [0, 0, 0];

/**
 * Analytic two-bone IK in world space.
 * Writes world matrices for the upper and lower bone (local -y runs along each bone, like the bind pose).
 * root: shoulder/hip world position; target: wrist/ankle goal; pole: direction the elbow/knee should point.
 * zSign: +1 makes each bone's local +z face the pole (knees: kneecap at +z), -1 faces away (elbows).
 * Returns the reach ratio actually achieved (1 = target reached).
 */
export function solveTwoBone(
  upperOut: Arr, uo: number, lowerOut: Arr, lo: number,
  rx: number, ry: number, rz: number,
  txIn: number, tyIn: number, tzIn: number,
  poleX: number, poleY: number, poleZ: number,
  lenA: number, lenB: number, zSign = 1,
): number {
  let dx = txIn - rx, dy = tyIn - ry, dz = tzIn - rz;
  let d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) { dx = 0; dy = -1; dz = 0; d = 1e-6; }
  const ux = dx / d, uy = dy / d, uz = dz / d;
  const maxReach = (lenA + lenB) * 0.9995;
  const minReach = Math.abs(lenA - lenB) * 1.02 + 1e-4;
  const reach = d;
  const dc = d > maxReach ? maxReach : d < minReach ? minReach : d;
  // pole component perpendicular to the root→target axis
  let pd = poleX * ux + poleY * uy + poleZ * uz;
  let px = poleX - pd * ux, py = poleY - pd * uy, pz = poleZ - pd * uz;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-6) {
    if (Math.abs(uy) < 0.9) { px = 0; py = 1; pz = 0; } else { px = 0; py = 0; pz = 1; }
    pd = px * ux + py * uy + pz * uz;
    px -= pd * ux; py -= pd * uy; pz -= pd * uz;
    pl = Math.hypot(px, py, pz) || 1;
  }
  px /= pl; py /= pl; pz /= pl;
  const cosA = (lenA * lenA + dc * dc - lenB * lenB) / (2 * lenA * dc);
  const ca = cosA > 1 ? 1 : cosA < -1 ? -1 : cosA;
  const sa = Math.sqrt(1 - ca * ca);
  // elbow
  const ex = rx + (ux * ca + px * sa) * lenA;
  const ey = ry + (uy * ca + py * sa) * lenA;
  const ez = rz + (uz * ca + pz * sa) * lenA;
  _e[0] = ex; _e[1] = ey; _e[2] = ez;
  // wrist actually reached
  const wx = rx + ux * dc, wy = ry + uy * dc, wz = rz + uz * dc;
  _s[0] = wx; _s[1] = wy; _s[2] = wz;
  // upper bone: local y points from elbow back to root (bones hang along -y); local z towards the pole
  const zx = px * zSign, zy = py * zSign, zz = pz * zSign;
  setBasis(upperOut, uo, rx - ex, ry - ey, rz - ez, zx, zy, zz, rx, ry, rz);
  // lower bone: from wrist back to elbow; keep z on the same side of the bend plane
  setBasis(lowerOut, lo, ex - wx, ey - wy, ez - wz, zx, zy, zz, ex, ey, ez);
  return reach > 0 ? Math.min(1, dc / reach) : 1;
}

/** Rotation+translation whose local z is exactly `z`; y is the up hint orthogonalised against it. */
export function setBasisZ(m: Arr, o: number,
  zx: number, zy: number, zz: number, ux: number, uy: number, uz: number,
  tx: number, ty: number, tz: number): void {
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
  l = Math.hypot(xx, xy, xz);
  if (l < 1e-6) { xx = 1; xy = 0; xz = 0; l = 1; }
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  m[o] = xx; m[o + 1] = yx; m[o + 2] = zx; m[o + 3] = tx;
  m[o + 4] = xy; m[o + 5] = yy; m[o + 6] = zy; m[o + 7] = ty;
  m[o + 8] = xz; m[o + 9] = yz; m[o + 10] = zz; m[o + 11] = tz;
}

/** Last elbow/knee and wrist positions computed by solveTwoBone. */
export function lastIkJoint(): readonly number[] { return _e; }
export function lastIkEnd(): readonly number[] { return _s; }
