// Coordinador de concurrencia entre las acciones que cambian punto/periodo
// de forma asincrona (Consultar en Accesible, aplicar un preset compartido,
// elegir periodo en la linea de tiempo, clic en el globo/Peru). Sin esto,
// una consulta lenta que termina DESPUES de que el usuario ya hizo otra cosa
// (clic en el globo, otro periodo, otra consulta) podia sobreescribir la
// seleccion/periodo mas reciente con datos viejos.
//
// Regla: cada accion que puede tardar (o que puede ser invalidada por una
// accion posterior) pide un token con startAction() ANTES de empezar a
// esperar (await). Al volver de esperar, solo si isCurrent(token) sigue
// siendo true puede esa accion confirmar su resultado (seleccionar punto,
// sonificar, etc.). Cualquier accion nueva (incluida una sincrona, como un
// clic directo) invalida automaticamente las anteriores con solo pedir su
// propio token.
export function createActionCoordinator() {
  let token = 0;

  function startAction() {
    token += 1;
    return token;
  }

  function isCurrent(actionToken) {
    return actionToken === token;
  }

  return { startAction, isCurrent };
}

/**
 * Ejecuta `run()` (que debe devolver el contrato explicito
 * `{ ok: true, ... } | { ok: false, reason }`, ver changePeriod en
 * main.js) bajo el coordinador: pide un token ANTES de esperar, y solo si
 * sigue vigente DESPUES de esperar Y `run()` tuvo exito, llama a
 * `onSuccess(result)`. En cualquier otro caso (accion obsoleta o `run()`
 * fallido) NUNCA llama a `onSuccess`: este es el runner REAL que usa
 * main.js (onQuery de Accesible), no una reimplementacion de prueba.
 */
export async function runGuardedAction(coordinator, { run, onSuccess }) {
  const token = coordinator.startAction();
  const result = await run();
  if (!coordinator.isCurrent(token)) return { applied: false, reason: 'stale' };
  if (!result?.ok) return { applied: false, reason: result?.reason ?? 'error' };
  onSuccess?.(result);
  return { applied: true, result };
}
