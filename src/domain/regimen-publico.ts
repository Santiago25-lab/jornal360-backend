import { ConceptoCatalogo, TipoParametro } from './catalogo';

/**
 * Reglas por defecto del sector público territorial (alcaldías, gobernaciones).
 * Son valores de partida: la entidad los revisa y ajusta con su decreto salarial.
 */

const DESDE = '2020-01-01';

/** Parámetros que cambian de valor frente al sector privado. */
export const CAMBIOS_PUBLICO: { codigo: string; valor: string; motivo: string }[] = [
  { codigo: 'HORAS_SEMANALES', valor: '44', motivo: 'Decreto 1042 de 1978 art. 33' },
  { codigo: 'RECARGO_DESCANSO', valor: '1', motivo: 'Decreto 1042 de 1978 art. 39' },
  { codigo: 'PCT_SENA', valor: '0.005', motivo: 'Ley 21 de 1982 art. 11' },
  { codigo: 'PCT_PROV_PRIMA', valor: '0.0416666667', motivo: 'Decreto 2351 de 2014 (15 días por año)' },
];

/** Parámetros que solo existen en el sector público. */
export const PARAMETROS_PUBLICO: { codigo: string; nombre: string; tipo: TipoParametro; valor: string; descripcion: string }[] = [
  { codigo: 'PCT_ESAP', nombre: 'Aporte ESAP', tipo: 'porcentaje', valor: '0.005', descripcion: 'Ley 21 de 1982 art. 11.' },
  { codigo: 'PCT_ESCUELAS_INDUSTRIALES', nombre: 'Aporte escuelas industriales e institutos técnicos', tipo: 'porcentaje', valor: '0.01', descripcion: 'Ley 21 de 1982 art. 11.' },
  { codigo: 'PCT_PROV_PRIMA_NAVIDAD', nombre: 'Provisión mensual de prima de navidad', tipo: 'porcentaje', valor: '0.0833333333', descripcion: 'Un mes de salario por año (Decreto 1045 de 1978 art. 32).' },
  { codigo: 'PCT_PROV_PRIMA_VACACIONES', nombre: 'Provisión mensual de prima de vacaciones', tipo: 'porcentaje', valor: '0.0416666667', descripcion: '15 días de salario por año de servicio (Decreto 1045 de 1978 art. 24).' },
  { codigo: 'PCT_BONIF_SERVICIOS_BAJO', nombre: 'Bonificación por servicios prestados (hasta el tope)', tipo: 'porcentaje', valor: '0.5', descripcion: '50 % de la asignación básica por año (Decreto 2418 de 2015).' },
  { codigo: 'PCT_BONIF_SERVICIOS_ALTO', nombre: 'Bonificación por servicios prestados (sobre el tope)', tipo: 'porcentaje', valor: '0.35', descripcion: '35 % de la asignación básica por año (Decreto 2418 de 2015).' },
  { codigo: 'TOPE_BONIF_SERVICIOS', nombre: 'Tope de la bonificación por servicios prestados', tipo: 'dinero', valor: '2100000', descripcion: 'VALOR DE EJEMPLO: confirme el tope con el decreto salarial del año.' },
  { codigo: 'DIAS_BONIF_RECREACION', nombre: 'Días de bonificación especial de recreación', tipo: 'dias', valor: '2', descripcion: 'Dos días de asignación básica por cada periodo de vacaciones (decreto salarial anual).' },
  { codigo: 'DIAS_PRIMA_SERVICIOS_PUBLICA', nombre: 'Días de prima de servicios por año (sector público)', tipo: 'dias', valor: '15', descripcion: 'Decreto 2351 de 2014.' },
  { codigo: 'DIAS_PRIMA_NAVIDAD', nombre: 'Días de prima de navidad por año', tipo: 'dias', valor: '30', descripcion: 'Decreto 1045 de 1978 art. 32.' },
  { codigo: 'DIAS_PRIMA_VACACIONES', nombre: 'Días de prima de vacaciones por año', tipo: 'dias', valor: '15', descripcion: 'Decreto 1045 de 1978 art. 25.' },
];

export const VIGENCIAS_PUBLICO = PARAMETROS_PUBLICO.map((p) => ({ codigo: p.codigo, desde: DESDE, valor: p.valor }));

const sinBases = {
  salarial: false,
  baseIbc: false,
  baseArl: false,
  baseParafiscales: false,
  basePrestaciones: false,
  baseVacaciones: false,
  baseRetencion: false,
  cuenta40: false,
  esLegal: false,
  redondeo: 'peso' as const,
};

/** Conceptos que se agregan en el sector público (aportes y provisiones de primas y bonificaciones). */
export const CONCEPTOS_PUBLICO: ConceptoCatalogo[] = [
  { codigo: 'APORTE_ESAP', nombre: 'Aporte ESAP', tipo: 'aporte_empleador', formula: 'IBC_PARAFISCALES * PCT_ESAP', orden: 206, baseLegal: 'Ley 21 de 1982 art. 11', ...sinBases, redondeo: 'centena_arriba' },
  { codigo: 'APORTE_ESCUELAS_INDUSTRIALES', nombre: 'Aporte escuelas industriales', tipo: 'aporte_empleador', formula: 'IBC_PARAFISCALES * PCT_ESCUELAS_INDUSTRIALES', orden: 207, baseLegal: 'Ley 21 de 1982 art. 11', ...sinBases, redondeo: 'centena_arriba' },
  { codigo: 'PROV_PRIMA_NAVIDAD', nombre: 'Provisión de prima de navidad', tipo: 'provision', formula: 'SUELDO_PROPORCIONAL * PCT_PROV_PRIMA_NAVIDAD', orden: 304, baseLegal: 'Decreto 1045 de 1978 art. 32', ...sinBases },
  { codigo: 'PROV_PRIMA_VACACIONES', nombre: 'Provisión de prima de vacaciones', tipo: 'provision', formula: 'SUELDO_PROPORCIONAL * PCT_PROV_PRIMA_VACACIONES', orden: 305, baseLegal: 'Decreto 1045 de 1978 art. 24', ...sinBases },
  {
    codigo: 'PROV_BONIF_SERVICIOS',
    nombre: 'Provisión de bonificación por servicios prestados',
    tipo: 'provision',
    formula: 'SUELDO_PROPORCIONAL * SI(SALARIO <= TOPE_BONIF_SERVICIOS; PCT_BONIF_SERVICIOS_BAJO; PCT_BONIF_SERVICIOS_ALTO) / 12',
    orden: 306,
    baseLegal: 'Decreto 2418 de 2015',
    ...sinBases,
  },
  { codigo: 'PROV_BONIF_RECREACION', nombre: 'Provisión de bonificación especial de recreación', tipo: 'provision', formula: 'SALARIO_DIARIO * DIAS_BONIF_RECREACION / 12 * DIAS_SALARIO / DIAS_MES', orden: 307, baseLegal: 'Decreto salarial anual', ...sinBases },
];

/** En el sector público los afiliados al FNA reciben los intereses del Fondo, no de la entidad. */
export const FORMULA_PROV_INTERESES_PUBLICO = 'SI(CESANTIAS_FNA; 0; PROV_CESANTIAS * PCT_INTERESES_CESANTIAS)';
