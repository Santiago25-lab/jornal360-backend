-- =====================================================================
-- Jornal 360 · Script completo para Supabase
-- Pegue todo este archivo en Supabase → SQL Editor → New query → Run.
-- Se puede ejecutar varias veces: no duplica datos.
-- Crea las tablas, el superusuario (Santiago) y el catálogo legal inicial.
-- =====================================================================

-- =====================================================================
-- Jornal 360 · Esquema de base de datos (PostgreSQL / Supabase)
-- Todas las tablas llevan empresa_id para crecer a varias empresas.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Empresa y usuarios ----------

create table if not exists empresas (
  id uuid primary key default gen_random_uuid(),
  nit text not null,
  dv text,
  razon_social text not null,
  tipo_empleador text not null default 'juridica' check (tipo_empleador in ('juridica', 'natural')),
  representante_legal text,
  actividad_economica text,
  exonerada boolean not null default true,
  direccion text,
  ciudad text,
  telefono text,
  correo text,
  banco_pagador text,
  cuenta_pagadora text,
  tipo_cuenta_pagadora text,
  configuracion jsonb not null default '{}'::jsonb,
  asistente_completado boolean not null default false,
  asistente_paso int not null default 0,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);

create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  usuario text not null,
  nombre text not null,
  correo text,
  password_hash text not null,
  rol text not null default 'superusuario' check (rol in ('superusuario', 'analista', 'contador', 'aprobador', 'supervisor')),
  activo boolean not null default true,
  debe_cambiar_password boolean not null default false,
  intentos_fallidos int not null default 0,
  bloqueado_hasta timestamptz,
  ultimo_acceso timestamptz,
  creado_en timestamptz not null default now()
);
create unique index if not exists usuarios_usuario_uq on usuarios (lower(usuario));

create table if not exists auditoria (
  id bigserial primary key,
  empresa_id uuid references empresas(id) on delete cascade,
  usuario_id uuid,
  usuario_nombre text,
  accion text not null,
  entidad text not null,
  entidad_id text,
  antes jsonb,
  despues jsonb,
  motivo text,
  ip text,
  creado_en timestamptz not null default now()
);
create index if not exists auditoria_busqueda_idx on auditoria (empresa_id, entidad, creado_en desc);

-- La auditoría no se puede editar ni borrar (RNF-12).
create or replace function jornal_auditoria_inmutable() returns trigger language plpgsql as $$
begin
  raise exception 'El registro de auditoría no se puede modificar ni borrar';
end $$;
drop trigger if exists auditoria_inmutable on auditoria;
create trigger auditoria_inmutable before update or delete on auditoria
  for each row execute function jornal_auditoria_inmutable();

create table if not exists notificaciones (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  usuario_id uuid references usuarios(id) on delete cascade,
  tipo text not null,
  titulo text not null,
  mensaje text not null,
  enlace text,
  clave text,
  leida boolean not null default false,
  creado_en timestamptz not null default now()
);
create unique index if not exists notificaciones_clave_uq on notificaciones (empresa_id, clave) where clave is not null;

-- ---------- Estructura ----------

create table if not exists sedes (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  nombre text not null,
  direccion text,
  ciudad text,
  clase_riesgo int not null default 1 check (clase_riesgo between 1 and 5),
  calendario jsonb,
  activa boolean not null default true,
  creado_en timestamptz not null default now()
);

create table if not exists centros_costo (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  codigo text not null,
  nombre text not null,
  activo boolean not null default true,
  unique (empresa_id, codigo)
);

create table if not exists areas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  nombre text not null,
  calendario jsonb,
  activa boolean not null default true
);

create table if not exists grupos_pago (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  nombre text not null,
  periodicidad text not null default 'mensual' check (periodicidad in ('mensual', 'quincenal', 'semanal')),
  dias_pago_despues int not null default 0,
  calendario jsonb,
  activo boolean not null default true
);

create table if not exists entidades (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  tipo text not null check (tipo in ('eps', 'afp', 'arl', 'ccf', 'cesantias', 'banco', 'dian', 'otra')),
  nit text,
  nombre text not null,
  codigo text,
  activa boolean not null default true
);
create index if not exists entidades_tipo_idx on entidades (empresa_id, tipo);

-- ---------- Parámetros, tablas y calendario ----------

create table if not exists parametros (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  codigo text not null,
  nombre text not null,
  descripcion text,
  categoria text not null,
  tipo text not null,
  base_legal text,
  valor_legal text,
  unique (empresa_id, codigo)
);

create table if not exists parametros_vigencias (
  id uuid primary key default gen_random_uuid(),
  parametro_id uuid not null references parametros(id) on delete cascade,
  desde date not null,
  valor numeric not null,
  creado_por uuid,
  creado_en timestamptz not null default now(),
  unique (parametro_id, desde)
);

create table if not exists tablas_parametro (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  codigo text not null,
  nombre text not null,
  descripcion text,
  columnas jsonb not null,
  filas jsonb not null,
  filas_legales jsonb,
  unique (empresa_id, codigo)
);

create table if not exists festivos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  fecha date not null,
  nombre text not null,
  unique (empresa_id, fecha)
);

create table if not exists dias_especiales (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  sede_id uuid references sedes(id) on delete cascade,
  fecha date not null,
  tipo text not null check (tipo in ('remunerado', 'compensado', 'no_laborado')),
  descripcion text not null
);

-- ---------- Conceptos ----------

create table if not exists conceptos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  codigo text not null,
  nombre text not null,
  descripcion text,
  tipo text not null check (tipo in ('devengo', 'deduccion', 'aporte_empleador', 'provision')),
  categoria text check (categoria in ('ley', 'retencion', 'embargo', 'libranza', 'otra')),
  formula text not null,
  salarial boolean not null default false,
  base_ibc boolean not null default false,
  base_arl boolean not null default false,
  base_parafiscales boolean not null default false,
  base_prestaciones boolean not null default false,
  base_vacaciones boolean not null default false,
  base_retencion boolean not null default false,
  cuenta40 boolean not null default false,
  por_horas boolean not null default false,
  requiere_novedad boolean not null default false,
  orden int not null default 100,
  redondeo text not null default 'peso',
  es_legal boolean not null default false,
  base_legal text,
  cuenta_debito text,
  cuenta_credito text,
  tercero_credito text,
  aplica_a text not null default 'todos' check (aplica_a in ('todos', 'asignados')),
  estado text not null default 'activo' check (estado in ('activo', 'borrador', 'inactivo')),
  version int not null default 1,
  definicion_legal jsonb,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (empresa_id, codigo)
);

create table if not exists conceptos_versiones (
  id uuid primary key default gen_random_uuid(),
  concepto_id uuid not null references conceptos(id) on delete cascade,
  version int not null,
  datos jsonb not null,
  creado_por uuid,
  creado_por_nombre text,
  creado_en timestamptz not null default now()
);

create table if not exists conceptos_asignaciones (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  concepto_id uuid not null references conceptos(id) on delete cascade,
  tipo_objetivo text not null check (tipo_objetivo in ('empleado', 'cargo', 'centro_costo', 'area', 'sede', 'grupo')),
  objetivo text not null,
  desde date not null,
  hasta date,
  valor numeric
);

-- ---------- Turnos ----------

create table if not exists turnos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  nombre text not null,
  tipo text not null default 'fijo' check (tipo in ('fijo', 'rotativo', 'flexible')),
  dias jsonb not null default '{}'::jsonb,
  minimo_horas_dia numeric,
  maximo_horas_dia numeric,
  activo boolean not null default true
);

-- ---------- Empleados y contratos ----------

create table if not exists empleados (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  tipo_documento text not null default 'CC',
  numero_documento text not null,
  nombres text not null,
  apellidos text not null,
  fecha_nacimiento date,
  genero text,
  correo text,
  telefono text,
  direccion text,
  ciudad text,
  banco text,
  codigo_banco text,
  tipo_cuenta text,
  numero_cuenta text,
  eps_id uuid references entidades(id),
  afp_id uuid references entidades(id),
  cesantias_id uuid references entidades(id),
  ccf_id uuid references entidades(id),
  es_pensionado boolean not null default false,
  procedimiento_retencion int not null default 1 check (procedimiento_retencion in (1, 2)),
  porcentaje_proc2 numeric,
  tiene_dependiente boolean not null default false,
  dependientes_adicionales int not null default 0,
  intereses_vivienda numeric not null default 0,
  medicina_prepagada numeric not null default 0,
  aportes_voluntarios numeric not null default 0,
  soportes_retencion_hasta date,
  sede_id uuid references sedes(id),
  area_id uuid references areas(id),
  centro_costo_id uuid references centros_costo(id),
  grupo_pago_id uuid references grupos_pago(id),
  turno_id uuid references turnos(id),
  cargo text,
  marca_en_kiosco boolean not null default false,
  kiosco_id uuid,
  pin_hash text,
  pin_intentos int not null default 0,
  pin_bloqueado boolean not null default false,
  campos_adicionales jsonb not null default '{}'::jsonb,
  autorizacion_datos_en timestamptz,
  estado text not null default 'activo' check (estado in ('activo', 'retirado')),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (empresa_id, numero_documento)
);

create table if not exists afiliaciones_historial (
  id uuid primary key default gen_random_uuid(),
  empleado_id uuid not null references empleados(id) on delete cascade,
  tipo text not null,
  entidad_id uuid references entidades(id),
  desde date not null,
  creado_en timestamptz not null default now()
);

create table if not exists contratos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  tipo text not null check (tipo in ('indefinido', 'fijo', 'obra_labor', 'ocasional', 'aprendizaje', 'integral', 'tiempo_parcial')),
  fecha_inicio date not null,
  fecha_fin date,
  fecha_fin_pactada date,
  descripcion_obra text,
  cargo text,
  tipo_salario text not null default 'fijo' check (tipo_salario in ('fijo', 'variable', 'integral')),
  salario_integral boolean not null default false,
  factor_prestacional numeric,
  fase_aprendiz text,
  auxilio_transporte text not null default 'ley' check (auxilio_transporte in ('ley', 'siempre', 'nunca')),
  horas_semanales numeric,
  clase_riesgo int not null default 1 check (clase_riesgo between 1 and 5),
  prorrogas int not null default 0,
  estado text not null default 'activo' check (estado in ('activo', 'terminado')),
  causa_retiro text,
  creado_en timestamptz not null default now()
);
create index if not exists contratos_empleado_idx on contratos (empleado_id, fecha_inicio);

create table if not exists historial_salarial (
  id uuid primary key default gen_random_uuid(),
  contrato_id uuid not null references contratos(id) on delete cascade,
  desde date not null,
  salario numeric not null,
  cargo text,
  motivo text,
  creado_por uuid,
  creado_en timestamptz not null default now(),
  unique (contrato_id, desde)
);

-- ---------- Asistencia ----------

create table if not exists kioscos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  sede_id uuid references sedes(id) on delete cascade,
  nombre text not null,
  llave_hash text,
  activo boolean not null default true,
  vinculado_en timestamptz,
  ultimo_uso timestamptz
);

create table if not exists dispositivos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  llave_hash text not null unique,
  descripcion text,
  activo boolean not null default true,
  vinculado_en timestamptz not null default now(),
  ultimo_uso timestamptz,
  desvinculado_en timestamptz
);
create unique index if not exists dispositivo_activo_empleado_uq on dispositivos (empleado_id) where activo;

create table if not exists codigos_vinculacion (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  tipo text not null check (tipo in ('celular', 'kiosco')),
  empleado_id uuid references empleados(id) on delete cascade,
  kiosco_id uuid references kioscos(id) on delete cascade,
  codigo text not null,
  token text not null unique,
  expira_en timestamptz not null,
  usado_en timestamptz,
  creado_en timestamptz not null default now()
);

create table if not exists marcaciones (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  tipo text not null check (tipo in ('entrada', 'salida')),
  hora timestamptz not null,
  origen text not null check (origen in ('qr', 'kiosco', 'asistida', 'correccion', 'importacion')),
  sede_id uuid references sedes(id),
  dispositivo_id uuid references dispositivos(id),
  kiosco_id uuid references kioscos(id),
  excepcion boolean not null default false,
  registrado_por uuid,
  motivo text,
  anulada boolean not null default false,
  reemplaza_id uuid references marcaciones(id),
  creado_en timestamptz not null default now()
);
create index if not exists marcaciones_empleado_hora_idx on marcaciones (empleado_id, hora);

create table if not exists horas_registradas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  fecha date not null,
  tipo text not null check (tipo in ('HOD', 'HON', 'HED', 'HEN', 'HDD', 'HDN', 'HEDD', 'HEND')),
  horas numeric not null,
  origen text not null default 'asistencia' check (origen in ('asistencia', 'importacion')),
  estado text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  aprobado_por uuid,
  aprobado_en timestamptz,
  actividad text,
  unique (empleado_id, fecha, tipo, origen)
);

create table if not exists alertas_asistencia (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  fecha date not null,
  tipo text not null,
  minutos int,
  mensaje text not null,
  unique (empleado_id, fecha, tipo)
);

-- ---------- Novedades, préstamos y embargos ----------

create table if not exists novedades (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  clase text not null check (clase in ('dias', 'valor')),
  tipo text not null,
  desde date,
  hasta date,
  fecha date,
  valor numeric,
  cantidad numeric,
  dias_previos int not null default 0,
  dias_habiles int,
  diagnostico text,
  soporte text,
  descripcion text,
  estado text not null default 'aprobada' check (estado in ('pendiente', 'aprobada', 'rechazada')),
  creado_por uuid,
  creado_en timestamptz not null default now()
);
create index if not exists novedades_empleado_idx on novedades (empleado_id, desde, fecha);

create table if not exists prestamos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  tipo text not null default 'prestamo' check (tipo in ('prestamo', 'libranza')),
  descripcion text not null,
  valor_total numeric not null,
  numero_cuotas int not null,
  cuota numeric not null,
  saldo numeric not null,
  fecha_inicio date not null,
  autorizacion_escrita boolean not null default true,
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

create table if not exists embargos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  tipo text not null check (tipo in ('ordinario', 'alimentos', 'cooperativa')),
  descripcion text not null,
  juzgado text,
  numero_proceso text,
  valor_fijo numeric,
  porcentaje numeric,
  saldo numeric,
  prioridad int,
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

create table if not exists saldos_iniciales (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  tipo text not null,
  valor numeric not null,
  fecha_corte date not null,
  creado_en timestamptz not null default now(),
  unique (empleado_id, tipo, fecha_corte)
);

create table if not exists entregas_dotacion (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  fecha_programada date not null,
  entregado_en date,
  elementos text,
  confirmado boolean not null default false,
  unique (empleado_id, fecha_programada)
);

-- ---------- Periodos y liquidaciones ----------

create table if not exists periodos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  grupo_pago_id uuid references grupos_pago(id),
  tipo text not null default 'nomina' check (tipo in ('nomina', 'prima', 'cesantias', 'intereses', 'vacaciones', 'retiro')),
  nombre text not null,
  desde date not null,
  hasta date not null,
  fecha_pago date,
  estado text not null default 'abierto' check (estado in ('abierto', 'liquidado', 'aprobado', 'cerrado')),
  liquidado_en timestamptz,
  liquidado_por uuid,
  aprobado_por uuid,
  aprobado_en timestamptz,
  cerrado_en timestamptz,
  archivo_banco_en timestamptz,
  reabierto_motivo text,
  creado_en timestamptz not null default now()
);
create index if not exists periodos_empresa_idx on periodos (empresa_id, desde desc);

create table if not exists liquidaciones (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  periodo_id uuid not null references periodos(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  contrato_id uuid references contratos(id),
  resultado jsonb not null,
  total_devengos numeric not null default 0,
  total_deducciones numeric not null default 0,
  neto numeric not null default 0,
  aportes numeric not null default 0,
  provisiones numeric not null default 0,
  costo_total numeric not null default 0,
  creado_en timestamptz not null default now(),
  unique (periodo_id, empleado_id)
);

create table if not exists liquidacion_lineas (
  id uuid primary key default gen_random_uuid(),
  liquidacion_id uuid not null references liquidaciones(id) on delete cascade,
  empresa_id uuid not null references empresas(id) on delete cascade,
  periodo_id uuid not null references periodos(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  concepto text not null,
  nombre text not null,
  tipo text not null,
  categoria text,
  cantidad numeric,
  valor numeric not null,
  referencia text
);
create index if not exists lineas_empleado_idx on liquidacion_lineas (empleado_id, periodo_id);
create index if not exists lineas_periodo_idx on liquidacion_lineas (periodo_id, concepto);

create table if not exists retiros (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  contrato_id uuid not null references contratos(id) on delete cascade,
  fecha_retiro date not null,
  causa text not null,
  sin_justa_causa boolean not null default false,
  resultado jsonb not null,
  total numeric not null,
  estado text not null default 'borrador' check (estado in ('borrador', 'aprobado', 'pagado')),
  fecha_pago date,
  creado_en timestamptz not null default now()
);

create table if not exists formatos_archivo (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  clase text not null check (clase in ('banco', 'contable')),
  codigo text not null,
  nombre text not null,
  definicion jsonb not null,
  activo boolean not null default true,
  unique (empresa_id, clase, codigo)
);

create table if not exists pagos (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid not null references empresas(id) on delete cascade,
  periodo_id uuid not null references periodos(id) on delete cascade,
  empleado_id uuid not null references empleados(id) on delete cascade,
  valor numeric not null,
  formato text,
  estado text not null default 'pendiente' check (estado in ('pendiente', 'pagado', 'rechazado')),
  fecha date,
  observacion text,
  unique (periodo_id, empleado_id)
);

-- ---------- Evolución del esquema (columnas agregadas en versiones posteriores) ----------
alter table periodos add column if not exists liquidado_por uuid;
alter table periodos add column if not exists reabierto_motivo text;
alter table parametros add column if not exists vigencias_legales jsonb;

-- ---------- Seguridad: Supabase expone las tablas por su API pública.
-- Se activa RLS sin políticas para que solo el backend (conexión directa) las use.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;


-- ---------- Datos iniciales ----------
begin;
insert into empresas (id, nit, razon_social, configuracion) values ('00000000-0000-4000-8000-000000000001', '900000000', 'Mi Empresa S.A.S.', '{"calendario":{"diasLaborales":[1,2,3,4,5,6],"diaDescanso":0,"sabadoHabilVacaciones":true},"horas":{"inicioNocturna":"19:00","finNocturna":"06:00","horasOrdinariasDiaSinTurno":8,"toleranciaMinutos":5,"minimoMinutosExtra":0},"asistencia":{"activa":true,"qrSegundos":30,"qrGracia":5,"minutosDuplicado":5,"permitirExcepcionKiosco":true,"intentosPin":3,"nivelControl":"medio"},"aprobacion":{"pasos":1,"separarLiquidaAprueba":false,"umbralVariacion":0.1},"avisos":{"diasContratoPorVencer":45,"diasPrima":10,"diasCesantias":15,"correo":false},"seguridad":{"intentosLogin":5,"minutosBloqueo":15,"minutosSesion":30},"vacaciones":{"diasPreaviso":15,"maxPeriodosAcumulados":2},"retiro":{"diasPreavisoRenuncia":30,"maxAniosFijo":4},"campos":[]}'::jsonb) on conflict (id) do nothing;
insert into usuarios (empresa_id, usuario, nombre, password_hash, rol, debe_cambiar_password) select '00000000-0000-4000-8000-000000000001', 'Santiago', 'Santiago', crypt('123456santiago', gen_salt('bf', 10)), 'superusuario', false where not exists (select 1 from usuarios where lower(usuario) = lower('Santiago'));
insert into sedes (empresa_id, nombre) select '00000000-0000-4000-8000-000000000001', 'Sede principal' where not exists (select 1 from sedes where empresa_id = '00000000-0000-4000-8000-000000000001');
insert into centros_costo (empresa_id, codigo, nombre) values ('00000000-0000-4000-8000-000000000001', 'ADM', 'Administración') on conflict (empresa_id, codigo) do nothing;
insert into grupos_pago (empresa_id, nombre, periodicidad) select '00000000-0000-4000-8000-000000000001', 'Nómina mensual', 'mensual' where not exists (select 1 from grupos_pago where empresa_id = '00000000-0000-4000-8000-000000000001');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'Nueva EPS' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'Nueva EPS');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'EPS Sura' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'EPS Sura');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'Sanitas EPS' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'Sanitas EPS');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'Salud Total EPS' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'Salud Total EPS');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'Compensar EPS' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'Compensar EPS');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'Famisanar EPS' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'Famisanar EPS');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'Coosalud EPS' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'Coosalud EPS');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'Mutual Ser EPS' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'Mutual Ser EPS');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'Aliansalud EPS' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'Aliansalud EPS');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'eps', 'SOS EPS' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'eps' and nombre = 'SOS EPS');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'afp', 'Colpensiones' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'afp' and nombre = 'Colpensiones');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'afp', 'Porvenir' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'afp' and nombre = 'Porvenir');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'afp', 'Protección' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'afp' and nombre = 'Protección');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'afp', 'Colfondos' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'afp' and nombre = 'Colfondos');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'afp', 'Skandia' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'afp' and nombre = 'Skandia');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'cesantias', 'Porvenir' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'cesantias' and nombre = 'Porvenir');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'cesantias', 'Protección' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'cesantias' and nombre = 'Protección');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'cesantias', 'Colfondos' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'cesantias' and nombre = 'Colfondos');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'cesantias', 'Skandia' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'cesantias' and nombre = 'Skandia');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'cesantias', 'Fondo Nacional del Ahorro' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'cesantias' and nombre = 'Fondo Nacional del Ahorro');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'arl', 'ARL Sura' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'arl' and nombre = 'ARL Sura');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'arl', 'Positiva' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'arl' and nombre = 'Positiva');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'arl', 'Colmena Seguros' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'arl' and nombre = 'Colmena Seguros');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'arl', 'Seguros Bolívar' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'arl' and nombre = 'Seguros Bolívar');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'arl', 'AXA Colpatria' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'arl' and nombre = 'AXA Colpatria');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'arl', 'La Equidad Seguros' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'arl' and nombre = 'La Equidad Seguros');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Compensar' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Compensar');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Colsubsidio' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Colsubsidio');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Cafam' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Cafam');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Comfama' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Comfama');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Comfenalco Antioquia' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Comfenalco Antioquia');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Comfandi' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Comfandi');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Comfenalco Valle' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Comfenalco Valle');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Cajacopi' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Cajacopi');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Comfacundi' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Comfacundi');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Comfamiliar Risaralda' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Comfamiliar Risaralda');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Comfenalco Santander' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Comfenalco Santander');
insert into entidades (empresa_id, tipo, nombre) select '00000000-0000-4000-8000-000000000001', 'ccf', 'Comfaoriente' where not exists (select 1 from entidades where empresa_id = '00000000-0000-4000-8000-000000000001' and tipo = 'ccf' and nombre = 'Comfaoriente');
insert into turnos (empresa_id, nombre, tipo, dias) select '00000000-0000-4000-8000-000000000001', 'Lunes a viernes (42 horas)', 'fijo', '{"1":[{"inicio":"07:00","fin":"15:24"}],"2":[{"inicio":"07:00","fin":"15:24"}],"3":[{"inicio":"07:00","fin":"15:24"}],"4":[{"inicio":"07:00","fin":"15:24"}],"5":[{"inicio":"07:00","fin":"15:24"}]}'::jsonb where not exists (select 1 from turnos where empresa_id = '00000000-0000-4000-8000-000000000001');
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'SMMLV', 'Salario mínimo mensual', 'Salario mínimo legal mensual vigente.', 'salario', 'dinero', 'Decreto 1469 de 2025 (valor mantenido por Decreto 0159 de 2026)', '1750905', '[{"desde":"2025-01-01","valor":"1423500"},{"desde":"2026-01-01","valor":"1750905"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2025-01-01', '1423500' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'SMMLV' on conflict (parametro_id, desde) do nothing;
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2026-01-01', '1750905' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'SMMLV' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'AUX_TRANSPORTE', 'Auxilio de transporte mensual', 'Valor mensual del auxilio de transporte.', 'salario', 'dinero', 'Decreto 1470 de 2025', '249095', '[{"desde":"2025-01-01","valor":"200000"},{"desde":"2026-01-01","valor":"249095"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2025-01-01', '200000' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'AUX_TRANSPORTE' on conflict (parametro_id, desde) do nothing;
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2026-01-01', '249095' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'AUX_TRANSPORTE' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'TOPE_AUX_TRANSPORTE_SMMLV', 'Tope para auxilio de transporte (en salarios mínimos)', 'Quien gane hasta este número de salarios mínimos recibe auxilio de transporte.', 'salario', 'numero', 'Ley 15 de 1959', '2', '[{"desde":"2020-01-01","valor":"2"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '2' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'TOPE_AUX_TRANSPORTE_SMMLV' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'UVT', 'Valor de la UVT', 'Unidad de Valor Tributario.', 'retencion', 'dinero', 'Resolución DIAN 000238 de 2025', '52374', '[{"desde":"2025-01-01","valor":"49799"},{"desde":"2026-01-01","valor":"52374"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2025-01-01', '49799' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'UVT' on conflict (parametro_id, desde) do nothing;
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2026-01-01', '52374' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'UVT' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'DIAS_MES', 'Días del mes para liquidar', 'Días base del mes comercial.', 'salario', 'dias', 'CST art. 134', '30', '[{"desde":"2020-01-01","valor":"30"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '30' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'DIAS_MES' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'DIAS_ANIO', 'Días del año para prestaciones', 'Días base del año comercial.', 'prestaciones', 'dias', null, '360', '[{"desde":"2020-01-01","valor":"360"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '360' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'DIAS_ANIO' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'INTEGRAL_MIN_SMMLV', 'Salario integral mínimo (en salarios mínimos)', 'Mínimo del salario integral antes del factor prestacional.', 'salario', 'numero', 'CST art. 132', '10', '[{"desde":"2020-01-01","valor":"10"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '10' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'INTEGRAL_MIN_SMMLV' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'INTEGRAL_FACTOR_MIN', 'Factor prestacional mínimo del salario integral', 'Porcentaje mínimo del factor prestacional.', 'salario', 'porcentaje', 'CST art. 132', '0.30', '[{"desde":"2020-01-01","valor":"0.30"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.30' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'INTEGRAL_FACTOR_MIN' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'HORAS_SEMANALES', 'Jornada máxima semanal (horas)', 'Horas semanales de la jornada ordinaria máxima.', 'jornada', 'horas', 'CST art. 161; Ley 2101 de 2021', '42', '[{"desde":"2024-07-15","valor":"46"},{"desde":"2025-07-15","valor":"44"},{"desde":"2026-07-15","valor":"42"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2024-07-15', '46' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'HORAS_SEMANALES' on conflict (parametro_id, desde) do nothing;
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2025-07-15', '44' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'HORAS_SEMANALES' on conflict (parametro_id, desde) do nothing;
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2026-07-15', '42' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'HORAS_SEMANALES' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'MAX_EXTRAS_DIA', 'Máximo de horas extra al día', 'Se genera una alerta si se supera.', 'jornada', 'horas', 'Ley 2101 de 2021', '2', '[{"desde":"2020-01-01","valor":"2"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '2' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'MAX_EXTRAS_DIA' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'MAX_EXTRAS_SEMANA', 'Máximo de horas extra a la semana', 'Se genera una alerta si se supera.', 'jornada', 'horas', 'Ley 2101 de 2021', '12', '[{"desde":"2020-01-01","valor":"12"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '12' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'MAX_EXTRAS_SEMANA' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RECARGO_HON', 'Recargo nocturno', 'Recargo por trabajo nocturno.', 'recargos', 'porcentaje', 'CST art. 168 num. 1', '0.35', '[{"desde":"2020-01-01","valor":"0.35"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.35' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RECARGO_HON' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RECARGO_HED', 'Recargo hora extra diurna', 'Recargo de la hora extra diurna.', 'recargos', 'porcentaje', 'CST art. 168 num. 2', '0.25', '[{"desde":"2020-01-01","valor":"0.25"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.25' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RECARGO_HED' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RECARGO_HEN', 'Recargo hora extra nocturna', 'Recargo de la hora extra nocturna (no se le suma el nocturno).', 'recargos', 'porcentaje', 'CST art. 168 nums. 3 y 4', '0.75', '[{"desde":"2020-01-01","valor":"0.75"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.75' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RECARGO_HEN' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RECARGO_DESCANSO', 'Recargo por trabajo en día de descanso o festivo', 'Recargo por trabajar en día de descanso obligatorio o festivo.', 'recargos', 'porcentaje', 'CST art. 179, parágrafo transitorio', '1.00', '[{"desde":"2020-01-01","valor":"0.75"},{"desde":"2025-07-01","valor":"0.80"},{"desde":"2026-07-01","valor":"0.90"},{"desde":"2027-07-01","valor":"1.00"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.75' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RECARGO_DESCANSO' on conflict (parametro_id, desde) do nothing;
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2025-07-01', '0.80' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RECARGO_DESCANSO' on conflict (parametro_id, desde) do nothing;
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2026-07-01', '0.90' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RECARGO_DESCANSO' on conflict (parametro_id, desde) do nothing;
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2027-07-01', '1.00' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RECARGO_DESCANSO' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_SALUD_EMPLEADO', 'Salud a cargo del empleado', '', 'seguridad_social', 'porcentaje', 'Ley 100 de 1993', '0.04', '[{"desde":"2020-01-01","valor":"0.04"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.04' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_SALUD_EMPLEADO' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_PENSION_EMPLEADO', 'Pensión a cargo del empleado', '', 'seguridad_social', 'porcentaje', 'Ley 100 de 1993', '0.04', '[{"desde":"2020-01-01","valor":"0.04"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.04' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_PENSION_EMPLEADO' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_SALUD_EMPLEADOR', 'Salud a cargo del empleador', '', 'seguridad_social', 'porcentaje', 'Ley 100 de 1993', '0.085', '[{"desde":"2020-01-01","valor":"0.085"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.085' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_SALUD_EMPLEADOR' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_PENSION_EMPLEADOR', 'Pensión a cargo del empleador', '', 'seguridad_social', 'porcentaje', 'Ley 100 de 1993', '0.12', '[{"desde":"2020-01-01","valor":"0.12"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.12' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_PENSION_EMPLEADOR' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_CCF', 'Caja de compensación', '', 'seguridad_social', 'porcentaje', null, '0.04', '[{"desde":"2020-01-01","valor":"0.04"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.04' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_CCF' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_ICBF', 'ICBF', '', 'seguridad_social', 'porcentaje', null, '0.03', '[{"desde":"2020-01-01","valor":"0.03"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.03' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_ICBF' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_SENA', 'SENA', '', 'seguridad_social', 'porcentaje', null, '0.02', '[{"desde":"2020-01-01","valor":"0.02"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.02' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_SENA' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'EXONERACION_TOPE_SMMLV', 'Tope de exoneración de aportes (en salarios mínimos)', 'Por debajo de este salario no se pagan salud del empleador, ICBF ni SENA si la empresa está exonerada.', 'seguridad_social', 'numero', 'ET art. 114-1', '10', '[{"desde":"2020-01-01","valor":"10"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '10' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'EXONERACION_TOPE_SMMLV' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'IBC_MIN_SMMLV', 'IBC mínimo (en salarios mínimos)', '', 'seguridad_social', 'numero', 'Ley 100 de 1993', '1', '[{"desde":"2020-01-01","valor":"1"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '1' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'IBC_MIN_SMMLV' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'IBC_MAX_SMMLV', 'IBC máximo (en salarios mínimos)', '', 'seguridad_social', 'numero', 'Ley 100 de 1993', '25', '[{"desde":"2020-01-01","valor":"25"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '25' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'IBC_MAX_SMMLV' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_LIMITE_NO_SALARIAL', 'Límite de pagos no salariales', 'Lo que exceda este porcentaje del total se suma al IBC.', 'seguridad_social', 'porcentaje', 'Ley 1393 de 2010 art. 30', '0.40', '[{"desde":"2020-01-01","valor":"0.40"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.40' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_LIMITE_NO_SALARIAL' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_IBC_INTEGRAL', 'Porcentaje del salario integral que es IBC', '', 'seguridad_social', 'porcentaje', 'CST art. 132', '0.70', '[{"desde":"2020-01-01","valor":"0.70"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.70' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_IBC_INTEGRAL' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_PROV_CESANTIAS', 'Provisión mensual de cesantías', 'Un mes de salario por año (1/12).', 'prestaciones', 'porcentaje', 'CST art. 249', '0.0833333333', '[{"desde":"2020-01-01","valor":"0.0833333333"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.0833333333' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_PROV_CESANTIAS' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_INTERESES_CESANTIAS', 'Intereses sobre cesantías (anual)', '', 'prestaciones', 'porcentaje', 'Ley 52 de 1975', '0.12', '[{"desde":"2020-01-01","valor":"0.12"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.12' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_INTERESES_CESANTIAS' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_PROV_PRIMA', 'Provisión mensual de prima', '30 días por año (1/12).', 'prestaciones', 'porcentaje', 'CST art. 306', '0.0833333333', '[{"desde":"2020-01-01","valor":"0.0833333333"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.0833333333' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_PROV_PRIMA' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_PROV_VACACIONES', 'Provisión mensual de vacaciones', '15 días por año (1/24).', 'prestaciones', 'porcentaje', 'CST art. 186', '0.0416666667', '[{"desde":"2020-01-01","valor":"0.0416666667"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.0416666667' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_PROV_VACACIONES' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'DIAS_VACACIONES_ANIO', 'Días hábiles de vacaciones por año', '', 'prestaciones', 'dias', 'CST art. 186', '15', '[{"desde":"2020-01-01","valor":"15"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '15' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'DIAS_VACACIONES_ANIO' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'MAX_PCT_VACACIONES_DINERO', 'Máximo de vacaciones pagadas en dinero', '', 'prestaciones', 'porcentaje', 'CST art. 189', '0.5', '[{"desde":"2020-01-01","valor":"0.5"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.5' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'MAX_PCT_VACACIONES_DINERO' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'MESES_VARIACION_PROMEDIO', 'Meses sin cambio de salario para usar el último', 'Si el salario cambió en estos meses, la base es el promedio.', 'prestaciones', 'numero', 'CST art. 253', '3', '[{"desde":"2020-01-01","valor":"3"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '3' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'MESES_VARIACION_PROMEDIO' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PAGA_AUX_EN_VACACIONES', 'Pagar auxilio de transporte en vacaciones', '1 = sí, 0 = no.', 'salario', 'booleano', null, '0', '[{"desde":"2020-01-01","valor":"0"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PAGA_AUX_EN_VACACIONES' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PAGA_AUX_EN_INCAPACIDAD', 'Pagar auxilio de transporte en incapacidad', '1 = sí, 0 = no.', 'salario', 'booleano', null, '0', '[{"desde":"2020-01-01","valor":"0"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PAGA_AUX_EN_INCAPACIDAD' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'INCAP_MIN_SMMLV', 'Incapacidad no menor al salario mínimo diario', '1 = sí, 0 = no.', 'incapacidades', 'booleano', 'Corte Constitucional C-543 de 2007', '1', '[{"desde":"2020-01-01","valor":"1"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '1' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'INCAP_MIN_SMMLV' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'EMPRESA_COMPLETA_INCAPACIDAD', 'La empresa completa el 100% en incapacidades', 'Si es 1, la empresa paga la diferencia hasta el salario completo.', 'incapacidades', 'booleano', null, '0', '[{"desde":"2020-01-01","valor":"0"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'EMPRESA_COMPLETA_INCAPACIDAD' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_INCAP_LABORAL', 'Porcentaje de la incapacidad laboral', '', 'incapacidades', 'porcentaje', 'Ley 1562 de 2012', '1', '[{"desde":"2020-01-01","valor":"1"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '1' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_INCAP_LABORAL' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PCT_LICENCIA_EPS', 'Porcentaje de licencias de maternidad y paternidad', '', 'incapacidades', 'porcentaje', 'CST art. 236', '1', '[{"desde":"2020-01-01","valor":"1"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '1' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PCT_LICENCIA_EPS' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'SEMANAS_LICENCIA_MATERNIDAD', 'Semanas de licencia de maternidad', '', 'incapacidades', 'numero', 'CST art. 236', '18', '[{"desde":"2020-01-01","valor":"18"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '18' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'SEMANAS_LICENCIA_MATERNIDAD' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'SEMANAS_LICENCIA_PATERNIDAD', 'Semanas de licencia de paternidad', 'Se amplía si baja el desempleo estructural.', 'incapacidades', 'numero', 'CST art. 236 parágrafo 2', '2', '[{"desde":"2020-01-01","valor":"2"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '2' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'SEMANAS_LICENCIA_PATERNIDAD' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'AUSENCIA_PIERDE_DOMINICAL', 'La ausencia injustificada descuenta el dominical', '1 = sí, 0 = no.', 'incapacidades', 'booleano', 'CST art. 173', '0', '[{"desde":"2020-01-01","valor":"0"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'AUSENCIA_PIERDE_DOMINICAL' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RET_PCT_EXENTA', 'Renta exenta laboral', '', 'retencion', 'porcentaje', 'ET art. 206 num. 10', '0.25', '[{"desde":"2020-01-01","valor":"0.25"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.25' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RET_PCT_EXENTA' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RET_TOPE_EXENTA_UVT_ANUAL', 'Tope anual de la renta exenta (UVT)', '', 'retencion', 'numero', 'ET art. 206 num. 10', '790', '[{"desde":"2020-01-01","valor":"790"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '790' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RET_TOPE_EXENTA_UVT_ANUAL' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RET_LIMITE_PCT', 'Límite global de beneficios', '', 'retencion', 'porcentaje', 'ET art. 336', '0.40', '[{"desde":"2020-01-01","valor":"0.40"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.40' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RET_LIMITE_PCT' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RET_LIMITE_UVT_ANUAL', 'Tope anual del límite global (UVT)', '', 'retencion', 'numero', 'ET art. 336', '1340', '[{"desde":"2020-01-01","valor":"1340"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '1340' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RET_LIMITE_UVT_ANUAL' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RET_DEPENDIENTES_PCT', 'Deducción por dependientes', '', 'retencion', 'porcentaje', 'ET art. 387', '0.10', '[{"desde":"2020-01-01","valor":"0.10"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.10' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RET_DEPENDIENTES_PCT' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RET_DEPENDIENTES_TOPE_UVT', 'Tope mensual por dependientes (UVT)', '', 'retencion', 'numero', 'ET art. 387', '32', '[{"desde":"2020-01-01","valor":"32"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '32' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RET_DEPENDIENTES_TOPE_UVT' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RET_VIVIENDA_TOPE_UVT', 'Tope mensual de intereses de vivienda (UVT)', '', 'retencion', 'numero', 'ET art. 119', '100', '[{"desde":"2020-01-01","valor":"100"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '100' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RET_VIVIENDA_TOPE_UVT' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RET_PREPAGADA_TOPE_UVT', 'Tope mensual de medicina prepagada (UVT)', '', 'retencion', 'numero', 'ET art. 387', '16', '[{"desde":"2020-01-01","valor":"16"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '16' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RET_PREPAGADA_TOPE_UVT' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RET_DEP_ADICIONAL_UVT_ANUAL', 'Deducción anual por dependiente adicional (UVT)', '', 'retencion', 'numero', 'ET art. 336 (Ley 2277 de 2022)', '72', '[{"desde":"2020-01-01","valor":"72"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '72' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RET_DEP_ADICIONAL_UVT_ANUAL' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'RETENCION_SOLO_CIERRE_MES', 'Calcular la retención solo en el periodo que cierra el mes', 'En nóminas quincenales la retención se calcula sobre el mes completo.', 'retencion', 'booleano', null, '1', '[{"desde":"2020-01-01","valor":"1"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '1' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'RETENCION_SOLO_CIERRE_MES' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'EMBARGO_FRACCION_EXCEDENTE', 'Fracción embargable del excedente del mínimo', 'Una quinta parte.', 'descuentos', 'porcentaje', 'CST art. 155', '0.2', '[{"desde":"2020-01-01","valor":"0.2"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.2' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'EMBARGO_FRACCION_EXCEDENTE' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'EMBARGO_PCT_ALIMENTOS', 'Máximo embargable por alimentos o cooperativas', '', 'descuentos', 'porcentaje', 'CST art. 156', '0.5', '[{"desde":"2020-01-01","valor":"0.5"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.5' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'EMBARGO_PCT_ALIMENTOS' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'PROTEGER_MINIMO', 'Los descuentos voluntarios no afectan el salario mínimo', '1 = sí, 0 = no.', 'descuentos', 'booleano', 'CST art. 149', '1', '[{"desde":"2020-01-01","valor":"1"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '1' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'PROTEGER_MINIMO' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'APRENDIZ_PCT_LECTIVA', 'Apoyo de sostenimiento en fase lectiva', '', 'aprendices', 'porcentaje', 'CST art. 81', '0.75', '[{"desde":"2020-01-01","valor":"0.75"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.75' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'APRENDIZ_PCT_LECTIVA' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'APRENDIZ_PCT_PRACTICA', 'Apoyo de sostenimiento en fase práctica', '', 'aprendices', 'porcentaje', 'CST art. 81', '1', '[{"desde":"2020-01-01","valor":"1"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '1' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'APRENDIZ_PCT_PRACTICA' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'APRENDIZ_PCT_UNIVERSITARIO', 'Apoyo mínimo para aprendiz universitario', '', 'aprendices', 'porcentaje', 'CST art. 81', '1', '[{"desde":"2020-01-01","valor":"1"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '1' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'APRENDIZ_PCT_UNIVERSITARIO' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'INDEM_TOPE_SMMLV', 'Tope que separa las tablas de indemnización (SMMLV)', '', 'retiro', 'numero', 'CST art. 64', '10', '[{"desde":"2020-01-01","valor":"10"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '10' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'INDEM_TOPE_SMMLV' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'INDEM_DIAS_PRIMER_ANIO_MENOR', 'Días por el primer año (menos del tope)', '', 'retiro', 'dias', 'CST art. 64', '30', '[{"desde":"2020-01-01","valor":"30"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '30' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'INDEM_DIAS_PRIMER_ANIO_MENOR' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'INDEM_DIAS_ADICIONAL_MENOR', 'Días por año adicional (menos del tope)', '', 'retiro', 'dias', 'CST art. 64', '20', '[{"desde":"2020-01-01","valor":"20"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '20' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'INDEM_DIAS_ADICIONAL_MENOR' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'INDEM_DIAS_PRIMER_ANIO_MAYOR', 'Días por el primer año (tope o más)', '', 'retiro', 'dias', 'CST art. 64', '20', '[{"desde":"2020-01-01","valor":"20"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '20' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'INDEM_DIAS_PRIMER_ANIO_MAYOR' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'INDEM_DIAS_ADICIONAL_MAYOR', 'Días por año adicional (tope o más)', '', 'retiro', 'dias', 'CST art. 64', '15', '[{"desde":"2020-01-01","valor":"15"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '15' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'INDEM_DIAS_ADICIONAL_MAYOR' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'INDEM_MIN_DIAS_OBRA', 'Mínimo de días en obra o labor', '', 'retiro', 'dias', 'CST art. 64', '15', '[{"desde":"2020-01-01","valor":"15"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '15' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'INDEM_MIN_DIAS_OBRA' on conflict (parametro_id, desde) do nothing;
insert into parametros (empresa_id, codigo, nombre, descripcion, categoria, tipo, base_legal, valor_legal, vigencias_legales) values ('00000000-0000-4000-8000-000000000001', 'TASA_MORATORIA_MENSUAL', 'Tasa de interés moratorio mensual (después de 24 meses)', 'Ajústela a la tasa certificada por la Superfinanciera.', 'retiro', 'porcentaje', 'CST art. 65', '0.02', '[{"desde":"2020-01-01","valor":"0.02"}]'::jsonb) on conflict (empresa_id, codigo) do update set vigencias_legales = coalesce(parametros.vigencias_legales, excluded.vigencias_legales);
insert into parametros_vigencias (parametro_id, desde, valor) select id, '2020-01-01', '0.02' from parametros where empresa_id = '00000000-0000-4000-8000-000000000001' and codigo = 'TASA_MORATORIA_MENSUAL' on conflict (parametro_id, desde) do nothing;
insert into tablas_parametro (empresa_id, codigo, nombre, descripcion, columnas, filas, filas_legales) values ('00000000-0000-4000-8000-000000000001', 'FSP', 'Fondo de Solidaridad Pensional', 'Porcentaje según el IBC en salarios mínimos (desde incluido, hasta excluido).', '["valor"]'::jsonb, '[{"desde":"0","hasta":"4","valores":{"valor":"0"}},{"desde":"4","hasta":"16","valores":{"valor":"0.01"}},{"desde":"16","hasta":"17","valores":{"valor":"0.012"}},{"desde":"17","hasta":"18","valores":{"valor":"0.014"}},{"desde":"18","hasta":"19","valores":{"valor":"0.016"}},{"desde":"19","hasta":"20","valores":{"valor":"0.018"}},{"desde":"20","hasta":null,"valores":{"valor":"0.02"}}]'::jsonb, '[{"desde":"0","hasta":"4","valores":{"valor":"0"}},{"desde":"4","hasta":"16","valores":{"valor":"0.01"}},{"desde":"16","hasta":"17","valores":{"valor":"0.012"}},{"desde":"17","hasta":"18","valores":{"valor":"0.014"}},{"desde":"18","hasta":"19","valores":{"valor":"0.016"}},{"desde":"19","hasta":"20","valores":{"valor":"0.018"}},{"desde":"20","hasta":null,"valores":{"valor":"0.02"}}]'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into tablas_parametro (empresa_id, codigo, nombre, descripcion, columnas, filas, filas_legales) values ('00000000-0000-4000-8000-000000000001', 'ARL', 'Tarifas de riesgos laborales', 'Tarifa de ARL por clase de riesgo (I a V).', '["valor"]'::jsonb, '[{"desde":"1","hasta":"2","valores":{"valor":"0.00522"}},{"desde":"2","hasta":"3","valores":{"valor":"0.01044"}},{"desde":"3","hasta":"4","valores":{"valor":"0.02436"}},{"desde":"4","hasta":"5","valores":{"valor":"0.0435"}},{"desde":"5","hasta":"6","valores":{"valor":"0.0696"}}]'::jsonb, '[{"desde":"1","hasta":"2","valores":{"valor":"0.00522"}},{"desde":"2","hasta":"3","valores":{"valor":"0.01044"}},{"desde":"3","hasta":"4","valores":{"valor":"0.02436"}},{"desde":"4","hasta":"5","valores":{"valor":"0.0435"}},{"desde":"5","hasta":"6","valores":{"valor":"0.0696"}}]'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into tablas_parametro (empresa_id, codigo, nombre, descripcion, columnas, filas, filas_legales) values ('00000000-0000-4000-8000-000000000001', 'INCAPACIDAD_EG', 'Incapacidad por enfermedad general', 'Por día de incapacidad: porcentaje del salario y quién paga (1 = empleador, 2 = EPS, 3 = fondo de pensiones).', '["pct","pagador"]'::jsonb, '[{"desde":"1","hasta":"3","valores":{"pct":"0.6667","pagador":"1"}},{"desde":"3","hasta":"91","valores":{"pct":"0.6667","pagador":"2"}},{"desde":"91","hasta":"181","valores":{"pct":"0.5","pagador":"2"}},{"desde":"181","hasta":"541","valores":{"pct":"0.5","pagador":"3"}},{"desde":"541","hasta":null,"valores":{"pct":"0.5","pagador":"2"}}]'::jsonb, '[{"desde":"1","hasta":"3","valores":{"pct":"0.6667","pagador":"1"}},{"desde":"3","hasta":"91","valores":{"pct":"0.6667","pagador":"2"}},{"desde":"91","hasta":"181","valores":{"pct":"0.5","pagador":"2"}},{"desde":"181","hasta":"541","valores":{"pct":"0.5","pagador":"3"}},{"desde":"541","hasta":null,"valores":{"pct":"0.5","pagador":"2"}}]'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into tablas_parametro (empresa_id, codigo, nombre, descripcion, columnas, filas, filas_legales) values ('00000000-0000-4000-8000-000000000001', 'RETENCION_383', 'Tabla de retención en la fuente (art. 383 ET)', 'Rangos en UVT: impuesto = (base − resta) × tarifa + suma.', '["tarifa","resta_uvt","suma_uvt"]'::jsonb, '[{"desde":"0","hasta":"95","valores":{"tarifa":"0","resta_uvt":"0","suma_uvt":"0"}},{"desde":"95","hasta":"150","valores":{"tarifa":"0.19","resta_uvt":"95","suma_uvt":"0"}},{"desde":"150","hasta":"360","valores":{"tarifa":"0.28","resta_uvt":"150","suma_uvt":"10"}},{"desde":"360","hasta":"640","valores":{"tarifa":"0.33","resta_uvt":"360","suma_uvt":"69"}},{"desde":"640","hasta":"945","valores":{"tarifa":"0.35","resta_uvt":"640","suma_uvt":"162"}},{"desde":"945","hasta":"2300","valores":{"tarifa":"0.37","resta_uvt":"945","suma_uvt":"268"}},{"desde":"2300","hasta":null,"valores":{"tarifa":"0.39","resta_uvt":"2300","suma_uvt":"770"}}]'::jsonb, '[{"desde":"0","hasta":"95","valores":{"tarifa":"0","resta_uvt":"0","suma_uvt":"0"}},{"desde":"95","hasta":"150","valores":{"tarifa":"0.19","resta_uvt":"95","suma_uvt":"0"}},{"desde":"150","hasta":"360","valores":{"tarifa":"0.28","resta_uvt":"150","suma_uvt":"10"}},{"desde":"360","hasta":"640","valores":{"tarifa":"0.33","resta_uvt":"360","suma_uvt":"69"}},{"desde":"640","hasta":"945","valores":{"tarifa":"0.35","resta_uvt":"640","suma_uvt":"162"}},{"desde":"945","hasta":"2300","valores":{"tarifa":"0.37","resta_uvt":"945","suma_uvt":"268"}},{"desde":"2300","hasta":null,"valores":{"tarifa":"0.39","resta_uvt":"2300","suma_uvt":"770"}}]'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'SALARIO_BASICO', 'Salario básico', null, 'devengo', null, 'SI(O(ES_INTEGRAL; ES_APRENDIZ); 0; SUELDO_PROPORCIONAL)', true, true, true, true, true, true, true, false, false, false, 10, 'peso', true, 'CST art. 127', '510506', '250505', null, '{"formula":"SI(O(ES_INTEGRAL; ES_APRENDIZ); 0; SUELDO_PROPORCIONAL)","salarial":true,"baseIbc":true,"baseArl":true,"baseParafiscales":true,"basePrestaciones":true,"baseVacaciones":true,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'SALARIO_INTEGRAL', 'Salario integral', null, 'devengo', null, 'SI(ES_INTEGRAL; SUELDO_PROPORCIONAL; 0)', true, true, true, true, false, true, true, false, false, false, 11, 'peso', true, 'CST art. 132', '510503', '250505', null, '{"formula":"SI(ES_INTEGRAL; SUELDO_PROPORCIONAL; 0)","salarial":true,"baseIbc":true,"baseArl":true,"baseParafiscales":true,"basePrestaciones":false,"baseVacaciones":true,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'APOYO_SOSTENIMIENTO', 'Apoyo de sostenimiento (aprendiz)', null, 'devengo', null, 'SI(ES_APRENDIZ; SUELDO_PROPORCIONAL; 0)', true, false, false, false, true, true, false, false, false, false, 12, 'peso', true, 'CST art. 81', '510527', '250505', null, '{"formula":"SI(ES_APRENDIZ; SUELDO_PROPORCIONAL; 0)","salarial":true,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":true,"baseVacaciones":true,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'AUXILIO_TRANSPORTE', 'Auxilio de transporte', null, 'devengo', null, 'SI(Y(TIENE_AUXILIO; SALARIO <= TOPE_AUX_TRANSPORTE_SMMLV * SMMLV); AUX_TRANSPORTE / DIAS_MES * DIAS_AUXILIO; 0)', false, false, false, false, true, false, false, false, false, false, 20, 'peso', true, 'Ley 15 de 1959', '510527', '250505', null, '{"formula":"SI(Y(TIENE_AUXILIO; SALARIO <= TOPE_AUX_TRANSPORTE_SMMLV * SMMLV); AUX_TRANSPORTE / DIAS_MES * DIAS_AUXILIO; 0)","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":true,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'HON', 'Recargo nocturno', null, 'devengo', null, 'VALOR_HORA * HORAS_HON * RECARGO_HON', true, true, true, true, true, false, true, false, true, false, 30, 'peso', true, 'CST art. 168', '510518', '250505', null, '{"formula":"VALOR_HORA * HORAS_HON * RECARGO_HON","salarial":true,"baseIbc":true,"baseArl":true,"baseParafiscales":true,"basePrestaciones":true,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'HED', 'Horas extra diurnas', null, 'devengo', null, 'VALOR_HORA * HORAS_HED * (1 + RECARGO_HED)', true, true, true, true, true, false, true, false, true, false, 31, 'peso', true, 'CST art. 168', '510515', '250505', null, '{"formula":"VALOR_HORA * HORAS_HED * (1 + RECARGO_HED)","salarial":true,"baseIbc":true,"baseArl":true,"baseParafiscales":true,"basePrestaciones":true,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'HEN', 'Horas extra nocturnas', null, 'devengo', null, 'VALOR_HORA * HORAS_HEN * (1 + RECARGO_HEN)', true, true, true, true, true, false, true, false, true, false, 32, 'peso', true, 'CST art. 168', '510515', '250505', null, '{"formula":"VALOR_HORA * HORAS_HEN * (1 + RECARGO_HEN)","salarial":true,"baseIbc":true,"baseArl":true,"baseParafiscales":true,"basePrestaciones":true,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'HDD', 'Trabajo en día de descanso o festivo', null, 'devengo', null, 'VALOR_HORA * HORAS_HDD * (1 + RECARGO_DESCANSO)', true, true, true, true, true, false, true, false, true, false, 33, 'peso', true, 'CST art. 179', '510518', '250505', null, '{"formula":"VALOR_HORA * HORAS_HDD * (1 + RECARGO_DESCANSO)","salarial":true,"baseIbc":true,"baseArl":true,"baseParafiscales":true,"basePrestaciones":true,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'HDN', 'Nocturno en día de descanso o festivo', null, 'devengo', null, 'VALOR_HORA * HORAS_HDN * (1 + RECARGO_DESCANSO + RECARGO_HON)', true, true, true, true, true, false, true, false, true, false, 34, 'peso', true, 'CST arts. 168 y 179', '510518', '250505', null, '{"formula":"VALOR_HORA * HORAS_HDN * (1 + RECARGO_DESCANSO + RECARGO_HON)","salarial":true,"baseIbc":true,"baseArl":true,"baseParafiscales":true,"basePrestaciones":true,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'HEDD', 'Extra diurna en día de descanso o festivo', null, 'devengo', null, 'VALOR_HORA * HORAS_HEDD * (1 + RECARGO_DESCANSO + RECARGO_HED)', true, true, true, true, true, false, true, false, true, false, 35, 'peso', true, 'CST arts. 168 y 179', '510515', '250505', null, '{"formula":"VALOR_HORA * HORAS_HEDD * (1 + RECARGO_DESCANSO + RECARGO_HED)","salarial":true,"baseIbc":true,"baseArl":true,"baseParafiscales":true,"basePrestaciones":true,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'HEND', 'Extra nocturna en día de descanso o festivo', null, 'devengo', null, 'VALOR_HORA * HORAS_HEND * (1 + RECARGO_DESCANSO + RECARGO_HEN)', true, true, true, true, true, false, true, false, true, false, 36, 'peso', true, 'CST arts. 168 y 179', '510515', '250505', null, '{"formula":"VALOR_HORA * HORAS_HEND * (1 + RECARGO_DESCANSO + RECARGO_HEN)","salarial":true,"baseIbc":true,"baseArl":true,"baseParafiscales":true,"basePrestaciones":true,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'INCAPACIDAD_EMPLEADOR', 'Incapacidad (a cargo del empleador)', null, 'devengo', null, 'VALOR_INCAP_EMPLEADOR', false, true, false, false, false, false, true, false, false, false, 40, 'peso', true, 'Decreto 1427 de 2022', '510506', '250505', null, '{"formula":"VALOR_INCAP_EMPLEADOR","salarial":false,"baseIbc":true,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'INCAPACIDAD_EPS', 'Incapacidad (a cargo de la EPS)', null, 'devengo', null, 'VALOR_INCAP_EPS', false, true, false, false, false, false, true, false, false, false, 41, 'peso', true, 'Ley 100 de 1993', '138025', '250505', null, '{"formula":"VALOR_INCAP_EPS","salarial":false,"baseIbc":true,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'INCAPACIDAD_AFP', 'Incapacidad (a cargo del fondo de pensiones)', null, 'devengo', null, 'VALOR_INCAP_AFP', false, true, false, false, false, false, true, false, false, false, 42, 'peso', true, 'Ley 100 de 1993', '138025', '250505', null, '{"formula":"VALOR_INCAP_AFP","salarial":false,"baseIbc":true,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'INCAPACIDAD_LABORAL', 'Incapacidad laboral (a cargo de la ARL)', null, 'devengo', null, 'VALOR_INCAP_ARL', false, true, false, false, false, false, true, false, false, false, 43, 'peso', true, 'Ley 1562 de 2012', '138025', '250505', null, '{"formula":"VALOR_INCAP_ARL","salarial":false,"baseIbc":true,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'COMPLEMENTO_INCAPACIDAD', 'Complemento de incapacidad (empresa)', null, 'devengo', null, 'VALOR_COMPLEMENTO_INCAP', false, false, false, false, false, false, true, false, false, false, 44, 'peso', false, null, '510506', '250505', null, null) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'LICENCIA_EPS', 'Licencia de maternidad o paternidad', null, 'devengo', null, 'VALOR_LICENCIA_EPS', false, true, false, false, false, false, true, false, false, false, 45, 'peso', true, 'CST art. 236', '138025', '250505', null, '{"formula":"VALOR_LICENCIA_EPS","salarial":false,"baseIbc":true,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'VACACIONES_DISFRUTADAS', 'Vacaciones disfrutadas', null, 'devengo', null, 'VALOR_VACACIONES', true, true, false, true, false, false, true, false, false, false, 50, 'peso', true, 'CST art. 192', '510539', '250505', null, '{"formula":"VALOR_VACACIONES","salarial":true,"baseIbc":true,"baseArl":false,"baseParafiscales":true,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'VACACIONES_COMPENSADAS', 'Vacaciones compensadas en dinero', null, 'devengo', null, 'BASE_VACACIONES / DIAS_MES * CANTIDAD_NOVEDAD', false, false, false, false, false, false, true, false, false, true, 51, 'peso', true, 'CST art. 189', '510539', '250505', null, '{"formula":"BASE_VACACIONES / DIAS_MES * CANTIDAD_NOVEDAD","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'COMISIONES', 'Comisiones', null, 'devengo', null, 'VALOR_NOVEDAD', true, true, true, true, true, true, true, false, false, true, 60, 'peso', false, null, '510512', '250505', null, null) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'BONIFICACION_SALARIAL', 'Bonificación salarial', null, 'devengo', null, 'VALOR_NOVEDAD', true, true, true, true, true, true, true, false, false, true, 61, 'peso', false, null, '510548', '250505', null, null) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'BONIFICACION_NO_SALARIAL', 'Bonificación no salarial', null, 'devengo', null, 'VALOR_NOVEDAD', false, false, false, false, false, false, true, true, false, true, 62, 'peso', false, 'CST art. 128', '510548', '250505', null, null) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'AUXILIO_NO_SALARIAL', 'Auxilio no salarial', null, 'devengo', null, 'VALOR_NOVEDAD', false, false, false, false, false, false, true, true, false, true, 63, 'peso', false, 'CST art. 128', '510551', '250505', null, null) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'RETROACTIVO', 'Retroactivo salarial', null, 'devengo', null, 'VALOR_NOVEDAD', true, true, true, true, true, true, true, false, false, true, 64, 'peso', false, null, '510506', '250505', null, null) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'PRIMA_SERVICIOS', 'Prima de servicios', null, 'devengo', null, 'VALOR_NOVEDAD', false, false, false, false, false, false, true, false, false, true, 70, 'peso', true, 'CST art. 306', '261020', '250505', null, '{"formula":"VALOR_NOVEDAD","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'CESANTIAS', 'Cesantías pagadas al empleado', null, 'devengo', null, 'VALOR_NOVEDAD', false, false, false, false, false, false, false, false, false, true, 71, 'peso', true, 'CST art. 249', '261005', '250505', null, '{"formula":"VALOR_NOVEDAD","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'INTERESES_CESANTIAS', 'Intereses sobre cesantías', null, 'devengo', null, 'VALOR_NOVEDAD', false, false, false, false, false, false, true, false, false, true, 72, 'peso', true, 'Ley 52 de 1975', '261010', '250505', null, '{"formula":"VALOR_NOVEDAD","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":true,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'INDEMNIZACION', 'Indemnización por despido', null, 'devengo', null, 'VALOR_NOVEDAD', false, false, false, false, false, false, false, false, false, true, 73, 'peso', true, 'CST art. 64', '510560', '250505', null, '{"formula":"VALOR_NOVEDAD","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'SALUD_EMPLEADO', 'Salud', null, 'deduccion', 'ley', 'SI(ES_APRENDIZ_LECTIVA; 0; IBC_SALUD * PCT_SALUD_EMPLEADO)', false, false, false, false, false, false, false, false, false, false, 100, 'peso', true, 'Ley 100 de 1993', '250505', '237005', 'eps', '{"formula":"SI(ES_APRENDIZ_LECTIVA; 0; IBC_SALUD * PCT_SALUD_EMPLEADO)","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'PENSION_EMPLEADO', 'Pensión', null, 'deduccion', 'ley', 'SI(O(ES_PENSIONADO; ES_APRENDIZ_LECTIVA); 0; IBC_PENSION * PCT_PENSION_EMPLEADO)', false, false, false, false, false, false, false, false, false, false, 101, 'peso', true, 'Ley 100 de 1993', '250505', '238030', 'afp', '{"formula":"SI(O(ES_PENSIONADO; ES_APRENDIZ_LECTIVA); 0; IBC_PENSION * PCT_PENSION_EMPLEADO)","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'FONDO_SOLIDARIDAD', 'Fondo de Solidaridad Pensional', null, 'deduccion', 'ley', 'SI(O(ES_PENSIONADO; ES_APRENDIZ_LECTIVA); 0; IBC_PENSION * TABLA(''FSP''; IBC_MENSUAL / SMMLV))', false, false, false, false, false, false, false, false, false, false, 102, 'peso', true, 'Ley 100 de 1993 art. 27', '250505', '238030', 'afp', '{"formula":"SI(O(ES_PENSIONADO; ES_APRENDIZ_LECTIVA); 0; IBC_PENSION * TABLA(''FSP''; IBC_MENSUAL / SMMLV))","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'RETENCION_FUENTE', 'Retención en la fuente', null, 'deduccion', 'retencion', 'RETENCION_CALCULADA', false, false, false, false, false, false, false, false, false, false, 110, 'peso', true, 'ET art. 383', '250505', '236505', 'dian', '{"formula":"RETENCION_CALCULADA","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'APORTE_VOLUNTARIO', 'Aporte voluntario a pensión o AFC', null, 'deduccion', 'otra', 'APORTES_VOLUNTARIOS', false, false, false, false, false, false, false, false, false, false, 120, 'peso', false, null, '250505', '238030', 'afp', null) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'DESCUENTO', 'Otros descuentos', null, 'deduccion', 'otra', 'VALOR_NOVEDAD', false, false, false, false, false, false, false, false, false, true, 130, 'peso', false, null, '250505', '238095', null, null) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'SALUD_EMPLEADOR', 'Salud (empleador)', null, 'aporte_empleador', null, 'SI(ES_APRENDIZ_LECTIVA; IBC_SALUD * (PCT_SALUD_EMPLEADOR + PCT_SALUD_EMPLEADO); SI(EXONERADO; 0; IBC_SALUD * PCT_SALUD_EMPLEADOR))', false, false, false, false, false, false, false, false, false, false, 200, 'peso', true, 'Ley 100 de 1993; ET art. 114-1', '510569', '237005', 'eps', '{"formula":"SI(ES_APRENDIZ_LECTIVA; IBC_SALUD * (PCT_SALUD_EMPLEADOR + PCT_SALUD_EMPLEADO); SI(EXONERADO; 0; IBC_SALUD * PCT_SALUD_EMPLEADOR))","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'PENSION_EMPLEADOR', 'Pensión (empleador)', null, 'aporte_empleador', null, 'SI(O(ES_PENSIONADO; ES_APRENDIZ_LECTIVA); 0; IBC_PENSION * PCT_PENSION_EMPLEADOR)', false, false, false, false, false, false, false, false, false, false, 201, 'peso', true, 'Ley 100 de 1993', '510570', '238030', 'afp', '{"formula":"SI(O(ES_PENSIONADO; ES_APRENDIZ_LECTIVA); 0; IBC_PENSION * PCT_PENSION_EMPLEADOR)","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'ARL', 'Riesgos laborales (ARL)', null, 'aporte_empleador', null, 'IBC_ARL * TABLA(''ARL''; CLASE_RIESGO)', false, false, false, false, false, false, false, false, false, false, 202, 'peso', true, 'Decreto 1072 de 2015', '510568', '237006', 'arl', '{"formula":"IBC_ARL * TABLA(''ARL''; CLASE_RIESGO)","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'CAJA_COMPENSACION', 'Caja de compensación', null, 'aporte_empleador', null, 'SI(ES_APRENDIZ_LECTIVA; 0; IBC_PARAFISCALES * PCT_CCF)', false, false, false, false, false, false, false, false, false, false, 203, 'peso', true, 'Ley 21 de 1982', '510572', '237010', 'ccf', '{"formula":"SI(ES_APRENDIZ_LECTIVA; 0; IBC_PARAFISCALES * PCT_CCF)","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'ICBF', 'ICBF', null, 'aporte_empleador', null, 'SI(O(EXONERADO; ES_APRENDIZ_LECTIVA); 0; IBC_PARAFISCALES * PCT_ICBF)', false, false, false, false, false, false, false, false, false, false, 204, 'peso', true, 'Ley 89 de 1988; ET art. 114-1', '510575', '237010', 'icbf', '{"formula":"SI(O(EXONERADO; ES_APRENDIZ_LECTIVA); 0; IBC_PARAFISCALES * PCT_ICBF)","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'SENA', 'SENA', null, 'aporte_empleador', null, 'SI(O(EXONERADO; ES_APRENDIZ_LECTIVA); 0; IBC_PARAFISCALES * PCT_SENA)', false, false, false, false, false, false, false, false, false, false, 205, 'peso', true, 'Ley 21 de 1982; ET art. 114-1', '510578', '237010', 'sena', '{"formula":"SI(O(EXONERADO; ES_APRENDIZ_LECTIVA); 0; IBC_PARAFISCALES * PCT_SENA)","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'PROV_CESANTIAS', 'Provisión de cesantías', null, 'provision', null, 'BASE_PRESTACIONES * PCT_PROV_CESANTIAS', false, false, false, false, false, false, false, false, false, false, 300, 'peso', true, 'CST art. 249', '510530', '261005', 'cesantias', '{"formula":"BASE_PRESTACIONES * PCT_PROV_CESANTIAS","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'PROV_INTERESES', 'Provisión de intereses sobre cesantías', null, 'provision', null, 'PROV_CESANTIAS * PCT_INTERESES_CESANTIAS', false, false, false, false, false, false, false, false, false, false, 301, 'peso', true, 'Ley 52 de 1975', '510533', '261010', null, '{"formula":"PROV_CESANTIAS * PCT_INTERESES_CESANTIAS","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'PROV_PRIMA', 'Provisión de prima de servicios', null, 'provision', null, 'BASE_PRESTACIONES * PCT_PROV_PRIMA', false, false, false, false, false, false, false, false, false, false, 302, 'peso', true, 'CST art. 306', '510536', '261020', null, '{"formula":"BASE_PRESTACIONES * PCT_PROV_PRIMA","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into conceptos (empresa_id, codigo, nombre, descripcion, tipo, categoria, formula, salarial, base_ibc, base_arl, base_parafiscales, base_prestaciones, base_vacaciones, base_retencion, cuenta40, por_horas, requiere_novedad, orden, redondeo, es_legal, base_legal, cuenta_debito, cuenta_credito, tercero_credito, definicion_legal) values ('00000000-0000-4000-8000-000000000001', 'PROV_VACACIONES', 'Provisión de vacaciones', null, 'provision', null, 'BASE_VACACIONES_PROV * PCT_PROV_VACACIONES', false, false, false, false, false, false, false, false, false, false, 303, 'peso', true, 'CST art. 186', '510539', '261015', null, '{"formula":"BASE_VACACIONES_PROV * PCT_PROV_VACACIONES","salarial":false,"baseIbc":false,"baseArl":false,"baseParafiscales":false,"basePrestaciones":false,"baseVacaciones":false,"baseRetencion":false,"cuenta40":false}'::jsonb) on conflict (empresa_id, codigo) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-01-01', 'Año Nuevo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-01-06', 'Día de los Reyes Magos') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-03-24', 'Día de San José') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-04-17', 'Jueves Santo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-04-18', 'Viernes Santo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-05-01', 'Día del Trabajo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-06-02', 'Ascensión del Señor') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-06-23', 'Corpus Christi') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-06-30', 'San Pedro y San Pablo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-06-30', 'Sagrado Corazón de Jesús') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-07-20', 'Día de la Independencia') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-08-07', 'Batalla de Boyacá') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-08-18', 'Asunción de la Virgen') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-10-13', 'Día de la Raza') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-11-03', 'Todos los Santos') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-11-17', 'Independencia de Cartagena') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-12-08', 'Inmaculada Concepción') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2025-12-25', 'Navidad') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-01-01', 'Año Nuevo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-01-12', 'Día de los Reyes Magos') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-03-23', 'Día de San José') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-04-02', 'Jueves Santo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-04-03', 'Viernes Santo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-05-01', 'Día del Trabajo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-05-18', 'Ascensión del Señor') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-06-08', 'Corpus Christi') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-06-15', 'Sagrado Corazón de Jesús') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-06-29', 'San Pedro y San Pablo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-07-20', 'Día de la Independencia') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-08-07', 'Batalla de Boyacá') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-08-17', 'Asunción de la Virgen') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-10-12', 'Día de la Raza') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-11-02', 'Todos los Santos') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-11-16', 'Independencia de Cartagena') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-12-08', 'Inmaculada Concepción') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2026-12-25', 'Navidad') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-01-01', 'Año Nuevo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-01-11', 'Día de los Reyes Magos') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-03-22', 'Día de San José') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-03-25', 'Jueves Santo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-03-26', 'Viernes Santo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-05-01', 'Día del Trabajo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-05-10', 'Ascensión del Señor') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-05-31', 'Corpus Christi') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-06-07', 'Sagrado Corazón de Jesús') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-07-05', 'San Pedro y San Pablo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-07-20', 'Día de la Independencia') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-08-07', 'Batalla de Boyacá') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-08-16', 'Asunción de la Virgen') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-10-18', 'Día de la Raza') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-11-01', 'Todos los Santos') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-11-15', 'Independencia de Cartagena') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-12-08', 'Inmaculada Concepción') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2027-12-25', 'Navidad') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-01-01', 'Año Nuevo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-01-10', 'Día de los Reyes Magos') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-03-20', 'Día de San José') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-04-13', 'Jueves Santo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-04-14', 'Viernes Santo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-05-01', 'Día del Trabajo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-05-29', 'Ascensión del Señor') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-06-19', 'Corpus Christi') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-06-26', 'Sagrado Corazón de Jesús') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-07-03', 'San Pedro y San Pablo') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-07-20', 'Día de la Independencia') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-08-07', 'Batalla de Boyacá') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-08-21', 'Asunción de la Virgen') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-10-16', 'Día de la Raza') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-11-06', 'Todos los Santos') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-11-13', 'Independencia de Cartagena') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-12-08', 'Inmaculada Concepción') on conflict (empresa_id, fecha) do nothing;
insert into festivos (empresa_id, fecha, nombre) values ('00000000-0000-4000-8000-000000000001', '2028-12-25', 'Navidad') on conflict (empresa_id, fecha) do nothing;
insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values ('00000000-0000-4000-8000-000000000001', 'banco', 'BANCOLOMBIA', 'Bancolombia - pago masivo de nómina', '{"codigo":"BANCOLOMBIA","nombre":"Bancolombia - pago masivo de nómina","separador":null,"extension":"txt","nota":"Plantilla base. Antes de usarla en producción, valídela contra la especificación oficial de archivos de pago que entrega el banco a la empresa y ajuste los campos desde el panel.","encabezado":[{"nombre":"Tipo registro","literal":"1","ancho":1},{"nombre":"NIT pagador","fuente":"empresa.nit","ancho":15,"alineacion":"derecha","relleno":"0"},{"nombre":"Aplicación","literal":"I","ancho":1},{"nombre":"Filler","literal":"","ancho":15},{"nombre":"Clase transacción","literal":"225","ancho":3},{"nombre":"Descripción","literal":"NOMINA","ancho":10},{"nombre":"Fecha transmisión","fuente":"fechaPago","formato":"fecha_aaaammdd","ancho":8},{"nombre":"Secuencia","literal":"A","ancho":2},{"nombre":"Fecha aplicación","fuente":"fechaPago","formato":"fecha_aaaammdd","ancho":8},{"nombre":"Número registros","fuente":"total.registros","formato":"entero","ancho":6,"alineacion":"derecha","relleno":"0"},{"nombre":"Débitos","literal":"0","ancho":17,"alineacion":"derecha","relleno":"0"},{"nombre":"Créditos","fuente":"total.valor","formato":"valor_centavos","ancho":17,"alineacion":"derecha","relleno":"0"},{"nombre":"Cuenta débito","fuente":"empresa.cuenta","ancho":11,"alineacion":"derecha","relleno":"0"},{"nombre":"Tipo cuenta débito","fuente":"empresa.tipoCuentaCodigo","ancho":1}],"detalle":[{"nombre":"Tipo registro","literal":"6","ancho":1},{"nombre":"Documento beneficiario","fuente":"empleado.documento","ancho":15,"alineacion":"derecha","relleno":"0"},{"nombre":"Nombre beneficiario","fuente":"empleado.nombre","ancho":30},{"nombre":"Banco destino","fuente":"empleado.codigoBanco","ancho":9,"alineacion":"derecha","relleno":"0"},{"nombre":"Cuenta destino","fuente":"empleado.cuenta","ancho":17,"alineacion":"derecha","relleno":"0"},{"nombre":"Indicador","literal":"S","ancho":1},{"nombre":"Tipo transacción","fuente":"empleado.tipoTransaccion","ancho":2},{"nombre":"Valor","fuente":"pago.valor","formato":"valor_centavos","ancho":17,"alineacion":"derecha","relleno":"0"},{"nombre":"Fecha","fuente":"fechaPago","formato":"fecha_aaaammdd","ancho":8},{"nombre":"Referencia","fuente":"pago.referencia","ancho":21}]}'::jsonb) on conflict (empresa_id, clase, codigo) do nothing;
insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values ('00000000-0000-4000-8000-000000000001', 'banco', 'DAVIVIENDA', 'Davivienda - pago masivo de nómina', '{"codigo":"DAVIVIENDA","nombre":"Davivienda - pago masivo de nómina","separador":null,"extension":"txt","nota":"Plantilla base. Antes de usarla en producción, valídela contra la especificación oficial de archivos de pago que entrega el banco a la empresa y ajuste los campos desde el panel.","encabezado":[{"nombre":"Tipo registro","literal":"RC","ancho":2},{"nombre":"NIT empresa","fuente":"empresa.nit","ancho":16,"alineacion":"derecha","relleno":"0"},{"nombre":"Código servicio","literal":"NOMI","ancho":4},{"nombre":"Cuenta empresa","fuente":"empresa.cuenta","ancho":16,"alineacion":"derecha","relleno":"0"},{"nombre":"Tipo cuenta","fuente":"empresa.tipoCuentaCodigo","ancho":2},{"nombre":"Fecha","fuente":"fechaPago","formato":"fecha_aaaammdd","ancho":8},{"nombre":"Valor total","fuente":"total.valor","formato":"valor_centavos","ancho":18,"alineacion":"derecha","relleno":"0"},{"nombre":"Registros","fuente":"total.registros","formato":"entero","ancho":6,"alineacion":"derecha","relleno":"0"}],"detalle":[{"nombre":"Tipo registro","literal":"TR","ancho":2},{"nombre":"Documento","fuente":"empleado.documento","ancho":16,"alineacion":"derecha","relleno":"0"},{"nombre":"Tipo documento","fuente":"empleado.tipoDocumentoCodigo","ancho":2},{"nombre":"Cuenta","fuente":"empleado.cuenta","ancho":16,"alineacion":"derecha","relleno":"0"},{"nombre":"Tipo cuenta","fuente":"empleado.tipoCuentaCodigo","ancho":2},{"nombre":"Banco","fuente":"empleado.codigoBanco","ancho":6,"alineacion":"derecha","relleno":"0"},{"nombre":"Valor","fuente":"pago.valor","formato":"valor_centavos","ancho":18,"alineacion":"derecha","relleno":"0"},{"nombre":"Nombre","fuente":"empleado.nombre","ancho":40}]}'::jsonb) on conflict (empresa_id, clase, codigo) do nothing;
insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values ('00000000-0000-4000-8000-000000000001', 'banco', 'BANCO_BOGOTA', 'Banco de Bogotá - pago masivo de nómina', '{"codigo":"BANCO_BOGOTA","nombre":"Banco de Bogotá - pago masivo de nómina","separador":null,"extension":"txt","nota":"Plantilla base. Antes de usarla en producción, valídela contra la especificación oficial de archivos de pago que entrega el banco a la empresa y ajuste los campos desde el panel.","encabezado":[{"nombre":"Tipo registro","literal":"1","ancho":1},{"nombre":"Fecha","fuente":"fechaPago","formato":"fecha_aaaammdd","ancho":8},{"nombre":"Valor total","fuente":"total.valor","formato":"valor_centavos","ancho":18,"alineacion":"derecha","relleno":"0"},{"nombre":"Tipo cuenta","fuente":"empresa.tipoCuentaCodigo","ancho":2},{"nombre":"Cuenta","fuente":"empresa.cuenta","ancho":17,"alineacion":"derecha","relleno":"0"},{"nombre":"Nombre empresa","fuente":"empresa.razonSocial","ancho":40},{"nombre":"NIT","fuente":"empresa.nit","ancho":11,"alineacion":"derecha","relleno":"0"},{"nombre":"Código transacción","literal":"021","ancho":3}],"detalle":[{"nombre":"Tipo registro","literal":"2","ancho":1},{"nombre":"Tipo documento","fuente":"empleado.tipoDocumentoCodigo","ancho":1},{"nombre":"Documento","fuente":"empleado.documento","ancho":11,"alineacion":"derecha","relleno":"0"},{"nombre":"Nombre","fuente":"empleado.nombre","ancho":40},{"nombre":"Tipo cuenta","fuente":"empleado.tipoCuentaCodigo","ancho":2},{"nombre":"Cuenta","fuente":"empleado.cuenta","ancho":17,"alineacion":"derecha","relleno":"0"},{"nombre":"Valor","fuente":"pago.valor","formato":"valor_centavos","ancho":18,"alineacion":"derecha","relleno":"0"},{"nombre":"Banco","fuente":"empleado.codigoBanco","ancho":3,"alineacion":"derecha","relleno":"0"}]}'::jsonb) on conflict (empresa_id, clase, codigo) do nothing;
insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values ('00000000-0000-4000-8000-000000000001', 'banco', 'CSV_GENERICO', 'Archivo de pago genérico (CSV)', '{"codigo":"CSV_GENERICO","nombre":"Archivo de pago genérico (CSV)","separador":";","extension":"csv","incluirTitulos":true,"detalle":[{"nombre":"Documento","fuente":"empleado.documento"},{"nombre":"Nombre","fuente":"empleado.nombre"},{"nombre":"Banco","fuente":"empleado.banco"},{"nombre":"Tipo de cuenta","fuente":"empleado.tipoCuenta"},{"nombre":"Cuenta","fuente":"empleado.cuenta"},{"nombre":"Valor","fuente":"pago.valor","formato":"valor"},{"nombre":"Fecha de pago","fuente":"fechaPago","formato":"fecha_iso"}]}'::jsonb) on conflict (empresa_id, clase, codigo) do nothing;
insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values ('00000000-0000-4000-8000-000000000001', 'contable', 'CONTABLE_GENERICO', 'Comprobante contable genérico (CSV)', '{"codigo":"CONTABLE_GENERICO","nombre":"Comprobante contable genérico (CSV)","separador":";","extension":"csv","incluirTitulos":true,"detalle":[{"nombre":"Fecha","fuente":"fecha","formato":"fecha_iso"},{"nombre":"Comprobante","fuente":"comprobante"},{"nombre":"Cuenta","fuente":"cuenta"},{"nombre":"NIT tercero","fuente":"tercero.nit"},{"nombre":"Nombre tercero","fuente":"tercero.nombre"},{"nombre":"Centro de costo","fuente":"centroCosto"},{"nombre":"Descripción","fuente":"descripcion"},{"nombre":"Débito","fuente":"debito","formato":"valor"},{"nombre":"Crédito","fuente":"credito","formato":"valor"}]}'::jsonb) on conflict (empresa_id, clase, codigo) do nothing;
insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values ('00000000-0000-4000-8000-000000000001', 'contable', 'SIIGO', 'Siigo - importación de movimientos', '{"codigo":"SIIGO","nombre":"Siigo - importación de movimientos","separador":",","extension":"csv","incluirTitulos":true,"nota":"Plantilla base de importación. Verifique el orden de columnas con la plantilla que exporta su programa contable y ajústela desde el panel.","detalle":[{"nombre":"Tipo de comprobante","literal":"NOMINA"},{"nombre":"Consecutivo","fuente":"comprobante"},{"nombre":"Fecha de elaboración","fuente":"fecha","formato":"fecha_ddmmaaaa"},{"nombre":"Código cuenta contable","fuente":"cuenta"},{"nombre":"Identificación tercero","fuente":"tercero.nit"},{"nombre":"Centro de costo","fuente":"centroCosto"},{"nombre":"Descripción","fuente":"descripcion"},{"nombre":"Débito","fuente":"debito","formato":"valor"},{"nombre":"Crédito","fuente":"credito","formato":"valor"}]}'::jsonb) on conflict (empresa_id, clase, codigo) do nothing;
insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values ('00000000-0000-4000-8000-000000000001', 'contable', 'WORLD_OFFICE', 'World Office - importación de movimientos', '{"codigo":"WORLD_OFFICE","nombre":"World Office - importación de movimientos","separador":";","extension":"csv","incluirTitulos":true,"nota":"Plantilla base de importación. Verifique el orden de columnas con la plantilla que exporta su programa contable y ajústela desde el panel.","detalle":[{"nombre":"Fecha","fuente":"fecha","formato":"fecha_ddmmaaaa"},{"nombre":"Documento","fuente":"comprobante"},{"nombre":"Cuenta","fuente":"cuenta"},{"nombre":"Tercero","fuente":"tercero.nit"},{"nombre":"Nota","fuente":"descripcion"},{"nombre":"Centro de costos","fuente":"centroCosto"},{"nombre":"Débito","fuente":"debito","formato":"valor"},{"nombre":"Crédito","fuente":"credito","formato":"valor"}]}'::jsonb) on conflict (empresa_id, clase, codigo) do nothing;
insert into formatos_archivo (empresa_id, clase, codigo, nombre, definicion) values ('00000000-0000-4000-8000-000000000001', 'contable', 'HELISA', 'Helisa - importación de movimientos', '{"codigo":"HELISA","nombre":"Helisa - importación de movimientos","separador":"\t","extension":"txt","nota":"Plantilla base de importación. Verifique el orden de columnas con la plantilla que exporta su programa contable y ajústela desde el panel.","detalle":[{"nombre":"Cuenta","fuente":"cuenta"},{"nombre":"Tercero","fuente":"tercero.nit"},{"nombre":"Centro de costo","fuente":"centroCosto"},{"nombre":"Fecha","fuente":"fecha","formato":"fecha_aaaammdd"},{"nombre":"Descripción","fuente":"descripcion"},{"nombre":"Débito","fuente":"debito","formato":"valor"},{"nombre":"Crédito","fuente":"credito","formato":"valor"}]}'::jsonb) on conflict (empresa_id, clase, codigo) do nothing;
commit;
