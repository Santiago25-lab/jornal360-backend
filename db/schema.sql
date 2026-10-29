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

-- Varias empresas: cada una entra por su espacio (jornal360…/<espacio>) y el usuario es único dentro de su espacio.
alter table empresas add column if not exists espacio text;
create unique index if not exists empresas_espacio_uq on empresas (lower(espacio));
drop index if exists usuarios_usuario_uq;
create unique index if not exists usuarios_empresa_usuario_uq on usuarios (empresa_id, lower(usuario));

-- Administradores de la plataforma: están por encima de todas las empresas.
create table if not exists administradores_plataforma (
  id uuid primary key default gen_random_uuid(),
  usuario text not null,
  nombre text not null,
  password_hash text not null,
  activo boolean not null default true,
  intentos_fallidos int not null default 0,
  bloqueado_hasta timestamptz,
  ultimo_acceso timestamptz,
  creado_en timestamptz not null default now()
);
create unique index if not exists administradores_plataforma_usuario_uq on administradores_plataforma (lower(usuario));

-- ---------- Seguridad: Supabase expone las tablas por su API pública.
-- Se activa RLS sin políticas para que solo el backend (conexión directa) las use.
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end $$;
