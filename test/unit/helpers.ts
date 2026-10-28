import { CONCEPTOS, PARAMETROS, TABLAS } from '../../src/domain/catalogo';
import { ContextoNomina, EntradaNomina, liquidarEmpleado, ResultadoNomina } from '../../src/domain/nomina';
import { ParametrosEnMemoria, TablasEnMemoria } from '../../src/domain/parametros';

export const parametrosCatalogo = () =>
  new ParametrosEnMemoria(PARAMETROS.flatMap((p) => p.vigencias.map((v) => ({ codigo: p.codigo, desde: v.desde, valor: v.valor }))));

export const tablasCatalogo = () => new TablasEnMemoria(TABLAS);

export const contexto = (over: Partial<ContextoNomina> = {}): ContextoNomina => ({
  conceptos: CONCEPTOS.map((c) => ({ ...c })),
  parametros: parametrosCatalogo(),
  tablas: tablasCatalogo(),
  empresa: { exonerada: true },
  ...over,
});

export const entrada = (salario: number, over: Partial<EntradaNomina> = {}): EntradaNomina => ({
  periodo: { desde: '2026-10-01', hasta: '2026-10-31' },
  empleado: { id: 'E1', claseRiesgo: 1, fechaIngreso: '2024-01-01' },
  contrato: { tipo: 'indefinido', fechaInicio: '2024-01-01', historialSalario: [{ desde: '2024-01-01', salario }] },
  ...over,
});

export const liquidar = (e: EntradaNomina, ctx = contexto()): ResultadoNomina => {
  const r = liquidarEmpleado(e, ctx);
  if (!r) throw new Error('Sin liquidación');
  return r;
};

/** Valor de una línea por código (o '0' si no aparece). */
export const v = (r: ResultadoNomina, codigo: string): string =>
  r.lineas.filter((l) => l.concepto === codigo).reduce((a, l) => a + Number(l.valor), 0).toString();
