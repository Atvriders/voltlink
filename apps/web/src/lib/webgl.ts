// WebGL capability probe (guide 07 §2.2): shared by the map and the 3D viewer,
// and imports neither maplibre-gl nor three so no chunk pulls in the other.

export function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ?? (canvas.getContext('webgl') as WebGLRenderingContext | null);
    return !!gl;
  } catch {
    return false;
  }
}
