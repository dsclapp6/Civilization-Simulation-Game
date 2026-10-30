// Scene-wide atmosphere for every built-in three.js material (including asset-library ones):
// replaces the stock fog chunks with aerial-perspective fog (exponential distance haze + sun-side
// in-scatter + analytic ground mist) and adds moving cloud shadows to direct light.
//
// How the live values reach every material without touching asset code: uniforms whose value is
// a Float32Array are shared by reference through UniformsUtils.clone, so adding them to
// ShaderLib.*.uniforms once makes every later-compiled built-in material read the same arrays.
// ShaderMaterials (assets' own) that include the fog chunks get the same code; if they lack the
// uniforms (all zeros) the chunk degrades to plain exponential fog.
//
// Semantics change: with THREE.FogExp2 the density now means exponential (not squared) haze,
// `1 - exp(-density * distance)`; the renderer owns the scene fog so this is consistent.
import * as THREE from 'three';

export const atmoUniforms = {
  /** Unit vector towards the sun (world). */
  atmoSunDir: { value: new Float32Array([0, 1, 0]) },
  /** Extra fog colour towards the sun (same colour space as fogColor). */
  atmoSunFog: { value: new Float32Array([0, 0, 0]) },
  /** x: mist density at base, y: 1/mist falloff height, z: mist base height (world y), w: sun in-scatter exponent. */
  atmoParams: { value: new Float32Array([0, 0.04, 0, 8]) },
  /** x: cloud coverage 0..1, y/z: cloud offset (m), w: cloud shadow strength 0..1. */
  atmoCloud: { value: new Float32Array([0, 0, 0, 0]) },
  /** Final grade applied with the fog: x = desaturation 0..1, yzw = shadow lift colour (night blue). */
  atmoGrade: { value: new Float32Array([0, 0, 0, 0]) },
};

const PARS_VERTEX = /* glsl */`
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
#endif
`;

const VERTEX = /* glsl */`
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogWorldPos = transpose( mat3( viewMatrix ) ) * ( mvPosition.xyz - viewMatrix[ 3 ].xyz );
#endif
`;

const PARS_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogWorldPos;
	uniform vec3 atmoSunDir;
	uniform vec3 atmoSunFog;
	uniform vec4 atmoParams;
	uniform vec4 atmoCloud;
	uniform vec4 atmoGrade;
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
	float atmoHash( vec2 p ) {
		p = fract( p * vec2( 123.34, 456.21 ) );
		p += dot( p, p + 45.32 );
		return fract( p.x * p.y );
	}
	float atmoNoise( vec2 p ) {
		vec2 i = floor( p );
		vec2 f = fract( p );
		vec2 u = f * f * ( 3.0 - 2.0 * f );
		float a = atmoHash( i );
		float b = atmoHash( i + vec2( 1.0, 0.0 ) );
		float c = atmoHash( i + vec2( 0.0, 1.0 ) );
		float d = atmoHash( i + vec2( 1.0, 1.0 ) );
		return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
	}
	float atmoCloudShadow( vec3 wp ) {
		if ( atmoCloud.w <= 0.0 ) return 1.0;
		// project along the light onto the cloud layer (~1200 m up)
		vec2 p = wp.xz + atmoSunDir.xz / max( atmoSunDir.y, 0.15 ) * ( 1200.0 - wp.y );
		p = ( p + atmoCloud.yz ) / 1400.0;
		float n = atmoNoise( p ) * 0.62 + atmoNoise( p * 2.7 + 3.1 ) * 0.38;
		float cov = smoothstep( 1.0 - atmoCloud.x, 1.0 - atmoCloud.x + 0.28, n );
		return 1.0 - cov * atmoCloud.w;
	}
#endif
`;

const FRAGMENT = /* glsl */`
#ifdef USE_FOG
	vec3 fogRay = vFogWorldPos - cameraPosition;
	float fogDist = length( fogRay );
	vec3 fogDir = fogRay / max( fogDist, 1e-3 );
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDist );
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	if ( atmoParams.x > 0.0 ) {
		float hb = atmoParams.y;
		float y0 = max( cameraPosition.y - atmoParams.z, -20.0 );
		float k = hb * fogRay.y;
		float integ = abs( k ) > 1e-4 ? ( 1.0 - exp( - k ) ) / k : 1.0;
		float mist = atmoParams.x * exp( - y0 * hb ) * integ * fogDist;
		fogFactor = 1.0 - ( 1.0 - fogFactor ) * exp( - min( mist, 30.0 ) );
	}
	vec3 fogCol = fogColor + atmoSunFog * pow( max( dot( fogDir, atmoSunDir ), 0.0 ), atmoParams.w );
	// scene grade (moonlit nights desaturate and shift blue); zeros from un-adopted shaders are ignored
	if ( atmoGrade.x > 0.0 ) {
		// dim surfaces lose colour and their shadows lift towards the night blue (scotopic vision);
		// bright lights such as lit windows and fires keep theirs
		float gl = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
		float keep = smoothstep( 0.3, 0.7, gl );
		vec3 graded = mix( gl_FragColor.rgb, vec3( gl ), atmoGrade.x ) + atmoGrade.yzw * ( 1.0 - smoothstep( 0.0, 0.45, gl ) );
		gl_FragColor.rgb = mix( graded, gl_FragColor.rgb, keep );
	}
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, clamp( fogFactor, 0.0, 1.0 ) );
#endif
`;

const CLOUD_SHADOW = /* glsl */`
#ifdef USE_FOG
	{
		float atmoCS = atmoCloudShadow( vFogWorldPos );
		reflectedLight.directDiffuse *= atmoCS;
		reflectedLight.directSpecular *= atmoCS;
	}
#endif
`;

let installed = false;

/** Idempotently patch ShaderChunk/ShaderLib. Must run before materials are first compiled. */
export function installAtmospherePatch(): void {
  if (installed) return;
  installed = true;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  chunks.fog_pars_vertex = PARS_VERTEX;
  chunks.fog_vertex = VERTEX;
  chunks.fog_pars_fragment = PARS_FRAGMENT;
  chunks.fog_fragment = FRAGMENT;
  if (!chunks.lights_fragment_end.includes('atmoCloudShadow')) {
    chunks.lights_fragment_end = CLOUD_SHADOW + chunks.lights_fragment_end;
  }
  // Directional PCF shadows fade out towards the edge of the (camera-fitted) shadow map instead
  // of ending in a hard line. Only the first getShadow (the 2D PCF variant) is changed.
  const ret = 'return mix( 1.0, shadow, shadowIntensity );';
  const pars = chunks.shadowmap_pars_fragment;
  const at = pars.indexOf(ret, pars.indexOf('float getShadow( sampler2DShadow'));
  if (at > 0 && !pars.includes('atmoShadowEdge')) {
    chunks.shadowmap_pars_fragment = pars.slice(0, at)
      + 'vec2 atmoShadowEdge = min( shadowCoord.xy, 1.0 - shadowCoord.xy );\n\t\t\t'
      + 'return mix( 1.0, shadow, shadowIntensity * smoothstep( 0.0, 0.1, min( atmoShadowEdge.x, atmoShadowEdge.y ) ) );'
      + pars.slice(at + ret.length);
  }
  const lib = THREE.ShaderLib as unknown as Record<string, { uniforms: Record<string, THREE.IUniform> }>;
  for (const key of Object.keys(lib)) {
    const shader = lib[key];
    if (shader && shader.uniforms) Object.assign(shader.uniforms, atmoUniforms);
  }
  const uLib = THREE.UniformsLib as unknown as Record<string, Record<string, THREE.IUniform>>;
  Object.assign(uLib.fog, atmoUniforms);
}

/** Give ShaderMaterials (e.g. asset-library custom shaders) the shared atmosphere uniforms. */
export function adoptMaterial(material: THREE.Material): void {
  const sm = material as THREE.ShaderMaterial;
  if (sm.isShaderMaterial && sm.fog && sm.uniforms && !('atmoSunDir' in sm.uniforms)) Object.assign(sm.uniforms, atmoUniforms);
}

/** Walk an object tree and adopt its materials (cheap; call when adding asset objects). */
export function adoptObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    if (Array.isArray(m)) m.forEach(adoptMaterial);
    else adoptMaterial(m);
  });
}
