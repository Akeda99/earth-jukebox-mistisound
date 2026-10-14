import { describe, it, expect } from 'vitest';
import { createActionCoordinator, runGuardedAction } from '../src/app/action-coordinator.js';

// Coordinador REAL usado por main.js (src/app/action-coordinator.js), no
// una reimplementacion de prueba: estas pruebas ejercitan exactamente el
// mismo modulo que selectPoint/timeline/onQuery/preset usan en produccion
// para decidir si una accion asincrona todavia puede confirmar su
// resultado (ver revision: "consultas fuera de orden y fallida").
describe('createActionCoordinator (coordinador real de main.js)', () => {
  it('una accion que termina sin que nada mas haya empezado sigue vigente', () => {
    const coordinator = createActionCoordinator();
    const token = coordinator.startAction();
    expect(coordinator.isCurrent(token)).toBe(true);
  });

  it('una accion nueva invalida a la anterior todavia en vuelo (clic directo mientras una consulta espera)', async () => {
    const coordinator = createActionCoordinator();
    const applied = [];

    async function runQuery(label, delayMs) {
      const token = coordinator.startAction();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!coordinator.isCurrent(token)) return; // descartada: una accion mas nueva ya ganó
      applied.push(label);
    }

    // La consulta A tarda mas que B: sin coordinador, A terminaria DESPUES
    // y pisaria la seleccion de B con su coordenada vieja.
    const pendingA = runQuery('A-vieja', 30);
    // B es una accion directa (clic en el globo), posterior a A, que debe
    // ganar aunque A siga en vuelo.
    const pendingB = runQuery('B-nueva', 5);

    await Promise.all([pendingA, pendingB]);

    expect(applied).toEqual(['B-nueva']);
  });

  it('tres acciones encadenadas: solo la ultima en terminar DESPUES de empezar ultima queda vigente', async () => {
    const coordinator = createActionCoordinator();
    const t1 = coordinator.startAction();
    const t2 = coordinator.startAction();
    const t3 = coordinator.startAction();
    expect(coordinator.isCurrent(t1)).toBe(false);
    expect(coordinator.isCurrent(t2)).toBe(false);
    expect(coordinator.isCurrent(t3)).toBe(true);
  });
});

// runGuardedAction es el runner REAL que usa main.js dentro de onQuery
// (Accesible): no se reimplementa aqui con un try/catch generico ad-hoc
// como en la version anterior de este archivo (eso no reproducia el bug
// real, que no era una excepcion sino el contrato de retorno de
// changePeriod: antes devolvia `undefined` tanto en exito como en error, y
// el llamador aplicaba selectPoint/sonido igualmente). Estas pruebas usan
// el contrato explicito `{ ok, reason }` (ver changePeriod en main.js) con
// un `run()` de prueba, pero el runner que decide cuando llamar a
// `onSuccess` es el mismo que corre en produccion.
describe('runGuardedAction (runner real compartido con main.js)', () => {
  it('run() fallido (periodo 404/error): onSuccess NUNCA se llama (no se aplica punto ni se sonifica)', async () => {
    const coordinator = createActionCoordinator();
    const onSuccess = () => {
      throw new Error('onSuccess no debia llamarse tras un fallo');
    };
    const result = await runGuardedAction(coordinator, {
      run: () => Promise.resolve({ ok: false, reason: 'error' }),
      onSuccess
    });
    expect(result).toEqual({ applied: false, reason: 'error' });
  });

  it('run() que devuelve "not-found" (periodo inexistente): tampoco aplica', async () => {
    const coordinator = createActionCoordinator();
    let called = false;
    const result = await runGuardedAction(coordinator, {
      run: () => Promise.resolve({ ok: false, reason: 'not-found' }),
      onSuccess: () => {
        called = true;
      }
    });
    expect(called).toBe(false);
    expect(result.applied).toBe(false);
  });

  it('consultas fuera de orden: solo la ULTIMA accion iniciada puede confirmar, aunque termine antes', async () => {
    const coordinator = createActionCoordinator();
    const confirmed = [];

    function runQuery(label, delayMs, ok = true) {
      return runGuardedAction(coordinator, {
        run: () => new Promise((resolve) => setTimeout(() => resolve({ ok }), delayMs)),
        onSuccess: () => confirmed.push(label)
      });
    }

    // A arranca primero pero tarda mas; B arranca despues y gana porque es
    // la accion vigente cuando ambas terminan.
    const pendingA = runQuery('A-vieja', 30);
    const pendingB = runQuery('B-nueva', 5);
    const [resultA, resultB] = await Promise.all([pendingA, pendingB]);

    expect(confirmed).toEqual(['B-nueva']);
    expect(resultA.applied).toBe(false);
    expect(resultA.reason).toBe('stale');
    expect(resultB.applied).toBe(true);
  });

  it('punto/periodo/celda se confirman coherentes: una respuesta vieja nunca sobreescribe la accion nueva ya confirmada', async () => {
    const coordinator = createActionCoordinator();
    // Simula el "store" real: un unico objeto con punto+periodo+celda que
    // SOLO runGuardedAction.onSuccess puede mutar, igual que selectPoint en
    // main.js solo se llama cuando el periodo asociado ya se confirmo.
    const state = { point: null, period: null, cell: null };

    function applyQuery(label, period, delayMs, ok) {
      return runGuardedAction(coordinator, {
        run: () =>
          new Promise((resolve) => setTimeout(() => resolve(ok ? { ok: true, period } : { ok: false, reason: 'error' }), delayMs)),
        onSuccess: () => {
          state.point = label;
          state.period = period;
          state.cell = `celda-de-${period}`;
        }
      });
    }

    // Vieja consulta a un periodo DISTINTO, lenta y que ademas falla; nueva
    // consulta a otro punto/periodo, rapida y exitosa. El resultado final
    // debe ser integramente el de la nueva accion (nunca una mezcla, p.ej.
    // periodo nuevo con celda vieja).
    const pendingOld = applyQuery('viejo', '2020-01', 40, false);
    const pendingNew = applyQuery('nuevo', '2023-06', 5, true);
    await Promise.all([pendingOld, pendingNew]);

    expect(state).toEqual({ point: 'nuevo', period: '2023-06', cell: 'celda-de-2023-06' });
  });
});
