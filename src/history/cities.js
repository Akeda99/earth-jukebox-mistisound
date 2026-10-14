// Catalogo GeoNames (cities15000, CC BY 4.0) preparado por
// scripts/prepare_geonames.py. Se descarga SOLO la primera vez que el usuario
// interactua con la busqueda de ciudad (no en el arranque) y la busqueda es
// local: ningun proveedor recibe la ciudad ni la fecha.
let pending = null;

export function loadCityCatalog({ fetchImpl = (...a) => globalThis.fetch(...a), baseUrl = '' } = {}) {
  if (!pending) {
    pending = (async () => {
      const res = await fetchImpl(`${baseUrl}geonames-cities.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status} al cargar el catalogo de ciudades`);
      const json = await res.json();
      if (!Array.isArray(json?.rows) || json.rows.length === 0) throw new Error('Catalogo de ciudades vacio o invalido');
      return json;
    })().catch((err) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}

export function resetCityCatalogForTests() {
  pending = null;
}
