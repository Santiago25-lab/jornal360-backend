/**
 * Catálogo inicial de Jornal 360: parámetros legales, tablas y conceptos de nómina.
 * Es solo el punto de partida: todo queda en la base de datos y el superusuario
 * puede modificarlo desde el panel de configuración ("la calculadora").
 */

export type TipoParametro = 'dinero' | 'porcentaje' | 'numero' | 'booleano' | 'horas' | 'dias';

export type CategoriaParametro =
  | 'salario'
  | 'jornada'
  | 'recargos'
  | 'seguridad_social'
  | 'prestaciones'
  | 'incapacidades'
  | 'retencion'
  | 'descuentos'
  | 'aprendices'
  | 'retiro'
  | 'redondeo';

export interface ParametroCatalogo {
  codigo: string;
  nombre: string;
  descripcion: string;
  categoria: CategoriaParametro;
  tipo: TipoParametro;
  baseLegal?: string;
  /** Valores con su fecha de inicio de vigencia. */
  vigencias: { desde: string; valor: string }[];
}

const P = (
  codigo: string,
  nombre: string,
  categoria: CategoriaParametro,
  tipo: TipoParametro,
  valor: string | { desde: string; valor: string }[],
  descripcion: string,
  baseLegal?: string,
): ParametroCatalogo => ({
  codigo,
  nombre,
  categoria,
  tipo,
  descripcion,
  baseLegal,
  vigencias: typeof valor === 'string' ? [{ desde: '2020-01-01', valor }] : valor,
});

export const PARAMETROS: ParametroCatalogo[] = [
  // Salario
  P('SMMLV', 'Salario mínimo mensual', 'salario', 'dinero', [
    { desde: '2025-01-01', valor: '1423500' },
    { desde: '2026-01-01', valor: '1750905' },
  ], 'Salario mínimo legal mensual vigente.', 'Decreto 1469 de 2025 (valor mantenido por Decreto 0159 de 2026)'),
  P('AUX_TRANSPORTE', 'Auxilio de transporte mensual', 'salario', 'dinero', [
    { desde: '2025-01-01', valor: '200000' },
    { desde: '2026-01-01', valor: '249095' },
  ], 'Valor mensual del auxilio de transporte.', 'Decreto 1470 de 2025'),
  P('TOPE_AUX_TRANSPORTE_SMMLV', 'Tope para auxilio de transporte (en salarios mínimos)', 'salario', 'numero', '2', 'Quien gane hasta este número de salarios mínimos recibe auxilio de transporte.', 'Ley 15 de 1959'),
  P('UVT', 'Valor de la UVT', 'retencion', 'dinero', [
    { desde: '2025-01-01', valor: '49799' },
    { desde: '2026-01-01', valor: '52374' },
  ], 'Unidad de Valor Tributario.', 'Resolución DIAN 000238 de 2025'),
  P('DIAS_MES', 'Días del mes para liquidar', 'salario', 'dias', '30', 'Días base del mes comercial.', 'CST art. 134'),
  P('DIAS_ANIO', 'Días del año para prestaciones', 'prestaciones', 'dias', '360', 'Días base del año comercial.'),
  P('INTEGRAL_MIN_SMMLV', 'Salario integral mínimo (en salarios mínimos)', 'salario', 'numero', '10', 'Mínimo del salario integral antes del factor prestacional.', 'CST art. 132'),
  P('INTEGRAL_FACTOR_MIN', 'Factor prestacional mínimo del salario integral', 'salario', 'porcentaje', '0.30', 'Porcentaje mínimo del factor prestacional.', 'CST art. 132'),

  // Jornada
  P('HORAS_SEMANALES', 'Jornada máxima semanal (horas)', 'jornada', 'horas', [
    { desde: '2024-07-15', valor: '46' },
    { desde: '2025-07-15', valor: '44' },
    { desde: '2026-07-15', valor: '42' },
  ], 'Horas semanales de la jornada ordinaria máxima.', 'CST art. 161; Ley 2101 de 2021'),
  P('MAX_EXTRAS_DIA', 'Máximo de horas extra al día', 'jornada', 'horas', '2', 'Se genera una alerta si se supera.', 'Ley 2101 de 2021'),
  P('MAX_EXTRAS_SEMANA', 'Máximo de horas extra a la semana', 'jornada', 'horas', '12', 'Se genera una alerta si se supera.', 'Ley 2101 de 2021'),

  // Recargos
  P('RECARGO_HON', 'Recargo nocturno', 'recargos', 'porcentaje', '0.35', 'Recargo por trabajo nocturno.', 'CST art. 168 num. 1'),
  P('RECARGO_HED', 'Recargo hora extra diurna', 'recargos', 'porcentaje', '0.25', 'Recargo de la hora extra diurna.', 'CST art. 168 num. 2'),
  P('RECARGO_HEN', 'Recargo hora extra nocturna', 'recargos', 'porcentaje', '0.75', 'Recargo de la hora extra nocturna (no se le suma el nocturno).', 'CST art. 168 nums. 3 y 4'),
  P('RECARGO_DESCANSO', 'Recargo por trabajo en día de descanso o festivo', 'recargos', 'porcentaje', [
    { desde: '2020-01-01', valor: '0.75' },
    { desde: '2025-07-01', valor: '0.80' },
    { desde: '2026-07-01', valor: '0.90' },
    { desde: '2027-07-01', valor: '1.00' },
  ], 'Recargo por trabajar en día de descanso obligatorio o festivo.', 'CST art. 179, parágrafo transitorio'),

  // Seguridad social
  P('PCT_SALUD_EMPLEADO', 'Salud a cargo del empleado', 'seguridad_social', 'porcentaje', '0.04', '', 'Ley 100 de 1993'),
  P('PCT_PENSION_EMPLEADO', 'Pensión a cargo del empleado', 'seguridad_social', 'porcentaje', '0.04', '', 'Ley 100 de 1993'),
  P('PCT_SALUD_EMPLEADOR', 'Salud a cargo del empleador', 'seguridad_social', 'porcentaje', '0.085', '', 'Ley 100 de 1993'),
  P('PCT_PENSION_EMPLEADOR', 'Pensión a cargo del empleador', 'seguridad_social', 'porcentaje', '0.12', '', 'Ley 100 de 1993'),
  P('PCT_CCF', 'Caja de compensación', 'seguridad_social', 'porcentaje', '0.04', ''),
  P('PCT_ICBF', 'ICBF', 'seguridad_social', 'porcentaje', '0.03', ''),
  P('PCT_SENA', 'SENA', 'seguridad_social', 'porcentaje', '0.02', ''),
  P('EXONERACION_TOPE_SMMLV', 'Tope de exoneración de aportes (en salarios mínimos)', 'seguridad_social', 'numero', '10', 'Por debajo de este salario no se pagan salud del empleador, ICBF ni SENA si la empresa está exonerada.', 'ET art. 114-1'),
  P('IBC_MIN_SMMLV', 'IBC mínimo (en salarios mínimos)', 'seguridad_social', 'numero', '1', '', 'Ley 100 de 1993'),
  P('IBC_MAX_SMMLV', 'IBC máximo (en salarios mínimos)', 'seguridad_social', 'numero', '25', '', 'Ley 100 de 1993'),
  P('PCT_LIMITE_NO_SALARIAL', 'Límite de pagos no salariales', 'seguridad_social', 'porcentaje', '0.40', 'Lo que exceda este porcentaje del total se suma al IBC.', 'Ley 1393 de 2010 art. 30'),
  P('PCT_IBC_INTEGRAL', 'Porcentaje del salario integral que es IBC', 'seguridad_social', 'porcentaje', '0.70', '', 'CST art. 132'),

  // Prestaciones
  P('PCT_PROV_CESANTIAS', 'Provisión mensual de cesantías', 'prestaciones', 'porcentaje', '0.0833333333', 'Un mes de salario por año (1/12).', 'CST art. 249'),
  P('PCT_INTERESES_CESANTIAS', 'Intereses sobre cesantías (anual)', 'prestaciones', 'porcentaje', '0.12', '', 'Ley 52 de 1975'),
  P('PCT_PROV_PRIMA', 'Provisión mensual de prima', 'prestaciones', 'porcentaje', '0.0833333333', '30 días por año (1/12).', 'CST art. 306'),
  P('PCT_PROV_VACACIONES', 'Provisión mensual de vacaciones', 'prestaciones', 'porcentaje', '0.0416666667', '15 días por año (1/24).', 'CST art. 186'),
  P('DIAS_VACACIONES_ANIO', 'Días hábiles de vacaciones por año', 'prestaciones', 'dias', '15', '', 'CST art. 186'),
  P('MAX_PCT_VACACIONES_DINERO', 'Máximo de vacaciones pagadas en dinero', 'prestaciones', 'porcentaje', '0.5', '', 'CST art. 189'),
  P('MESES_VARIACION_PROMEDIO', 'Meses sin cambio de salario para usar el último', 'prestaciones', 'numero', '3', 'Si el salario cambió en estos meses, la base es el promedio.', 'CST art. 253'),
  P('PAGA_AUX_EN_VACACIONES', 'Pagar auxilio de transporte en vacaciones', 'salario', 'booleano', '0', '1 = sí, 0 = no.'),
  P('PAGA_AUX_EN_INCAPACIDAD', 'Pagar auxilio de transporte en incapacidad', 'salario', 'booleano', '0', '1 = sí, 0 = no.'),

  // Incapacidades
  P('INCAP_MIN_SMMLV', 'Incapacidad no menor al salario mínimo diario', 'incapacidades', 'booleano', '1', '1 = sí, 0 = no.', 'Corte Constitucional C-543 de 2007'),
  P('EMPRESA_COMPLETA_INCAPACIDAD', 'La empresa completa el 100% en incapacidades', 'incapacidades', 'booleano', '0', 'Si es 1, la empresa paga la diferencia hasta el salario completo.'),
  P('PCT_INCAP_LABORAL', 'Porcentaje de la incapacidad laboral', 'incapacidades', 'porcentaje', '1', '', 'Ley 1562 de 2012'),
  P('PCT_LICENCIA_EPS', 'Porcentaje de licencias de maternidad y paternidad', 'incapacidades', 'porcentaje', '1', '', 'CST art. 236'),
  P('SEMANAS_LICENCIA_MATERNIDAD', 'Semanas de licencia de maternidad', 'incapacidades', 'numero', '18', '', 'CST art. 236'),
  P('SEMANAS_LICENCIA_PATERNIDAD', 'Semanas de licencia de paternidad', 'incapacidades', 'numero', '2', 'Se amplía si baja el desempleo estructural.', 'CST art. 236 parágrafo 2'),
  P('AUSENCIA_PIERDE_DOMINICAL', 'La ausencia injustificada descuenta el dominical', 'incapacidades', 'booleano', '0', '1 = sí, 0 = no.', 'CST art. 173'),

  // Retención
  P('RET_PCT_EXENTA', 'Renta exenta laboral', 'retencion', 'porcentaje', '0.25', '', 'ET art. 206 num. 10'),
  P('RET_TOPE_EXENTA_UVT_ANUAL', 'Tope anual de la renta exenta (UVT)', 'retencion', 'numero', '790', '', 'ET art. 206 num. 10'),
  P('RET_LIMITE_PCT', 'Límite global de beneficios', 'retencion', 'porcentaje', '0.40', '', 'ET art. 336'),
  P('RET_LIMITE_UVT_ANUAL', 'Tope anual del límite global (UVT)', 'retencion', 'numero', '1340', '', 'ET art. 336'),
  P('RET_DEPENDIENTES_PCT', 'Deducción por dependientes', 'retencion', 'porcentaje', '0.10', '', 'ET art. 387'),
  P('RET_DEPENDIENTES_TOPE_UVT', 'Tope mensual por dependientes (UVT)', 'retencion', 'numero', '32', '', 'ET art. 387'),
  P('RET_VIVIENDA_TOPE_UVT', 'Tope mensual de intereses de vivienda (UVT)', 'retencion', 'numero', '100', '', 'ET art. 119'),
  P('RET_PREPAGADA_TOPE_UVT', 'Tope mensual de medicina prepagada (UVT)', 'retencion', 'numero', '16', '', 'ET art. 387'),
  P('RET_DEP_ADICIONAL_UVT_ANUAL', 'Deducción anual por dependiente adicional (UVT)', 'retencion', 'numero', '72', '', 'ET art. 336 (Ley 2277 de 2022)'),
  P('RETENCION_SOLO_CIERRE_MES', 'Calcular la retención solo en el periodo que cierra el mes', 'retencion', 'booleano', '1', 'En nóminas quincenales la retención se calcula sobre el mes completo.'),

  // Descuentos
  P('EMBARGO_FRACCION_EXCEDENTE', 'Fracción embargable del excedente del mínimo', 'descuentos', 'porcentaje', '0.2', 'Una quinta parte.', 'CST art. 155'),
  P('EMBARGO_PCT_ALIMENTOS', 'Máximo embargable por alimentos o cooperativas', 'descuentos', 'porcentaje', '0.5', '', 'CST art. 156'),
  P('PROTEGER_MINIMO', 'Los descuentos voluntarios no afectan el salario mínimo', 'descuentos', 'booleano', '1', '1 = sí, 0 = no.', 'CST art. 149'),

  // Aprendices
  P('APRENDIZ_PCT_LECTIVA', 'Apoyo de sostenimiento en fase lectiva', 'aprendices', 'porcentaje', '0.75', '', 'CST art. 81'),
  P('APRENDIZ_PCT_PRACTICA', 'Apoyo de sostenimiento en fase práctica', 'aprendices', 'porcentaje', '1', '', 'CST art. 81'),
  P('APRENDIZ_PCT_UNIVERSITARIO', 'Apoyo mínimo para aprendiz universitario', 'aprendices', 'porcentaje', '1', '', 'CST art. 81'),

  // Retiro
  P('INDEM_TOPE_SMMLV', 'Tope que separa las tablas de indemnización (SMMLV)', 'retiro', 'numero', '10', '', 'CST art. 64'),
  P('INDEM_DIAS_PRIMER_ANIO_MENOR', 'Días por el primer año (menos del tope)', 'retiro', 'dias', '30', '', 'CST art. 64'),
  P('INDEM_DIAS_ADICIONAL_MENOR', 'Días por año adicional (menos del tope)', 'retiro', 'dias', '20', '', 'CST art. 64'),
  P('INDEM_DIAS_PRIMER_ANIO_MAYOR', 'Días por el primer año (tope o más)', 'retiro', 'dias', '20', '', 'CST art. 64'),
  P('INDEM_DIAS_ADICIONAL_MAYOR', 'Días por año adicional (tope o más)', 'retiro', 'dias', '15', '', 'CST art. 64'),
  P('INDEM_MIN_DIAS_OBRA', 'Mínimo de días en obra o labor', 'retiro', 'dias', '15', '', 'CST art. 64'),
  P('TASA_MORATORIA_MENSUAL', 'Tasa de interés moratorio mensual (después de 24 meses)', 'retiro', 'porcentaje', '0.02', 'Ajústela a la tasa certificada por la Superfinanciera.', 'CST art. 65'),
];

export interface FilaTabla {
  desde: string;
  hasta: string | null;
  valores: Record<string, string>;
}

export interface TablaCatalogo {
  codigo: string;
  nombre: string;
  descripcion: string;
  columnas: string[];
  filas: FilaTabla[];
}

export const TABLAS: TablaCatalogo[] = [
  {
    codigo: 'FSP',
    nombre: 'Fondo de Solidaridad Pensional',
    descripcion: 'Porcentaje según el IBC en salarios mínimos (desde incluido, hasta excluido).',
    columnas: ['valor'],
    filas: [
      { desde: '0', hasta: '4', valores: { valor: '0' } },
      { desde: '4', hasta: '16', valores: { valor: '0.01' } },
      { desde: '16', hasta: '17', valores: { valor: '0.012' } },
      { desde: '17', hasta: '18', valores: { valor: '0.014' } },
      { desde: '18', hasta: '19', valores: { valor: '0.016' } },
      { desde: '19', hasta: '20', valores: { valor: '0.018' } },
      { desde: '20', hasta: null, valores: { valor: '0.02' } },
    ],
  },
  {
    codigo: 'ARL',
    nombre: 'Tarifas de riesgos laborales',
    descripcion: 'Tarifa de ARL por clase de riesgo (I a V).',
    columnas: ['valor'],
    filas: [
      { desde: '1', hasta: '2', valores: { valor: '0.00522' } },
      { desde: '2', hasta: '3', valores: { valor: '0.01044' } },
      { desde: '3', hasta: '4', valores: { valor: '0.02436' } },
      { desde: '4', hasta: '5', valores: { valor: '0.0435' } },
      { desde: '5', hasta: '6', valores: { valor: '0.0696' } },
    ],
  },
  {
    codigo: 'INCAPACIDAD_EG',
    nombre: 'Incapacidad por enfermedad general',
    descripcion: 'Por día de incapacidad: porcentaje del salario y quién paga (1 = empleador, 2 = EPS, 3 = fondo de pensiones).',
    columnas: ['pct', 'pagador'],
    filas: [
      { desde: '1', hasta: '3', valores: { pct: '0.6667', pagador: '1' } },
      { desde: '3', hasta: '91', valores: { pct: '0.6667', pagador: '2' } },
      { desde: '91', hasta: '181', valores: { pct: '0.5', pagador: '2' } },
      { desde: '181', hasta: '541', valores: { pct: '0.5', pagador: '3' } },
      { desde: '541', hasta: null, valores: { pct: '0.5', pagador: '2' } },
    ],
  },
  {
    codigo: 'RETENCION_383',
    nombre: 'Tabla de retención en la fuente (art. 383 ET)',
    descripcion: 'Rangos en UVT: impuesto = (base − resta) × tarifa + suma.',
    columnas: ['tarifa', 'resta_uvt', 'suma_uvt'],
    filas: [
      { desde: '0', hasta: '95', valores: { tarifa: '0', resta_uvt: '0', suma_uvt: '0' } },
      { desde: '95', hasta: '150', valores: { tarifa: '0.19', resta_uvt: '95', suma_uvt: '0' } },
      { desde: '150', hasta: '360', valores: { tarifa: '0.28', resta_uvt: '150', suma_uvt: '10' } },
      { desde: '360', hasta: '640', valores: { tarifa: '0.33', resta_uvt: '360', suma_uvt: '69' } },
      { desde: '640', hasta: '945', valores: { tarifa: '0.35', resta_uvt: '640', suma_uvt: '162' } },
      { desde: '945', hasta: '2300', valores: { tarifa: '0.37', resta_uvt: '945', suma_uvt: '268' } },
      { desde: '2300', hasta: null, valores: { tarifa: '0.39', resta_uvt: '2300', suma_uvt: '770' } },
    ],
  },
];

export type TipoConcepto = 'devengo' | 'deduccion' | 'aporte_empleador' | 'provision';
export type CategoriaDeduccion = 'ley' | 'retencion' | 'embargo' | 'libranza' | 'otra';

export interface ConceptoCatalogo {
  codigo: string;
  nombre: string;
  tipo: TipoConcepto;
  formula: string;
  descripcion?: string;
  /** Es salario (CST art. 127). */
  salarial: boolean;
  /** Entra al IBC de salud y pensión. */
  baseIbc: boolean;
  /** Entra al IBC de riesgos laborales. */
  baseArl: boolean;
  /** Entra a la base de caja, ICBF y SENA. */
  baseParafiscales: boolean;
  /** Suma para la base de cesantías y prima. */
  basePrestaciones: boolean;
  /** Suma para la base de vacaciones. */
  baseVacaciones: boolean;
  /** Es ingreso gravable para retención en la fuente. */
  baseRetencion: boolean;
  /** Cuenta en la regla del 40% de pagos no salariales. */
  cuenta40: boolean;
  /** Se evalúa por tramos de vigencia de los parámetros (horas). */
  porHoras?: boolean;
  /** Solo aparece si hay una novedad registrada para el concepto. */
  requiereNovedad?: boolean;
  categoria?: CategoriaDeduccion;
  orden: number;
  redondeo?: 'ninguno' | 'peso' | 'peso_arriba' | 'centena' | 'centena_arriba' | 'mil';
  esLegal: boolean;
  baseLegal?: string;
  cuentaDebito?: string;
  cuentaCredito?: string;
}

const flags = (f: Partial<ConceptoCatalogo>) => ({
  salarial: false,
  baseIbc: false,
  baseArl: false,
  baseParafiscales: false,
  basePrestaciones: false,
  baseVacaciones: false,
  baseRetencion: false,
  cuenta40: false,
  ...f,
});

const SALARIAL_COMPLETO = {
  salarial: true,
  baseIbc: true,
  baseArl: true,
  baseParafiscales: true,
  basePrestaciones: true,
  baseVacaciones: true,
  baseRetencion: true,
};
const HORA = { ...SALARIAL_COMPLETO, baseVacaciones: false, porHoras: true };

export const CONCEPTOS: ConceptoCatalogo[] = [
  // --- Devengos ---
  { codigo: 'SALARIO_BASICO', nombre: 'Salario básico', tipo: 'devengo', formula: 'SI(O(ES_INTEGRAL; ES_APRENDIZ); 0; SUELDO_PROPORCIONAL)', ...flags(SALARIAL_COMPLETO), orden: 10, esLegal: true, baseLegal: 'CST art. 127', cuentaDebito: '510506', cuentaCredito: '250505' },
  { codigo: 'SALARIO_INTEGRAL', nombre: 'Salario integral', tipo: 'devengo', formula: 'SI(ES_INTEGRAL; SUELDO_PROPORCIONAL; 0)', ...flags({ ...SALARIAL_COMPLETO, basePrestaciones: false }), orden: 11, esLegal: true, baseLegal: 'CST art. 132', cuentaDebito: '510503', cuentaCredito: '250505' },
  { codigo: 'APOYO_SOSTENIMIENTO', nombre: 'Apoyo de sostenimiento (aprendiz)', tipo: 'devengo', formula: 'SI(ES_APRENDIZ; SUELDO_PROPORCIONAL; 0)', ...flags({ salarial: true, basePrestaciones: true, baseVacaciones: true }), orden: 12, esLegal: true, baseLegal: 'CST art. 81', cuentaDebito: '510527', cuentaCredito: '250505' },
  { codigo: 'AUXILIO_TRANSPORTE', nombre: 'Auxilio de transporte', tipo: 'devengo', formula: 'SI(Y(TIENE_AUXILIO; SALARIO <= TOPE_AUX_TRANSPORTE_SMMLV * SMMLV); AUX_TRANSPORTE / DIAS_MES * DIAS_AUXILIO; 0)', ...flags({ basePrestaciones: true }), orden: 20, esLegal: true, baseLegal: 'Ley 15 de 1959', cuentaDebito: '510527', cuentaCredito: '250505' },
  { codigo: 'HON', nombre: 'Recargo nocturno', tipo: 'devengo', formula: 'VALOR_HORA * HORAS_HON * RECARGO_HON', ...flags(HORA), orden: 30, esLegal: true, baseLegal: 'CST art. 168', cuentaDebito: '510518', cuentaCredito: '250505' },
  { codigo: 'HED', nombre: 'Horas extra diurnas', tipo: 'devengo', formula: 'VALOR_HORA * HORAS_HED * (1 + RECARGO_HED)', ...flags(HORA), orden: 31, esLegal: true, baseLegal: 'CST art. 168', cuentaDebito: '510515', cuentaCredito: '250505' },
  { codigo: 'HEN', nombre: 'Horas extra nocturnas', tipo: 'devengo', formula: 'VALOR_HORA * HORAS_HEN * (1 + RECARGO_HEN)', ...flags(HORA), orden: 32, esLegal: true, baseLegal: 'CST art. 168', cuentaDebito: '510515', cuentaCredito: '250505' },
  { codigo: 'HDD', nombre: 'Trabajo en día de descanso o festivo', tipo: 'devengo', formula: 'VALOR_HORA * HORAS_HDD * (1 + RECARGO_DESCANSO)', ...flags(HORA), orden: 33, esLegal: true, baseLegal: 'CST art. 179', cuentaDebito: '510518', cuentaCredito: '250505' },
  { codigo: 'HDN', nombre: 'Nocturno en día de descanso o festivo', tipo: 'devengo', formula: 'VALOR_HORA * HORAS_HDN * (1 + RECARGO_DESCANSO + RECARGO_HON)', ...flags(HORA), orden: 34, esLegal: true, baseLegal: 'CST arts. 168 y 179', cuentaDebito: '510518', cuentaCredito: '250505' },
  { codigo: 'HEDD', nombre: 'Extra diurna en día de descanso o festivo', tipo: 'devengo', formula: 'VALOR_HORA * HORAS_HEDD * (1 + RECARGO_DESCANSO + RECARGO_HED)', ...flags(HORA), orden: 35, esLegal: true, baseLegal: 'CST arts. 168 y 179', cuentaDebito: '510515', cuentaCredito: '250505' },
  { codigo: 'HEND', nombre: 'Extra nocturna en día de descanso o festivo', tipo: 'devengo', formula: 'VALOR_HORA * HORAS_HEND * (1 + RECARGO_DESCANSO + RECARGO_HEN)', ...flags(HORA), orden: 36, esLegal: true, baseLegal: 'CST arts. 168 y 179', cuentaDebito: '510515', cuentaCredito: '250505' },
  { codigo: 'INCAPACIDAD_EMPLEADOR', nombre: 'Incapacidad (a cargo del empleador)', tipo: 'devengo', formula: 'VALOR_INCAP_EMPLEADOR', ...flags({ baseIbc: true, baseRetencion: true }), orden: 40, esLegal: true, baseLegal: 'Decreto 1427 de 2022', cuentaDebito: '510506', cuentaCredito: '250505' },
  { codigo: 'INCAPACIDAD_EPS', nombre: 'Incapacidad (a cargo de la EPS)', tipo: 'devengo', formula: 'VALOR_INCAP_EPS', ...flags({ baseIbc: true, baseRetencion: true }), orden: 41, esLegal: true, baseLegal: 'Ley 100 de 1993', cuentaDebito: '138025', cuentaCredito: '250505' },
  { codigo: 'INCAPACIDAD_AFP', nombre: 'Incapacidad (a cargo del fondo de pensiones)', tipo: 'devengo', formula: 'VALOR_INCAP_AFP', ...flags({ baseIbc: true, baseRetencion: true }), orden: 42, esLegal: true, baseLegal: 'Ley 100 de 1993', cuentaDebito: '138025', cuentaCredito: '250505' },
  { codigo: 'INCAPACIDAD_LABORAL', nombre: 'Incapacidad laboral (a cargo de la ARL)', tipo: 'devengo', formula: 'VALOR_INCAP_ARL', ...flags({ baseIbc: true, baseRetencion: true }), orden: 43, esLegal: true, baseLegal: 'Ley 1562 de 2012', cuentaDebito: '138025', cuentaCredito: '250505' },
  { codigo: 'COMPLEMENTO_INCAPACIDAD', nombre: 'Complemento de incapacidad (empresa)', tipo: 'devengo', formula: 'VALOR_COMPLEMENTO_INCAP', ...flags({ baseRetencion: true }), orden: 44, esLegal: false, cuentaDebito: '510506', cuentaCredito: '250505' },
  { codigo: 'LICENCIA_EPS', nombre: 'Licencia de maternidad o paternidad', tipo: 'devengo', formula: 'VALOR_LICENCIA_EPS', ...flags({ baseIbc: true, baseRetencion: true }), orden: 45, esLegal: true, baseLegal: 'CST art. 236', cuentaDebito: '138025', cuentaCredito: '250505' },
  { codigo: 'VACACIONES_DISFRUTADAS', nombre: 'Vacaciones disfrutadas', tipo: 'devengo', formula: 'VALOR_VACACIONES', ...flags({ salarial: true, baseIbc: true, baseParafiscales: true, baseRetencion: true }), orden: 50, esLegal: true, baseLegal: 'CST art. 192', cuentaDebito: '510539', cuentaCredito: '250505' },
  { codigo: 'VACACIONES_COMPENSADAS', nombre: 'Vacaciones compensadas en dinero', tipo: 'devengo', formula: 'BASE_VACACIONES / DIAS_MES * CANTIDAD_NOVEDAD', ...flags({ baseRetencion: true }), requiereNovedad: true, orden: 51, esLegal: true, baseLegal: 'CST art. 189', cuentaDebito: '510539', cuentaCredito: '250505' },
  { codigo: 'COMISIONES', nombre: 'Comisiones', tipo: 'devengo', formula: 'VALOR_NOVEDAD', ...flags(SALARIAL_COMPLETO), requiereNovedad: true, orden: 60, esLegal: false, cuentaDebito: '510512', cuentaCredito: '250505' },
  { codigo: 'BONIFICACION_SALARIAL', nombre: 'Bonificación salarial', tipo: 'devengo', formula: 'VALOR_NOVEDAD', ...flags(SALARIAL_COMPLETO), requiereNovedad: true, orden: 61, esLegal: false, cuentaDebito: '510548', cuentaCredito: '250505' },
  { codigo: 'BONIFICACION_NO_SALARIAL', nombre: 'Bonificación no salarial', tipo: 'devengo', formula: 'VALOR_NOVEDAD', ...flags({ baseRetencion: true, cuenta40: true }), requiereNovedad: true, orden: 62, esLegal: false, baseLegal: 'CST art. 128', cuentaDebito: '510548', cuentaCredito: '250505' },
  { codigo: 'AUXILIO_NO_SALARIAL', nombre: 'Auxilio no salarial', tipo: 'devengo', formula: 'VALOR_NOVEDAD', ...flags({ baseRetencion: true, cuenta40: true }), requiereNovedad: true, orden: 63, esLegal: false, baseLegal: 'CST art. 128', cuentaDebito: '510551', cuentaCredito: '250505' },
  { codigo: 'RETROACTIVO', nombre: 'Retroactivo salarial', tipo: 'devengo', formula: 'VALOR_NOVEDAD', ...flags(SALARIAL_COMPLETO), requiereNovedad: true, orden: 64, esLegal: false, cuentaDebito: '510506', cuentaCredito: '250505' },
  { codigo: 'PRIMA_SERVICIOS', nombre: 'Prima de servicios', tipo: 'devengo', formula: 'VALOR_NOVEDAD', ...flags({ baseRetencion: true }), requiereNovedad: true, orden: 70, esLegal: true, baseLegal: 'CST art. 306', cuentaDebito: '261020', cuentaCredito: '250505' },
  { codigo: 'CESANTIAS', nombre: 'Cesantías pagadas al empleado', tipo: 'devengo', formula: 'VALOR_NOVEDAD', ...flags({}), requiereNovedad: true, orden: 71, esLegal: true, baseLegal: 'CST art. 249', cuentaDebito: '261005', cuentaCredito: '250505' },
  { codigo: 'INTERESES_CESANTIAS', nombre: 'Intereses sobre cesantías', tipo: 'devengo', formula: 'VALOR_NOVEDAD', ...flags({ baseRetencion: true }), requiereNovedad: true, orden: 72, esLegal: true, baseLegal: 'Ley 52 de 1975', cuentaDebito: '261010', cuentaCredito: '250505' },
  { codigo: 'INDEMNIZACION', nombre: 'Indemnización por despido', tipo: 'devengo', formula: 'VALOR_NOVEDAD', ...flags({}), requiereNovedad: true, orden: 73, esLegal: true, baseLegal: 'CST art. 64', cuentaDebito: '510560', cuentaCredito: '250505' },

  // --- Deducciones ---
  { codigo: 'SALUD_EMPLEADO', nombre: 'Salud', tipo: 'deduccion', categoria: 'ley', formula: 'SI(ES_APRENDIZ_LECTIVA; 0; IBC_SALUD * PCT_SALUD_EMPLEADO)', ...flags({}), orden: 100, esLegal: true, baseLegal: 'Ley 100 de 1993', cuentaDebito: '250505', cuentaCredito: '237005' },
  { codigo: 'PENSION_EMPLEADO', nombre: 'Pensión', tipo: 'deduccion', categoria: 'ley', formula: 'SI(O(ES_PENSIONADO; ES_APRENDIZ_LECTIVA); 0; IBC_PENSION * PCT_PENSION_EMPLEADO)', ...flags({}), orden: 101, esLegal: true, baseLegal: 'Ley 100 de 1993', cuentaDebito: '250505', cuentaCredito: '238030' },
  { codigo: 'FONDO_SOLIDARIDAD', nombre: 'Fondo de Solidaridad Pensional', tipo: 'deduccion', categoria: 'ley', formula: "SI(O(ES_PENSIONADO; ES_APRENDIZ_LECTIVA); 0; IBC_PENSION * TABLA('FSP'; IBC_MENSUAL / SMMLV))", ...flags({}), orden: 102, esLegal: true, baseLegal: 'Ley 100 de 1993 art. 27', cuentaDebito: '250505', cuentaCredito: '238030' },
  { codigo: 'RETENCION_FUENTE', nombre: 'Retención en la fuente', tipo: 'deduccion', categoria: 'retencion', formula: 'RETENCION_CALCULADA', ...flags({}), orden: 110, esLegal: true, baseLegal: 'ET art. 383', cuentaDebito: '250505', cuentaCredito: '236505' },
  { codigo: 'APORTE_VOLUNTARIO', nombre: 'Aporte voluntario a pensión o AFC', tipo: 'deduccion', categoria: 'otra', formula: 'APORTES_VOLUNTARIOS', ...flags({}), orden: 120, esLegal: false, cuentaDebito: '250505', cuentaCredito: '238030' },
  { codigo: 'DESCUENTO', nombre: 'Otros descuentos', tipo: 'deduccion', categoria: 'otra', formula: 'VALOR_NOVEDAD', ...flags({}), requiereNovedad: true, orden: 130, esLegal: false, cuentaDebito: '250505', cuentaCredito: '238095' },

  // --- Aportes del empleador ---
  { codigo: 'SALUD_EMPLEADOR', nombre: 'Salud (empleador)', tipo: 'aporte_empleador', formula: 'SI(ES_APRENDIZ_LECTIVA; IBC_SALUD * (PCT_SALUD_EMPLEADOR + PCT_SALUD_EMPLEADO); SI(EXONERADO; 0; IBC_SALUD * PCT_SALUD_EMPLEADOR))', ...flags({}), orden: 200, esLegal: true, baseLegal: 'Ley 100 de 1993; ET art. 114-1', cuentaDebito: '510569', cuentaCredito: '237005' },
  { codigo: 'PENSION_EMPLEADOR', nombre: 'Pensión (empleador)', tipo: 'aporte_empleador', formula: 'SI(O(ES_PENSIONADO; ES_APRENDIZ_LECTIVA); 0; IBC_PENSION * PCT_PENSION_EMPLEADOR)', ...flags({}), orden: 201, esLegal: true, baseLegal: 'Ley 100 de 1993', cuentaDebito: '510570', cuentaCredito: '238030' },
  { codigo: 'ARL', nombre: 'Riesgos laborales (ARL)', tipo: 'aporte_empleador', formula: "IBC_ARL * TABLA('ARL'; CLASE_RIESGO)", ...flags({}), orden: 202, esLegal: true, baseLegal: 'Decreto 1072 de 2015', cuentaDebito: '510568', cuentaCredito: '237006' },
  { codigo: 'CAJA_COMPENSACION', nombre: 'Caja de compensación', tipo: 'aporte_empleador', formula: 'SI(ES_APRENDIZ_LECTIVA; 0; IBC_PARAFISCALES * PCT_CCF)', ...flags({}), orden: 203, esLegal: true, baseLegal: 'Ley 21 de 1982', cuentaDebito: '510572', cuentaCredito: '237010' },
  { codigo: 'ICBF', nombre: 'ICBF', tipo: 'aporte_empleador', formula: 'SI(O(EXONERADO; ES_APRENDIZ_LECTIVA); 0; IBC_PARAFISCALES * PCT_ICBF)', ...flags({}), orden: 204, esLegal: true, baseLegal: 'Ley 89 de 1988; ET art. 114-1', cuentaDebito: '510575', cuentaCredito: '237010' },
  { codigo: 'SENA', nombre: 'SENA', tipo: 'aporte_empleador', formula: 'SI(O(EXONERADO; ES_APRENDIZ_LECTIVA); 0; IBC_PARAFISCALES * PCT_SENA)', ...flags({}), orden: 205, esLegal: true, baseLegal: 'Ley 21 de 1982; ET art. 114-1', cuentaDebito: '510578', cuentaCredito: '237010' },

  // --- Provisiones ---
  { codigo: 'PROV_CESANTIAS', nombre: 'Provisión de cesantías', tipo: 'provision', formula: 'BASE_PRESTACIONES * PCT_PROV_CESANTIAS', ...flags({}), orden: 300, esLegal: true, baseLegal: 'CST art. 249', cuentaDebito: '510530', cuentaCredito: '261005' },
  { codigo: 'PROV_INTERESES', nombre: 'Provisión de intereses sobre cesantías', tipo: 'provision', formula: 'PROV_CESANTIAS * PCT_INTERESES_CESANTIAS', ...flags({}), orden: 301, esLegal: true, baseLegal: 'Ley 52 de 1975', cuentaDebito: '510533', cuentaCredito: '261010' },
  { codigo: 'PROV_PRIMA', nombre: 'Provisión de prima de servicios', tipo: 'provision', formula: 'BASE_PRESTACIONES * PCT_PROV_PRIMA', ...flags({}), orden: 302, esLegal: true, baseLegal: 'CST art. 306', cuentaDebito: '510536', cuentaCredito: '261020' },
  { codigo: 'PROV_VACACIONES', nombre: 'Provisión de vacaciones', tipo: 'provision', formula: 'BASE_VACACIONES_PROV * PCT_PROV_VACACIONES', ...flags({}), orden: 303, esLegal: true, baseLegal: 'CST art. 186', cuentaDebito: '510539', cuentaCredito: '261015' },
];

/** Códigos de concepto por tipo de hora. */
export const CONCEPTO_POR_TIPO_HORA = { HON: 'HON', HED: 'HED', HEN: 'HEN', HDD: 'HDD', HDN: 'HDN', HEDD: 'HEDD', HEND: 'HEND' } as const;
