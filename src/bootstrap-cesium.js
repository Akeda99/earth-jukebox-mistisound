// Debe importarse ANTES que cualquier modulo 'cesium' en toda la app.
// Cesium busca sus assets (Workers/Assets/ThirdParty/Widgets) relativos a
// window.CESIUM_BASE_URL. Si la app se sirve bajo una subcarpeta (por
// ejemplo GitHub Pages en /mi-repo/), BASE_URL de Vite ya incluye ese
// prefijo, asi que construimos la ruta relativa a ella en vez de asumir
// que la app vive en la raiz del dominio ('/cesium').
window.CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;
