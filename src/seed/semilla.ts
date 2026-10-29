import { FORMATOS_BANCO, FORMATOS_CONTABLES } from '../domain/archivos';
import { CONCEPTOS, PARAMETROS, TABLAS } from '../domain/catalogo';
import { festivosColombia } from '../domain/festivos';

/**
 * SQL de datos iniciales. Lo usan el script de Supabase y el arranque del backend,
 * así ambos siembran exactamente lo mismo. Todo es idempotente (on conflict do nothing).
 */

export const EMPRESA_INICIAL_ID = '00000000-0000-4000-8000-000000000001';

const q = (v: unknown): string => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
};
const j = (v: unknown) => `${q(JSON.stringify(v))}::jsonb`;

/** Entidades más comunes, solo con el nombre: el NIT y el código se completan en Configuración. */
export const ENTIDADES_INICIALES: Record<string, string[]> = {
  eps: ['Nueva EPS', 'EPS Sura', 'Sanitas EPS', 'Salud Total EPS', 'Compensar EPS', 'Famisanar EPS', 'Coosalud EPS', 'Mutual Ser EPS', 'Aliansalud EPS', 'SOS EPS'],
  afp: ['Colpensiones', 'Porvenir', 'Protección', 'Colfondos', 'Skandia'],
  cesantias: ['Porvenir', 'Protección', 'Colfondos', 'Skandia', 'Fondo Nacional del Ahorro'],
  arl: ['ARL Sura', 'Positiva', 'Colmena Seguros', 'Seguros Bolívar', 'AXA Colpatria', 'La Equidad Seguros'],
  ccf: ['Compensar', 'Colsubsidio', 'Cafam', 'Comfama', 'Comfenalco Antioquia', 'Comfandi', 'Comfenalco Valle', 'Cajacopi', 'Comfacundi', 'Comfamiliar Risaralda', 'Comfenalco Santander', 'Comfaoriente'],
};

export const CONFIGURACION_INICIAL = {
  calendario: { diasLaborales: [1, 2, 3, 4, 5, 6], diaDescanso: 0, sabadoHabilVacaciones: true },
  horas: {
    inicioNocturna: '19:00',
    finNocturna: '06:00',
    horasOrdinariasDiaSinTurno: 8,
    toleranciaMinutos: 5,
    minimoMinutosExtra: 0,
  },
  asistencia: {
    activa: true,
    qrSegundos: 30,
    qrGracia: 5,
    minutosDuplicado: 5,
    permitirExcepcionKiosco: true,
    intentosPin: 3,
    nivelControl: 'medio',
  },
  aprobacion: { pasos: 1, separarLiquidaAprueba: false, umbralVariacion: 0.1 },
  avisos: { diasContratoPorVencer: 45, diasPrima: 10, diasCesantias: 15, correo: false },
  seguridad: { intentosLogin: 5, minutosBloqueo: 15, minutosSesion: 30 },
  vacaciones: { diasPreaviso: 15, maxPeriodosAcumulados: 2 },
  retiro: { diasPreavisoRenuncia: 30, maxAniosFijo: 4 },
  campos: [] as { codigo: string; nombre: string; tipo: 'texto' | 'numero' | 'fecha' }[],
};

export interface OpcionesSemilla {
  empresaId?: string;
  razonSocial?: string;
  nit?: string;
  /** Nombre del espacio: la dirección por la que entra la empresa (jornal360…/<espacio>). */
  espacio?: string;
  usuario: string;
  nombreUsuario: string;
  /** Expresión SQL que produce el hash de la contraseña (p. ej. crypt(...) o un literal). */
  passwordHashSql: string;
  debeCambiarPassword?: boolean;
  aniosFestivos?: number[];
}

export function sqlCatalogo(empresaId: string, aniosFestivos: number[]): string {
  const out: string[] = [];
  for (const p of PARAMETROS) {
    const actual = p.vigencias[p.vigencias.length - 1].valor;
    out.push(
      `insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values (${q(empresaId)}, ${q(p.codigo)}, ${q(p.nombre)}, ${q(p.descripcion)}, ${q(p.categoria)}, ${q(p.tipo)}, ${q(p.baseLegal ?? null)}, ${q(actual)}, ${j(p.vigencias)}) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);`,
    );
    for (const v of p.vigencias)
      out.push(
        `insert into parametros_vigencias (parametro_id, desde, valor) select id, ${q(v.desde)}, ${q(v.valor)} from parametros where empresa_id = ${q(empresaId)} and codigo = ${q(p.codigo)} on conflict (parametro_id, desde) do nothing;`,
      );
  }
  for (const t of TABLAS)
    out.push(
      `insert into tablas_parametro (empresa_id, codigo, nombre, descripcion, columnas, filas, filas_legales) values (${q(empresaId)}, ${q(t.codigo)}, ${q(t.nombre)}, ${q(t.descripcion)}, ${j(t.columnas)}, ${j(t.filas)}, ${j(t.filas)}) on conflict (empresa_id, codigo) do nothing;`,
    );
  for (const c of CONCEPTOS) {
    const legal = { formula: c.formula, salarial: c.salarial, baseIbc: c.baseIbc, baseArl: c.baseArl, baseParafiscales: c.baseParafiscales, basePrestaciones: c.basePrestaciones, baseVacaciones: c.baseVacaciones, baseRetencion: c.baseRetencion, cuenta40: c.cuenta40 };
    out.push(
      `insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values (${[
        q(empresaId),
        q(c.codigo),
        q(c.nombre),
        q(c.descripcion ?? null),
        q(c.tipo),
        q(c.categoria ?? null),
        q(c.formula),
        q(c.salarial),
        q(c.baseIbc),
        q(c.baseArl),
        q(c.baseParafiscales),
        q(c.basePrestaciones),
        q(c.baseVacaciones),
        q(c.baseRetencion),
        q(c.cuenta40),
        q(!!c.porHoras),
        q(!!c.requiereNovedad),
        q(c.orden),
        q(c.redondeo ?? 'peso'),
        q(c.esLegal),
        q(c.baseLegal ?? null),
        q(c.cuentaDebito ?? null),
        q(c.cuentaCredito ?? null),
        q(terceroCredito(c.codigo)),
        c.esLegal ? j(legal) : 'null',
      ].join(', ')}) on conflict (empresa_id, codigo) do nothing;`,
    );
  }
  for (const anio of aniosFestivos)
    for (const f of festivosColombia(anio))
      out.push(`insert into festivos (empresa_id, fecha, nombre) values (${q(empresaId)}, ${q(f.fecha)}, ${q(f.nombre)}) on conflict (empresa_id, fecha) do nothing;`);
  for (const f of FORMATOS_BANCO)
    out.push(`insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values (${q(empresaId)}, 'banco', ${q(f.codigo)}, ${q(f.nombre)}, ${j(f)}) on conflict (empresa_id, clase, codigo) do nothing;`);
  for (const f of FORMATOS_CONTABLES)
    out.push(`insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values (${q(empresaId)}, 'contable', ${q(f.codigo)}, ${q(f.nombre)}, ${j(f)}) on conflict (empresa_id, clase, codigo) do nothing;`);
  return out.join('\n');
}

/** Tercero acreedor por defecto de cada concepto, para la contabilidad. */
export function terceroCredito(codigo: string): string | null {
  const m: Record<string, string> = {
    SALUD_EMPLEADO: 'eps',
    SALUD_EMPLEADOR: 'eps',
    PENSION_EMPLEADO: 'afp',
    PENSION_EMPLEADOR: 'afp',
    FONDO_SOLIDARIDAD: 'afp',
    APORTE_VOLUNTARIO: 'afp',
    ARL: 'arl',
    CAJA_COMPENSACION: 'ccf',
    ICBF: 'icbf',
    SENA: 'sena',
    RETENCION_FUENTE: 'dian',
    PROV_CESANTIAS: 'cesantias',
  };
  return m[codigo] ?? null;
}

export function sqlSemilla(o: OpcionesSemilla): string {
  const id = o.empresaId ?? EMPRESA_INICIAL_ID;
  const anios = o.aniosFestivos ?? [2025, 2026, 2027, 2028];
  return [
    `insert into empresas (id, nit, razon_social, configuracion, espacio) values (${q(id)}, ${q(o.nit ?? '900000000')}, ${q(o.razonSocial ?? 'Mi Empresa S.A.S.')}, ${j(CONFIGURACION_INICIAL)}, ${o.espacio ? q(o.espacio) : 'null'}) on conflict (id) do nothing;`,
    `insert into usuarios (empresa_id, usuario, nombre, password_hash, rol, debe_cambiar_password) select ${q(id)}, ${q(o.usuario)}, ${q(o.nombreUsuario)}, ${o.passwordHashSql}, 'superusuario', ${q(!!o.debeCambiarPassword)} where not exists (select 1 from usuarios where empresa_id = ${q(id)} and lower(usuario) = lower(${q(o.usuario)}));`,
    `insert into sedes (empresa_id, nombre) select ${q(id)}, 'Sede principal' where not exists (select 1 from sedes where empresa_id = ${q(id)});`,
    `insert into centros_costo (empresa_id, codigo, nombre) values (${q(id)}, 'ADM', 'Administración') on conflict (empresa_id, codigo) do nothing;`,
    `insert into grupos_pago (empresa_id, nombre, periodicidad) select ${q(id)}, 'Nómina mensual', 'mensual' where not exists (select 1 from grupos_pago where empresa_id = ${q(id)});`,
    ...Object.entries(ENTIDADES_INICIALES).flatMap(([tipo, nombres]) =>
      nombres.map((n) => `insert into entidades (empresa_id, tipo, nombre) select ${q(id)}, ${q(tipo)}, ${q(n)} where not exists (select 1 from entidades where empresa_id = ${q(id)} and tipo = ${q(tipo)} and nombre = ${q(n)});`),
    ),
    `insert into turnos (empresa_id, nombre, tipo, dias) select ${q(id)}, 'Lunes a viernes (42 horas)', 'fijo', ${j({
      1: [{ inicio: '07:00', fin: '15:24' }],
      2: [{ inicio: '07:00', fin: '15:24' }],
      3: [{ inicio: '07:00', fin: '15:24' }],
      4: [{ inicio: '07:00', fin: '15:24' }],
      5: [{ inicio: '07:00', fin: '15:24' }],
    })} where not exists (select 1 from turnos where empresa_id = ${q(id)});`,
    sqlCatalogo(id, anios),
  ].join('\n');
}
