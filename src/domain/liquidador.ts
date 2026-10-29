import { CategoriaParametro, CONCEPTOS, PARAMETROS, TABLAS, TipoParametro } from './catalogo';
import { D, Decimal, redondear, sum } from './decimal';
import { diasComerciales, Fecha, maxFecha, minFecha, sumarDias } from './fechas';
import { TipoHora } from './horas';
import { ContextoNomina, EntradaNomina, HorasAprobadas, liquidarEmpleado, NovedadDias, NovedadValor, ResultadoNomina } from './nomina';
import { ParametrosEnMemoria, TablasEnMemoria, VigenciaParametro } from './parametros';
import { liquidarCesantias, liquidarIntereses, liquidarPrima, liquidarVacaciones, ParamsPrestaciones, PARAMS_PRESTACIONES_POR_DEFECTO, semestreDe } from './prestaciones';
import { CAMBIOS_PUBLICO, CONCEPTOS_PUBLICO, FORMULA_PROV_INTERESES_PUBLICO, PARAMETROS_PUBLICO, VIGENCIAS_PUBLICO } from './regimen-publico';
import { calcularIndemnizacion, TipoContrato } from './retiro';

/**
 * Liquidador independiente: liquida nóminas y prestaciones con los datos que se digitan o se
 * cargan de Excel, sin empleados, asistencia ni configuración de la empresa. Usa el mismo motor
 * con el catálogo legal (privado o público) más los valores que se cambien en la liquidación.
 */

export type TipoLiquidacion = 'nomina' | 'prima' | 'cesantias' | 'vacaciones' | 'retiro';
export type Regimen = 'privado' | 'publico';
export type ClasePrima = 'servicios' | 'navidad';

export const NOMBRE_TIPO: Record<TipoLiquidacion, string> = {
  nomina: 'Nómina',
  prima: 'Prima',
  cesantias: 'Cesantías e intereses',
  vacaciones: 'Vacaciones',
  retiro: 'Liquidación de contrato',
};

export interface CampoLibre {
  clave: string;
  titulo: string;
  tipo: 'texto' | 'numero' | 'dinero' | 'fecha' | 'si_no' | 'opcion';
  tipos: TipoLiquidacion[] | 'todos';
  obligatorio?: boolean;
  opciones?: { valor: string; etiqueta: string }[];
  ayuda?: string;
}

const CONTRATOS = [
  { valor: 'indefinido', etiqueta: 'Indefinido' },
  { valor: 'fijo', etiqueta: 'Término fijo' },
  { valor: 'obra_labor', etiqueta: 'Obra o labor' },
  { valor: 'integral', etiqueta: 'Salario integral' },
  { valor: 'aprendizaje', etiqueta: 'Aprendizaje' },
  { valor: 'tiempo_parcial', etiqueta: 'Tiempo parcial' },
];

/** Columnas de la tabla y de la plantilla de Excel, por tipo de liquidación. */
export const CAMPOS_LIBRES: CampoLibre[] = [
  { clave: 'documento', titulo: 'Documento', tipo: 'texto', tipos: 'todos', obligatorio: true },
  { clave: 'nombre', titulo: 'Nombre completo', tipo: 'texto', tipos: 'todos', obligatorio: true },
  { clave: 'cargo', titulo: 'Cargo', tipo: 'texto', tipos: 'todos' },
  { clave: 'salario', titulo: 'Salario mensual', tipo: 'dinero', tipos: 'todos', obligatorio: true },
  { clave: 'tipo_contrato', titulo: 'Tipo de contrato', tipo: 'opcion', tipos: 'todos', opciones: CONTRATOS, ayuda: 'Por defecto: indefinido' },
  { clave: 'fecha_ingreso', titulo: 'Fecha de ingreso', tipo: 'fecha', tipos: 'todos', ayuda: 'Necesaria para prestaciones, vacaciones y retiro' },
  { clave: 'clase_riesgo', titulo: 'Clase de riesgo ARL', tipo: 'numero', tipos: ['nomina'], ayuda: '1 a 5. Por defecto: 1' },
  {
    clave: 'auxilio',
    titulo: 'Auxilio de transporte',
    tipo: 'opcion',
    tipos: ['nomina', 'prima', 'cesantias', 'retiro'],
    opciones: [
      { valor: 'ley', etiqueta: 'Según la ley' },
      { valor: 'siempre', etiqueta: 'Siempre' },
      { valor: 'nunca', etiqueta: 'Nunca' },
    ],
  },
  { clave: 'pensionado', titulo: 'Pensionado', tipo: 'si_no', tipos: ['nomina'] },
  { clave: 'cesantias_fna', titulo: 'Cesantías en el FNA', tipo: 'si_no', tipos: ['nomina', 'cesantias', 'retiro'], ayuda: 'Fondo Nacional del Ahorro: en el sector público el FNA paga los intereses' },
  // Nómina
  { clave: 'dias_incapacidad', titulo: 'Días de incapacidad', tipo: 'numero', tipos: ['nomina'], ayuda: 'Enfermedad general' },
  { clave: 'dias_incapacidad_laboral', titulo: 'Días de incapacidad laboral', tipo: 'numero', tipos: ['nomina'], ayuda: 'Accidente o enfermedad de trabajo' },
  { clave: 'dias_vacaciones', titulo: 'Días de vacaciones en el periodo', tipo: 'numero', tipos: ['nomina'], ayuda: 'Días calendario que estuvo de vacaciones' },
  { clave: 'dias_no_remunerados', titulo: 'Días no remunerados', tipo: 'numero', tipos: ['nomina', 'prima', 'cesantias', 'retiro'], ayuda: 'Licencias no pagadas, suspensiones, ausencias' },
  { clave: 'HED', titulo: 'Horas extra diurnas', tipo: 'numero', tipos: ['nomina'] },
  { clave: 'HEN', titulo: 'Horas extra nocturnas', tipo: 'numero', tipos: ['nomina'] },
  { clave: 'HON', titulo: 'Horas de recargo nocturno', tipo: 'numero', tipos: ['nomina'] },
  { clave: 'HDD', titulo: 'Horas dominicales o festivas', tipo: 'numero', tipos: ['nomina'] },
  { clave: 'HDN', titulo: 'Horas nocturnas dominicales o festivas', tipo: 'numero', tipos: ['nomina'] },
  { clave: 'HEDD', titulo: 'Horas extra diurnas dominicales o festivas', tipo: 'numero', tipos: ['nomina'] },
  { clave: 'HEND', titulo: 'Horas extra nocturnas dominicales o festivas', tipo: 'numero', tipos: ['nomina'] },
  { clave: 'comisiones', titulo: 'Comisiones', tipo: 'dinero', tipos: ['nomina'] },
  { clave: 'bonificacion_salarial', titulo: 'Bonificación salarial', tipo: 'dinero', tipos: ['nomina'] },
  { clave: 'bonificacion_no_salarial', titulo: 'Bonificación no salarial', tipo: 'dinero', tipos: ['nomina'] },
  { clave: 'auxilio_no_salarial', titulo: 'Auxilio no salarial', tipo: 'dinero', tipos: ['nomina'], ayuda: 'Alimentación, rodamiento u otros pagos no salariales' },
  { clave: 'descuentos', titulo: 'Otros descuentos', tipo: 'dinero', tipos: ['nomina', 'retiro'], ayuda: 'Préstamos, libranzas u otros descuentos autorizados' },
  { clave: 'intereses_vivienda', titulo: 'Intereses de vivienda (mes)', tipo: 'dinero', tipos: ['nomina'], ayuda: 'Deducción para retención en la fuente' },
  { clave: 'medicina_prepagada', titulo: 'Medicina prepagada (mes)', tipo: 'dinero', tipos: ['nomina'], ayuda: 'Deducción para retención en la fuente' },
  { clave: 'dependiente', titulo: 'Tiene dependiente', tipo: 'si_no', tipos: ['nomina'], ayuda: 'Deducción del 10 % para retención en la fuente' },
  // Prestaciones
  { clave: 'salario_promedio', titulo: 'Salario promedio', tipo: 'dinero', tipos: ['prima', 'cesantias', 'vacaciones', 'retiro'], ayuda: 'Si el salario es variable. Vacío: se usa el salario mensual' },
  { clave: 'dias_laborados', titulo: 'Días laborados', tipo: 'numero', tipos: ['prima', 'cesantias'], ayuda: 'Vacío: se calculan con la fecha de ingreso y el periodo' },
  { clave: 'ya_pagado', titulo: 'Ya pagado en el periodo', tipo: 'dinero', tipos: ['prima'], ayuda: 'Anticipos de prima que se descuentan' },
  { clave: 'dias_vacaciones_pagar', titulo: 'Días hábiles de vacaciones', tipo: 'numero', tipos: ['vacaciones'], ayuda: 'Por defecto: 15' },
  // Retiro
  { clave: 'fecha_retiro', titulo: 'Fecha de retiro', tipo: 'fecha', tipos: ['retiro'], obligatorio: true },
  { clave: 'sin_justa_causa', titulo: 'Despido sin justa causa', tipo: 'si_no', tipos: ['retiro'], ayuda: 'Calcula la indemnización del CST art. 64' },
  { clave: 'fecha_fin_pactada', titulo: 'Fin pactado del contrato', tipo: 'fecha', tipos: ['retiro'], ayuda: 'Para contratos a término fijo u obra' },
  { clave: 'dias_vacaciones_pendientes', titulo: 'Días de vacaciones pendientes', tipo: 'numero', tipos: ['retiro'], ayuda: 'Vacío: se calculan los del último año de servicio' },
  { clave: 'prima_ya_pagada', titulo: 'Prima ya pagada del semestre', tipo: 'dinero', tipos: ['retiro'] },
];

export const camposDe = (tipo: TipoLiquidacion) => CAMPOS_LIBRES.filter((c) => c.tipos === 'todos' || c.tipos.includes(tipo));

export type EmpleadoLibre = Record<string, string | number | boolean | null | undefined>;

// ---------- Lectura de valores digitados o de Excel ----------

/** "1.750.905", "$ 1.750.905", "1750905,50" o 1750905 → Decimal. */
export function num(v: unknown): Decimal {
  if (v === null || v === undefined || v === '') return D(0);
  if (typeof v === 'number') return D(v);
  let s = String(v).replace(/[$\s]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? D(s) : D(0);
}

export const siNo = (v: unknown) => v === true || /^(s[ií]|x|1|true|verdadero)$/i.test(String(v ?? '').trim());

export function aFecha(v: unknown): Fecha | null {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

const entero = (v: unknown) => Math.max(0, Math.round(num(v).toNumber()));

/** Errores de una fila antes de liquidar (también al cargar el Excel). */
export function validarEmpleado(tipo: TipoLiquidacion, e: EmpleadoLibre): string[] {
  const errores: string[] = [];
  for (const c of camposDe(tipo)) {
    const v = e[c.clave];
    const vacio = v === null || v === undefined || v === '';
    if (c.obligatorio && vacio) errores.push(`Falta ${c.titulo.toLowerCase()}`);
    if (!vacio && c.tipo === 'fecha' && !aFecha(v)) errores.push(`${c.titulo}: use AAAA-MM-DD o DD/MM/AAAA`);
    if (!vacio && c.tipo === 'opcion' && !c.opciones!.some((o) => o.valor === String(v))) errores.push(`${c.titulo}: valor no válido (${c.opciones!.map((o) => o.valor).join(', ')})`);
  }
  if (!e.salario || num(e.salario).lte(0)) errores.push('El salario debe ser mayor que cero');
  if (tipo !== 'nomina' && !aFecha(e.fecha_ingreso)) errores.push('Falta la fecha de ingreso');
  return [...new Set(errores)];
}

// ---------- Parámetros y contexto ----------

export interface ParametroLibre {
  codigo: string;
  nombre: string;
  categoria: CategoriaParametro | 'publico';
  tipo: TipoParametro;
  descripcion: string;
  baseLegal?: string;
  porDefecto: string;
  valor: string;
  modificado: boolean;
}

/** Valores de partida según el régimen, antes de los cambios del usuario. */
function vigenciasBase(regimen: Regimen): VigenciaParametro[] {
  let v: VigenciaParametro[] = PARAMETROS.flatMap((p) => p.vigencias.map((x) => ({ codigo: p.codigo, desde: x.desde, valor: x.valor })));
  if (regimen === 'publico') {
    const cambia = new Set(CAMBIOS_PUBLICO.map((c) => c.codigo));
    v = [...v.filter((x) => !cambia.has(x.codigo)), ...CAMBIOS_PUBLICO.map((c) => ({ codigo: c.codigo, desde: '1900-01-01', valor: c.valor })), ...VIGENCIAS_PUBLICO];
  }
  return v;
}

/** Un valor cambiado en la liquidación rige para todo el periodo. */
export function parametrosLibres(regimen: Regimen, cambios: Record<string, string> = {}): ParametrosEnMemoria {
  const cod = new Set(Object.keys(cambios));
  const base = vigenciasBase(regimen).filter((x) => !cod.has(x.codigo));
  return new ParametrosEnMemoria([...base, ...Object.entries(cambios).map(([codigo, valor]) => ({ codigo, desde: '1900-01-01', valor }))]);
}

export function listaParametros(regimen: Regimen, cambios: Record<string, string>, fecha: Fecha): ParametroLibre[] {
  const defecto = new ParametrosEnMemoria(vigenciasBase(regimen));
  const efectivo = parametrosLibres(regimen, cambios);
  const lista: ParametroLibre[] = PARAMETROS.map((p) => ({
    codigo: p.codigo,
    nombre: p.nombre,
    categoria: p.categoria,
    tipo: p.tipo,
    descripcion: p.descripcion,
    baseLegal: p.baseLegal,
    porDefecto: defecto.valor(p.codigo, fecha)?.toFixed() ?? '0',
    valor: efectivo.valor(p.codigo, fecha)?.toFixed() ?? '0',
    modificado: p.codigo in cambios,
  }));
  if (regimen === 'publico')
    for (const p of PARAMETROS_PUBLICO)
      lista.push({ codigo: p.codigo, nombre: p.nombre, categoria: 'publico', tipo: p.tipo, descripcion: p.descripcion, porDefecto: p.valor, valor: efectivo.valor(p.codigo, fecha)?.toFixed() ?? p.valor, modificado: p.codigo in cambios });
  return lista;
}

export function contextoLibre(regimen: Regimen, cambios: Record<string, string>, exonerada: boolean): ContextoNomina {
  const conceptos = CONCEPTOS.map((c) => ({ ...c }));
  if (regimen === 'publico') {
    const intereses = conceptos.find((c) => c.codigo === 'PROV_INTERESES');
    if (intereses) intereses.formula = FORMULA_PROV_INTERESES_PUBLICO;
    conceptos.push(...CONCEPTOS_PUBLICO.map((c) => ({ ...c })));
  }
  return { conceptos, parametros: parametrosLibres(regimen, cambios), tablas: new TablasEnMemoria(TABLAS), empresa: { exonerada: regimen === 'publico' ? false : exonerada } };
}

// ---------- Liquidación ----------

export interface LineaLibre {
  concepto: string;
  nombre: string;
  tipo: 'devengo' | 'deduccion' | 'aporte_empleador' | 'provision';
  cantidad?: string;
  valor: string;
  detalle: { formula?: string; variables?: Record<string, string>; nota?: string };
}

export type ResultadoLibre = Pick<ResultadoNomina, 'totales' | 'alertas'> & {
  lineas: LineaLibre[];
  bases?: Record<string, string>;
  dias?: Record<string, number>;
  retencion?: ResultadoNomina['retencion'];
  pendientes: ResultadoNomina['pendientes'];
};

export interface OpcionesLiquidacion {
  tipo: TipoLiquidacion;
  regimen: Regimen;
  desde: Fecha;
  hasta: Fecha;
  clasePrima?: ClasePrima;
}

const HORAS: TipoHora[] = ['HED', 'HEN', 'HON', 'HDD', 'HDN', 'HEDD', 'HEND'];

function paramsPrestaciones(ctx: ContextoNomina, f: Fecha): ParamsPrestaciones {
  const p = ctx.parametros;
  return {
    ...PARAMS_PRESTACIONES_POR_DEFECTO,
    diasAnio: p.valor('DIAS_ANIO', f)?.toNumber() ?? 360,
    pctInteresesCesantias: p.valor('PCT_INTERESES_CESANTIAS', f) ?? D('0.12'),
    diasVacacionesPorAnio: p.valor('DIAS_VACACIONES_ANIO', f)?.toNumber() ?? 15,
  };
}

/** Datos comunes de la fila: salario, contrato, ingreso y auxilio de transporte. */
function datosBase(e: EmpleadoLibre, ctx: ContextoNomina, f: Fecha) {
  const salario = num(e.salario);
  const promedio = num(e.salario_promedio).gt(0) ? num(e.salario_promedio) : salario;
  const tipoContrato = (String(e.tipo_contrato || 'indefinido') as TipoContrato) ?? 'indefinido';
  const auxilio = (String(e.auxilio || 'ley') as 'ley' | 'siempre' | 'nunca') ?? 'ley';
  const smmlv = ctx.parametros.valor('SMMLV', f) ?? D(0);
  const tope = (ctx.parametros.valor('TOPE_AUX_TRANSPORTE_SMMLV', f) ?? D(2)).mul(smmlv);
  const conAuxilio = tipoContrato !== 'integral' && auxilio !== 'nunca' && (auxilio === 'siempre' || salario.lte(tope));
  const valorAuxilio = conAuxilio ? (ctx.parametros.valor('AUX_TRANSPORTE', f) ?? D(0)) : D(0);
  return { salario, promedio, tipoContrato, auxilio, smmlv, valorAuxilio, ingreso: aFecha(e.fecha_ingreso), fna: siNo(e.cesantias_fna) };
}

const linea = (concepto: string, nombre: string, valor: Decimal, detalle: LineaLibre['detalle'], cantidad?: number | Decimal, tipo: LineaLibre['tipo'] = 'devengo'): LineaLibre => ({
  concepto,
  nombre,
  tipo,
  valor: valor.toFixed(),
  cantidad: cantidad === undefined ? undefined : D(cantidad).toDecimalPlaces(2).toFixed(),
  detalle,
});

function cerrar(lineas: LineaLibre[], alertas: ResultadoLibre['alertas']): ResultadoLibre {
  const ls = lineas.filter((l) => !D(l.valor).isZero());
  const t = (tipo: string) => sum(ls.filter((l) => l.tipo === tipo).map((l) => l.valor));
  const dev = t('devengo');
  const ded = t('deduccion');
  return {
    lineas: ls,
    totales: { devengos: dev.toFixed(), deducciones: ded.toFixed(), neto: dev.minus(ded).toFixed(), aportesEmpleador: '0', provisiones: '0', costoTotal: dev.toFixed() },
    alertas,
    pendientes: [],
  };
}

const dias360 = (desde: Fecha, hasta: Fecha) => (hasta < desde ? 0 : diasComerciales(desde, hasta));

/** Nómina del periodo con el motor completo (IBC, 40 %, retención, aportes y provisiones). */
function liquidarNomina(o: OpcionesLiquidacion, e: EmpleadoLibre, ctx: ContextoNomina, id: string): ResultadoLibre {
  const b = datosBase(e, ctx, o.hasta);
  const ingreso = b.ingreso ?? o.desde;
  const novedadesDias: NovedadDias[] = [];
  let cursor = maxFecha(o.desde, ingreso);
  for (const [clave, tipo] of [
    ['dias_incapacidad', 'incapacidad_eg'],
    ['dias_incapacidad_laboral', 'incapacidad_laboral'],
    ['dias_vacaciones', 'vacaciones'],
    ['dias_no_remunerados', 'licencia_no_remunerada'],
  ] as const) {
    const n = entero(e[clave]);
    if (!n) continue;
    const hasta = minFecha(sumarDias(cursor, n - 1), o.hasta);
    novedadesDias.push({ tipo, desde: cursor, hasta });
    cursor = sumarDias(hasta, 1);
  }
  const novedadesValor: NovedadValor[] = [
    ['comisiones', 'COMISIONES'],
    ['bonificacion_salarial', 'BONIFICACION_SALARIAL'],
    ['bonificacion_no_salarial', 'BONIFICACION_NO_SALARIAL'],
    ['auxilio_no_salarial', 'AUXILIO_NO_SALARIAL'],
    ['descuentos', 'DESCUENTO'],
  ]
    .filter(([clave]) => num(e[clave]).gt(0))
    .map(([clave, concepto]) => ({ concepto, valor: num(e[clave]).toFixed(), fecha: o.hasta }));
  const horas: HorasAprobadas[] = HORAS.filter((h) => num(e[h]).gt(0)).map((h) => ({ fecha: o.hasta, tipo: h, horas: num(e[h]).toFixed() }));
  const entrada: EntradaNomina = {
    periodo: { desde: o.desde, hasta: o.hasta },
    empleado: {
      id,
      nombre: String(e.nombre ?? ''),
      fechaIngreso: ingreso,
      esPensionado: siNo(e.pensionado),
      cesantiasFna: b.fna,
      claseRiesgo: Math.min(5, Math.max(1, entero(e.clase_riesgo) || 1)),
      procedimientoRetencion: 1,
      tieneDependiente: siNo(e.dependiente),
      interesesVivienda: num(e.intereses_vivienda).toFixed(),
      medicinaPrepagada: num(e.medicina_prepagada).toFixed(),
    },
    contrato: {
      tipo: b.tipoContrato,
      fechaInicio: ingreso,
      historialSalario: [{ desde: ingreso, salario: b.salario.toFixed() }],
      salarioIntegral: b.tipoContrato === 'integral',
      auxilioTransporte: b.auxilio,
    },
    novedadesDias,
    novedadesValor,
    horas,
  };
  const r = liquidarEmpleado(entrada, ctx);
  if (!r) return cerrar([], [{ nivel: 'error', mensaje: 'La fecha de ingreso es posterior al periodo: no hay días para liquidar' }]);
  return { lineas: r.lineas as LineaLibre[], totales: r.totales, alertas: r.alertas, bases: r.bases, dias: r.dias, retencion: r.retencion, pendientes: r.pendientes };
}

function sinPrestaciones(tipoContrato: TipoContrato): string | null {
  if (tipoContrato === 'integral') return 'Salario integral: las prestaciones están incluidas en el salario (CST art. 132)';
  if (tipoContrato === 'aprendizaje') return 'Contrato de aprendizaje: no genera prestaciones sociales';
  return null;
}

function liquidarPrimaLibre(o: OpcionesLiquidacion, e: EmpleadoLibre, ctx: ContextoNomina): ResultadoLibre {
  const b = datosBase(e, ctx, o.hasta);
  const no = sinPrestaciones(b.tipoContrato);
  if (no) return cerrar([], [{ nivel: 'info', mensaje: no }]);
  const ini = maxFecha(o.desde, b.ingreso ?? o.desde);
  const dias = e.dias_laborados ? entero(e.dias_laborados) : Math.max(0, dias360(ini, o.hasta) - entero(e.dias_no_remunerados));
  const base = b.promedio.plus(b.valorAuxilio);
  const vars = { SALARIO: b.promedio.toFixed(), AUXILIO_TRANSPORTE: b.valorAuxilio.toFixed(), BASE: base.toFixed(), DIAS: String(dias) };
  const pagado = num(e.ya_pagado);
  if (o.regimen === 'privado') {
    const pr = liquidarPrima(base, dias, paramsPrestaciones(ctx, o.hasta));
    return cerrar([linea('PRIMA_SERVICIOS', 'Prima de servicios', Decimal.max(pr.valor.minus(pagado), D(0)), { formula: pr.formula, variables: { ...vars, YA_PAGADO: pagado.toFixed() }, nota: 'CST art. 306: 30 días por año, en dos pagos semestrales' }, dias)], []);
  }
  const navidad = o.clasePrima === 'navidad';
  const porAnio = ctx.parametros.valor(navidad ? 'DIAS_PRIMA_NAVIDAD' : 'DIAS_PRIMA_SERVICIOS_PUBLICA', o.hasta) ?? D(navidad ? 30 : 15);
  const valor = redondear(base.div(30).mul(porAnio).mul(dias).div(360), 'peso');
  return cerrar(
    [
      linea(
        navidad ? 'PRIMA_NAVIDAD' : 'PRIMA_SERVICIOS',
        navidad ? 'Prima de navidad' : 'Prima de servicios',
        Decimal.max(valor.minus(pagado), D(0)),
        { formula: `base / 30 × ${porAnio.toFixed()} días × días laborados / 360`, variables: { ...vars, YA_PAGADO: pagado.toFixed() }, nota: navidad ? 'Decreto 1045 de 1978 art. 32' : 'Decreto 2351 de 2014: 15 días por año' },
        dias,
      ),
    ],
    [],
  );
}

function liquidarCesantiasLibre(o: OpcionesLiquidacion, e: EmpleadoLibre, ctx: ContextoNomina): ResultadoLibre {
  const b = datosBase(e, ctx, o.hasta);
  const no = sinPrestaciones(b.tipoContrato);
  if (no) return cerrar([], [{ nivel: 'info', mensaje: no }]);
  const ini = maxFecha(o.desde, b.ingreso ?? o.desde);
  const dias = e.dias_laborados ? entero(e.dias_laborados) : Math.max(0, dias360(ini, o.hasta) - entero(e.dias_no_remunerados));
  const p = paramsPrestaciones(ctx, o.hasta);
  const base = b.promedio.plus(b.valorAuxilio);
  const ces = liquidarCesantias(base, dias, p);
  const int = liquidarIntereses(ces.valor, dias, p);
  const lineas = [linea('CESANTIAS', 'Cesantías (a consignar al fondo)', ces.valor, { formula: ces.formula, variables: { SALARIO: b.promedio.toFixed(), AUXILIO_TRANSPORTE: b.valorAuxilio.toFixed(), BASE: base.toFixed(), DIAS: String(dias) }, nota: 'CST art. 249; se consignan antes del 14 de febrero' }, dias)];
  const alertas: ResultadoLibre['alertas'] = [];
  if (b.fna && o.regimen === 'publico') alertas.push({ nivel: 'info', mensaje: 'Afiliado al Fondo Nacional del Ahorro: el FNA reconoce los intereses' });
  else lineas.push(linea('INTERESES_CESANTIAS', 'Intereses sobre cesantías (al empleado)', int.valor, { formula: int.formula, variables: { CESANTIAS: ces.valor.toFixed(), DIAS: String(dias) }, nota: 'Ley 52 de 1975; se pagan antes del 31 de enero' }, dias));
  return cerrar(lineas, alertas);
}

/** Vacaciones (y en el sector público, prima de vacaciones y bonificación de recreación). */
function lineasVacaciones(o: OpcionesLiquidacion, b: ReturnType<typeof datosBase>, ctx: ContextoNomina, dias: Decimal, compensadas: boolean): LineaLibre[] {
  const p = paramsPrestaciones(ctx, o.hasta);
  const v = liquidarVacaciones(b.promedio, dias, p);
  const vars = { SALARIO: b.promedio.toFixed(), DIAS: dias.toDecimalPlaces(2).toFixed() };
  const ls = [linea(compensadas ? 'VACACIONES_COMPENSADAS' : 'VACACIONES', compensadas ? 'Vacaciones compensadas en dinero' : 'Vacaciones', v.valor, { formula: v.formula, variables: vars, nota: 'CST art. 186 y 192' }, dias)];
  if (o.regimen === 'publico') {
    const diasPrima = ctx.parametros.valor('DIAS_PRIMA_VACACIONES', o.hasta) ?? D(15);
    const diasRec = ctx.parametros.valor('DIAS_BONIF_RECREACION', o.hasta) ?? D(2);
    const proporcion = dias.div(15);
    ls.push(linea('PRIMA_VACACIONES', 'Prima de vacaciones', redondear(b.promedio.div(30).mul(diasPrima).mul(proporcion), 'peso'), { formula: `salario / 30 × ${diasPrima.toFixed()} días × días de vacaciones / 15`, variables: vars, nota: 'Decreto 1045 de 1978 art. 24 y 25' }, dias));
    ls.push(linea('BONIF_RECREACION', 'Bonificación especial de recreación', redondear(b.promedio.div(30).mul(diasRec).mul(proporcion), 'peso'), { formula: `salario / 30 × ${diasRec.toFixed()} días × días de vacaciones / 15`, variables: vars, nota: 'Decreto salarial anual' }, dias));
  }
  return ls;
}

function liquidarVacacionesLibre(o: OpcionesLiquidacion, e: EmpleadoLibre, ctx: ContextoNomina): ResultadoLibre {
  const b = datosBase(e, ctx, o.hasta);
  const dias = num(e.dias_vacaciones_pagar).gt(0) ? num(e.dias_vacaciones_pagar) : D(15);
  return cerrar(lineasVacaciones(o, b, ctx, dias, false), []);
}

/** Último aniversario de ingreso que no pasa de la fecha. */
function ultimoAniversario(ingreso: Fecha, f: Fecha): Fecha {
  let anio = Number(f.slice(0, 4));
  let a = `${anio}${ingreso.slice(4)}`;
  if (a > f) a = `${--anio}${ingreso.slice(4)}`;
  return maxFecha(a, ingreso);
}

function liquidarRetiroLibre(o: OpcionesLiquidacion, e: EmpleadoLibre, ctx: ContextoNomina): ResultadoLibre {
  const b = datosBase(e, ctx, o.hasta);
  const f = aFecha(e.fecha_retiro) ?? o.hasta;
  const ingreso = b.ingreso ?? f;
  const p = paramsPrestaciones(ctx, f);
  const noRem = entero(e.dias_no_remunerados);
  const base = b.promedio.plus(b.valorAuxilio);
  const lineas: LineaLibre[] = [];
  const alertas: ResultadoLibre['alertas'] = [];
  const no = sinPrestaciones(b.tipoContrato);
  if (no) alertas.push({ nivel: 'info', mensaje: no });
  else {
    const iniA = maxFecha(`${f.slice(0, 4)}-01-01`, ingreso);
    const diasA = Math.max(0, dias360(iniA, f) - noRem);
    const ces = liquidarCesantias(base, diasA, p);
    lineas.push(linea('CESANTIAS', 'Cesantías del año', ces.valor, { formula: ces.formula, variables: { BASE: base.toFixed(), DIAS: String(diasA) }, nota: 'Los años anteriores ya debieron consignarse al fondo' }, diasA));
    if (!(b.fna && o.regimen === 'publico')) {
      const int = liquidarIntereses(ces.valor, diasA, p);
      lineas.push(linea('INTERESES_CESANTIAS', 'Intereses sobre cesantías', int.valor, { formula: int.formula, variables: { CESANTIAS: ces.valor.toFixed(), DIAS: String(diasA) } }, diasA));
    }
    const pagada = num(e.prima_ya_pagada);
    if (o.regimen === 'privado') {
      const sem = semestreDe(f);
      const diasS = Math.max(0, dias360(maxFecha(sem.desde, ingreso), f) - noRem);
      const pr = liquidarPrima(base, diasS, p);
      lineas.push(linea('PRIMA_SERVICIOS', 'Prima de servicios proporcional', Decimal.max(pr.valor.minus(pagada), D(0)), { formula: pr.formula, variables: { BASE: base.toFixed(), DIAS: String(diasS), YA_PAGADA: pagada.toFixed() } }, diasS));
    } else {
      // Prima de servicios: año que va de julio a junio. Prima de navidad: año calendario.
      const anio = Number(f.slice(0, 4));
      const iniS = maxFecha(Number(f.slice(5, 7)) >= 7 ? `${anio}-07-01` : `${anio - 1}-07-01`, ingreso);
      const diasS = Math.max(0, dias360(iniS, f) - noRem);
      const porS = ctx.parametros.valor('DIAS_PRIMA_SERVICIOS_PUBLICA', f) ?? D(15);
      const porN = ctx.parametros.valor('DIAS_PRIMA_NAVIDAD', f) ?? D(30);
      lineas.push(linea('PRIMA_SERVICIOS', 'Prima de servicios proporcional', Decimal.max(redondear(base.div(30).mul(porS).mul(diasS).div(360), 'peso').minus(pagada), D(0)), { formula: `base / 30 × ${porS.toFixed()} días × días / 360`, variables: { BASE: base.toFixed(), DIAS: String(diasS) }, nota: 'Decreto 2351 de 2014' }, diasS));
      lineas.push(linea('PRIMA_NAVIDAD', 'Prima de navidad proporcional', redondear(base.div(30).mul(porN).mul(diasA).div(360), 'peso'), { formula: `base / 30 × ${porN.toFixed()} días × días / 360`, variables: { BASE: base.toFixed(), DIAS: String(diasA) }, nota: 'Decreto 1045 de 1978 art. 32' }, diasA));
    }
  }
  const pendientes =
    e.dias_vacaciones_pendientes !== undefined && e.dias_vacaciones_pendientes !== null && e.dias_vacaciones_pendientes !== ''
      ? num(e.dias_vacaciones_pendientes)
      : D(dias360(ultimoAniversario(ingreso, f), f)).mul(p.diasVacacionesPorAnio).div(p.diasAnio).toDecimalPlaces(2);
  if (pendientes.gt(0)) lineas.push(...lineasVacaciones({ ...o, hasta: f }, b, ctx, pendientes, true));
  if (siNo(e.sin_justa_causa)) {
    const pr = (c: string, d: number) => ctx.parametros.valor(c, f)?.toNumber() ?? d;
    const ind = calcularIndemnizacion(
      { tipoContrato: b.tipoContrato === 'integral' ? 'indefinido' : b.tipoContrato, salarioMensual: b.salario, smmlv: b.smmlv, fechaIngreso: ingreso, fechaRetiro: f, fechaFinPactada: aFecha(e.fecha_fin_pactada) },
      { topeSmmlv: pr('INDEM_TOPE_SMMLV', 10), diasPrimerAnioMenor: pr('INDEM_DIAS_PRIMER_ANIO_MENOR', 30), diasAdicionalMenor: pr('INDEM_DIAS_ADICIONAL_MENOR', 20), diasPrimerAnioMayor: pr('INDEM_DIAS_PRIMER_ANIO_MAYOR', 20), diasAdicionalMayor: pr('INDEM_DIAS_ADICIONAL_MAYOR', 15), minimoDiasObraLabor: pr('INDEM_MIN_DIAS_OBRA', 15) },
    );
    lineas.push(linea('INDEMNIZACION', 'Indemnización por despido sin justa causa', ind.valor, { nota: ind.detalle, variables: { SALARIO: b.salario.toFixed(), DIAS: ind.dias.toFixed() } }, ind.dias));
    if (o.regimen === 'publico') alertas.push({ nivel: 'advertencia', mensaje: 'En el sector público la indemnización del CST art. 64 no aplica a empleados de carrera ni de libre nombramiento: revise si corresponde' });
  }
  if (num(e.descuentos).gt(0)) lineas.push(linea('DESCUENTO', 'Descuentos autorizados', num(e.descuentos), { nota: 'Con autorización escrita del trabajador' }, undefined, 'deduccion'));
  alertas.push({ nivel: 'info', mensaje: 'Liquide aparte la nómina de los días trabajados del último periodo' });
  return cerrar(lineas, alertas);
}

export function liquidarLibre(o: OpcionesLiquidacion, e: EmpleadoLibre, ctx: ContextoNomina, id: string): ResultadoLibre {
  switch (o.tipo) {
    case 'nomina':
      return liquidarNomina(o, e, ctx, id);
    case 'prima':
      return liquidarPrimaLibre(o, e, ctx);
    case 'cesantias':
      return liquidarCesantiasLibre(o, e, ctx);
    case 'vacaciones':
      return liquidarVacacionesLibre(o, e, ctx);
    case 'retiro':
      return liquidarRetiroLibre(o, e, ctx);
  }
}
